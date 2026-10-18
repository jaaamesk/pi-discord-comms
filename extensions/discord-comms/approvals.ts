import { isAbsolute, relative, resolve } from "node:path";
import type { Config } from "./config.ts";
import type { DiscordRest } from "./rest.ts";
import { ButtonStyle, COLORS, clip, fence, type ActionRow, type Interaction } from "./types.ts";

export type Decision = "allow" | "always" | "deny" | "timeout";
export type Outcome = { decision: Decision; source: "discord" | "terminal" | "timeout" };

// Shell patterns that mean "this could cost you something you cannot get back".
const BASH_RULES: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\b|--recursive\b)/i, why: "force/recursive delete" },
  { re: /\b(sudo|doas)\b/i, why: "privilege escalation" },
  { re: /\b(chmod|chown)\b[^\n]*\b7[0-7]{2,3}\b/i, why: "world-writable permissions" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, why: "raw device write" },
  { re: /\b(mkfs|shutdown|reboot|halt|poweroff)\b/i, why: "system or filesystem teardown" },
  { re: /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|(?:^|\s)-f(?:\s|$))/i, why: "force push" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, why: "discarding uncommitted work" },
  { re: /(curl|wget)[^\n]*\|\s*(sudo\s+)?(?:ba|z)?sh\b/i, why: "piping a remote script into a shell" },
  { re: /\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, why: "publishing to a public registry" },
  { re: /\b(kubectl\s+delete|docker\s+(rm|rmi|system\s+prune))\b/i, why: "container/orchestrator teardown" },
  { re: /\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE|DELETE\s+FROM(?![^;]*\bWHERE\b))/i, why: "destructive SQL" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, why: "fork bomb" },
];

const SENSITIVE: { re: RegExp; why: string }[] = [
  { re: /(^|\/)\.env(\.|$)/, why: "env/secret file" },
  { re: /\.(pem|key|p12|pfx)$/i, why: "key material" },
  { re: /(^|\/)(id_rsa|id_ed25519)$/, why: "ssh private key" },
  { re: /(^|\/)\.ssh\//, why: "ssh directory" },
  { re: /(^|\/)\.aws\//, why: "aws credentials" },
  { re: /(^|\/)(credentials|secrets)\.(json|ya?ml|toml)$/i, why: "credentials file" },
];

const BUILTIN = new Set(["bash", "powershell", "read", "write", "edit", "grep", "find", "ls"]);

type Annotations = { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };

/** Why this call is dangerous, or undefined when it can run unattended. */
export function riskReason(
  level: Config["approvals"],
  call: { toolName: string; input: Record<string, unknown>; cwd: string; annotations?: Annotations },
): string | undefined {
  if (level === "off") return undefined;
  if (level === "all") return "every tool call is gated (approvals: \"all\")";

  const { toolName, input, cwd } = call;
  if (toolName === "bash" || toolName === "powershell") {
    const command = String(input.command ?? "");
    for (const rule of BASH_RULES) if (rule.re.test(command)) return rule.why;
    return undefined;
  }
  if (toolName === "write" || toolName === "edit") {
    const p = String(input.path ?? "");
    if (!p) return undefined;
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    const rel = relative(cwd, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return `writes outside the project (${abs})`;
    for (const rule of SENSITIVE) if (rule.re.test(abs)) return `sensitive file (${abs})`;
    return undefined;
  }
  // Pi's own tools declare no annotations, so this only catches third-party/MCP tools
  // that have opted into destructiveHint.
  if (!BUILTIN.has(toolName) && call.annotations?.destructiveHint === true) return "tool declares itself destructive";
  return undefined;
}

const DECISION_LABEL: Record<Decision, string> = {
  allow: "✅ Allowed once",
  always: "✅ Allowed for the rest of this session",
  deny: "⛔ Denied",
  timeout: "⏱ No answer in time — blocked",
};

/**
 * Blocking approval prompt rendered on both surfaces at once. Pi's confirm dialog takes
 * an AbortSignal, so a Discord click can dismiss the terminal dialog, and answering at
 * the keyboard rewrites the Discord embed. Whichever answers first wins.
 */
export class ApprovalBroker {
  private always = false;
  private requests = new Map<string, { settle: (d: Decision) => void; toolName: string; input: Record<string, unknown>; rows: ActionRow[] }>();

  private readonly rest: DiscordRest;
  private readonly cfg: Config;
  private readonly tag: string;
  private readonly channel: () => string | undefined;

  constructor(rest: DiscordRest, cfg: Config, tag: string, channel: () => string | undefined) {
    this.rest = rest;
    this.cfg = cfg;
    this.tag = tag;
    this.channel = channel;
  }

  get allowingEverything(): boolean {
    return this.always;
  }

  get pendingCount(): number {
    return this.requests.size;
  }

  async request(ctx: { hasUI: boolean; ui: { confirm(t: string, m: string, o?: { signal?: AbortSignal }): Promise<boolean> } }, toolName: string, input: Record<string, unknown>, reason: string): Promise<Outcome> {
    const id = Math.random().toString(36).slice(2, 8);
    const customId = (action: string) => `pi:${action}:${this.tag}:${id}`;
    const excerpt = fence(String(input.command ?? input.path ?? JSON.stringify(input)), 1024);
    const rows: ActionRow[] = [
      {
        type: 1,
        components: [
          { type: 2, style: ButtonStyle.Success, label: "Allow once", custom_id: customId("approve") },
          { type: 2, style: ButtonStyle.Primary, label: "Always", custom_id: customId("always") },
          { type: 2, style: ButtonStyle.Danger, label: "Deny", custom_id: customId("deny") },
          { type: 2, style: ButtonStyle.Secondary, label: "Detail", custom_id: customId("detail") },
        ],
      },
    ];
    const embedFor = (title: string) => ({
      title: `⚠️ ${toolName} — ${reason}`,
      description: `${excerpt}\n\n${title}`,
      color: decisionColor(title),
      fields: [{ name: "why", value: clip(reason, 1024) }],
      timestamp: new Date().toISOString(),
    });

    const channel = this.channel();
    let messageId: string | undefined;
    if (channel) {
      try {
        messageId = (await this.rest.send(channel, { embeds: [embedFor("Awaiting your decision.")], components: rows })).id;
      } catch {}
    }

    return new Promise<Outcome>((done) => {
      let settled = false;
      const ctl = new AbortController();
      const finish = (decision: Decision, source: Outcome["source"]) => {
        if (settled) return;
        settled = true;
        this.requests.delete(id);
        clearTimeout(timer);
        ctl.abort();
        if (decision === "always") this.always = true;
        if (channel && messageId) void this.rest.edit(channel, messageId, { embeds: [embedFor(DECISION_LABEL[decision])], components: disabledRows(rows) }).catch(() => {});
        done({ decision, source });
      };
      const timer = setTimeout(() => finish("timeout", "timeout"), this.cfg.approvalTimeoutMs);
      this.requests.set(id, { settle: (d) => finish(d, "discord"), toolName, input, rows });
      if (ctx.hasUI && this.cfg.raceTerminal) {
        void ctx.ui
          .confirm(`⚠️ ${toolName} — ${reason}`, `${excerpt}\n\nAllow this call?`, { signal: ctl.signal })
          .then((yes) => finish(yes ? "allow" : "deny", "terminal"))
          .catch(() => {});
      }
    });
  }

  /** Route a button click. Returns false when the request is already gone. */
  handle(interaction: Interaction): { kind: "decision" | "detail" | "unknown"; decision?: Decision } {
    const customId = interaction.data?.custom_id ?? "";
    const [app, action, tag, id] = customId.split(":");
    if (app !== "pi" || tag !== this.tag) return { kind: "unknown" };
    const request = this.requests.get(id);
    if (!request) return { kind: "unknown" };
    if (action === "detail") return { kind: "detail" };
    const decision: Decision | undefined = action === "approve" ? "allow" : action === "always" ? "always" : action === "deny" ? "deny" : undefined;
    if (!decision) return { kind: "unknown" };
    request.settle(decision);
    return { kind: "decision", decision };
  }

  detailFor(interaction: Interaction): string | undefined {
    const id = (interaction.data?.custom_id ?? "").split(":")[3];
    const request = this.requests.get(id);
    if (!request) return undefined;
    return fence(JSON.stringify(request.input, null, 2), 2000);
  }
}

const decisionColor = (title: string): number =>
  title.startsWith("⛔") || title.startsWith("⏱") ? COLORS.danger : title.startsWith("✅") ? COLORS.success : COLORS.warning;

const disabledRows = (rows: ActionRow[]): ActionRow[] =>
  rows.map((row) => ({ ...row, components: row.components.map((b) => ({ ...b, disabled: true })) }));

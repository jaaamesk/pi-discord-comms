import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claimLock, releaseLock } from "./lock.ts";
import { connectGateway, Intents, type Gateway, type GatewayState } from "./gateway.ts";
import { DiscordRest } from "./rest.ts";
import { CONFIG_PATH, loadConfig, missingConfig } from "./config.ts";
import { ApprovalBroker, riskReason } from "./approvals.ts";
import { questionMirror } from "./ask-mirror.ts";
import { COLORS, clip, fence, type DiscordMessage, type Embed, type Interaction, type MessagePayload } from "./types.ts";

// Pi session -> Discord channel, two ways round:
//   outbound  run settled / blocked prompt / approval request
//   inbound   your text becomes a user message, !stop aborts the run, buttons answer approvals
// One interactive Pi process holds the connection; see lock.ts for who wins.

const tag = Math.random().toString(16).slice(2, 6);
const project = () => process.cwd().split("/").filter(Boolean).pop() ?? process.cwd();
const ICON = { info: "🔵", done: "✅", waiting: "⏸", error: "⚠️", abort: "🛑" } as const;

export default function discordComms(pi: ExtensionAPI) {
  const cfg = loadConfig();

  let ctx0: ExtensionContext | undefined;
  let gw: Gateway | undefined;
  let rest: DiscordRest | undefined;
  let broker: ApprovalBroker | undefined;
  let channelId: string | undefined;
  let dormant: string | undefined;
  let lastState: GatewayState = "idle";
  let lastDetail = "";
  // Set while an ask-style prompt owned by another extension is mirrored here, so the
  // generic (and contentless) "waiting at a custom" ping does not arrive as well.
  let mirroredCallId: string | undefined;

  const renderStatus = () => {
    if (!ctx0?.hasUI) return;
    ctx0.ui.setStatus(
      "discord",
      dormant
        ? `○ discord · ${dormant}`
        : `● discord · #${channelId ?? "…"} · ${tag} · ${lastState === "ready" ? "connected" : lastState}${lastDetail ? ` (${lastDetail})` : ""}`,
    );
  };

  const send = async (payload: MessagePayload): Promise<boolean> => {
    if (!rest || !channelId) return false;
    try {
      await rest.send(channelId, payload);
      return true;
    } catch (err) {
      // A failed notification must never take a run down with it.
      ctx0?.ui.notify(`discord: send failed — ${(err as Error).message}`, "warning");
      return false;
    }
  };

  const embedFor = (title: string, description: string, color: number, fields?: Embed["fields"]): Embed => ({
    title,
    description: clip(description || "—", 4096),
    color,
    fields,
    footer: { text: `${tag} · ${project()} · ${ctx0?.model?.id ?? "model"}` },
    timestamp: new Date().toISOString(),
  });

  const ping = (title: string, description: string, color: number = COLORS.info) =>
    send({ embeds: [embedFor(title, description, color)] });

  const lastAssistantText = (): string => {
    const branch = ctx0?.sessionManager.getBranch() ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const text = (entry.message.content as { type: string; text?: string }[])
        .filter((c) => c.type === "text" && c.text?.trim())
        .map((c) => c.text!.trim())
        .join("\n\n");
      if (text) return text;
    }
    return "";
  };

  const resolveChannel = async () => {
    if (!rest || !cfg.userId) return;
    if (cfg.channelId && cfg.channelId !== "dm") {
      channelId = cfg.channelId;
      return;
    }
    // DM fallback: needs the bot to share a guild with you, which the invite already did.
    try {
      channelId = (await rest.openDm(cfg.userId)).id;
    } catch (err) {
      ctx0?.ui.notify(`discord: could not open a DM — ${(err as Error).message}`, "error");
    }
  };

  const statusEmbed = (): MessagePayload => ({
    embeds: [
      embedFor(
        `${ICON.info} pi-discord-comms`,
        [
          `state: ${lastState}${lastDetail ? ` (${lastDetail})` : ""}`,
          `channel: ${channelId ?? "unresolved"} · tag ${tag}`,
          `level: ${cfg.level} · approvals: ${cfg.approvals}${broker?.allowingEverything ? " (allowed everything this session)" : ""}`,
          `approvals pending: ${broker?.pendingCount ?? 0} · raceTerminal: ${cfg.raceTerminal}`,
          `agent busy: ${ctx0 ? !ctx0.isIdle() : "unknown"}`,
        ].join("\n"),
        COLORS.info,
      ),
    ],
  });

  // ---- inbound ---------------------------------------------------------------

  const onDiscordMessage = async (message: DiscordMessage) => {
    const channel = channelId;
    if (!channel || message.channel_id !== channel) return;
    // Only the configured human may drive the agent. Channel-level permissions are the
    // second line of defence, but never the only one.
    if (message.author.bot || message.author.id !== cfg.userId) return;
    const text = (message.content ?? "").trim();
    if (!text) return;
    const ctx = ctx0;
    const verb = text.split(/\s+/)[0].toLowerCase();

    if (verb === "!stop") {
      ctx?.abort();
      await rest?.react(channel, message.id, ICON.abort).catch(() => {});
      return;
    }
    if (verb === "!status") {
      await send(statusEmbed());
      await rest?.react(channel, message.id, "👀").catch(() => {});
      return;
    }
    if (verb.startsWith("!")) {
      await rest?.react(channel, message.id, "❓").catch(() => {});
      return;
    }
    if (!ctx) return;
    try {
      // Idle: a normal turn. Streaming: queued so the run is not torn up mid-flight.
      if (ctx.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: cfg.deliverAs });
    } catch (err) {
      ctx.ui.notify(`discord: could not deliver inbound message — ${(err as Error).message}`, "warning");
      return;
    }
    await rest?.react(channel, message.id, "👀").catch(() => {});
    ctx.ui.notify(`discord: inbound message delivered to the agent`, "info");
  };

  const onInteraction = async (interaction: Interaction) => {
    if (interaction.type !== 2 || !rest || !broker) return; // 2 = message component
    const who = interaction.member?.user?.id ?? interaction.user?.id;
    try {
      // Component interactions expire in 3 s; a type 6 ack clears that while the tool
      // call keeps waiting for the decision.
      await rest.interactionAck(interaction);
    } catch {}
    if (who !== cfg.userId) {
      await rest
        .interactionFollowup(interaction, { content: "pi-discord-comms only listens to its configured user.", flags: 64 })
        .catch(() => {});
      return;
    }
    const outcome = broker.handle(interaction);
    if (outcome.kind === "detail") {
      const body = broker.detailFor(interaction) ?? "Already answered.";
      await rest.interactionFollowup(interaction, { content: clip(body, 2000) }).catch(() => {});
    } else if (outcome.kind === "unknown") {
      await rest.interactionFollowup(interaction, { content: "That request is already answered.", flags: 64 }).catch(() => {});
    }
  };

  const connect = () => {
    const problem = missingConfig(cfg);
    if (problem) {
      dormant = problem;
      return;
    }
    const lock = claimLock(tag);
    if (!lock.ok) {
      dormant = `held by pid ${lock.owner.pid} (${lock.owner.cwd})`;
      return;
    }
    dormant = undefined;
    rest = new DiscordRest(cfg.token!);
    broker = new ApprovalBroker(rest, cfg, tag, () => channelId);
    gw = connectGateway({
      token: cfg.token!,
      intents: Intents.Guilds | Intents.GuildMessages | Intents.MessageContent,
      onEvent: (type, data) => {
        if (type === "MESSAGE_CREATE") void onDiscordMessage(data as DiscordMessage).catch(() => {});
        else if (type === "INTERACTION_CREATE") void onInteraction(data as Interaction).catch(() => {});
      },
      onState: (state, detail) => {
        lastState = state;
        lastDetail = detail;
        if (state === "ready") void resolveChannel().then(renderStatus);
        else renderStatus();
      },
    });
  };

  const disconnect = () => {
    gw?.close();
    gw = undefined;
    rest = undefined;
    broker = undefined;
    channelId = undefined;
    releaseLock();
  };

  pi.registerCommand("discord", {
    description: "Discord session channel: /discord status|test|connect|disconnect|level",
    handler: async (args, ctx) => {
      ctx0 = ctx;
      const [action = "status", arg] = args.trim().split(/\s+/);
      if (action === "connect" && !gw) connect();
      else if (action === "disconnect") disconnect();
      else if (action === "level" && arg) {
        cfg.level = arg as typeof cfg.level;
        ctx.ui.notify(`discord: level=${cfg.level} (this session only)`, "info");
      } else if (action === "test") {
        if (!channelId) await resolveChannel();
        const ok = await ping(`${ICON.info} Pi test · ${project()}`, `session tag ${tag} · state ${lastState}`);
        if (ok) ctx.ui.notify(`discord: sent test embed to #${channelId}`, "info");
      } else if (action === "risk") {
        // Dry-run the approval policy on a pasted command: nothing executes.
        const command = args.slice(action.length).trim();
        const reason = riskReason(cfg.approvals, { toolName: "bash", input: { command }, cwd: ctx.cwd });
        ctx.ui.notify(reason ? `discord: would gate "${command}" — ${reason}` : `discord: would allow "${command}"`, "info");
      } else {
        ctx.ui.notify(
          dormant
            ? `discord: dormant — ${dormant}`
            : `discord: ${lastState}${lastDetail ? ` (${lastDetail})` : ""} · #${channelId ?? "unresolved"} · tag ${tag} · level ${cfg.level} · approvals ${cfg.approvals}`,
          "info",
        );
      }
      renderStatus();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctx0 = ctx;
    // Headless and RPC-mode Pi (including spawned subagent children) must not fight the
    // interactive session for the single gateway connection.
    if (ctx.mode !== "tui") dormant = dormant ?? "not an interactive session";
    else connect();
    renderStatus();
    if (dormant) ctx.ui.notify(`discord: dormant — ${dormant}`, "info");
    else ctx.ui.notify("discord: connecting…", "info");
  });

  pi.on("agent_start", (_event, ctx) => {
    ctx0 = ctx;
    if (cfg.level !== "verbose" || !channelId) return;
    ping("▶ run started", `model ${ctx.model?.id ?? "?"} · cwd ${ctx.cwd}`);
  });

  pi.on("agent_settled", (event, ctx) => {
    ctx0 = ctx;
    if (cfg.level === "quiet" || !channelId) return;
    const icon = event.aborted ? ICON.abort : ICON.done;
    ping(`${icon} ${event.aborted ? "Run stopped" : "Done — waiting for input"}`, lastAssistantText());
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    ctx0 = ctx;
    if (cfg.level === "quiet" || !channelId || mirroredCallId) return;
    ping(`${ICON.waiting} Pi is waiting at a ${event.kind}`, event.title ?? "(no title)", COLORS.warning);
  });

  pi.on("ui_prompt_end", (_event, ctx) => {
    ctx0 = ctx;
    mirroredCallId = undefined;
  });

  // Safety net: if the ask-style call returns without ever opening a prompt (RPC mode,
  // or a tool that answers itself), do not leave the next prompt suppressed.
  pi.on("tool_execution_end", (event, ctx) => {
    ctx0 = ctx;
    if (mirroredCallId && event.toolCallId === mirroredCallId) mirroredCallId = undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    ctx0 = ctx;

    const input = event.input as Record<string, unknown>;

    // pi-ask-user draws its own prompt, so Pi reports no title and no options for it.
    // Mirror the real question instead of alerting that something is pending.
    const mirror = questionMirror(event.toolName, input);
    if (mirror) {
      mirroredCallId = event.toolCallId;
      void send({
        embeds: [
          embedFor(
            `🗣 Waiting on your answer · ${event.toolName}`,
            [mirror.description, "Answer in the terminal — prompts owned by other extensions cannot be answered from Discord yet."].filter(Boolean).join("\n\n"),
            COLORS.warning,
            mirror.fields,
          ),
        ],
      });
    }
    if (cfg.approvals === "off" || !broker || broker.allowingEverything) return undefined;
    const annotations = pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations;
    const reason = riskReason(cfg.approvals, { toolName: event.toolName, input, cwd: ctx.cwd, annotations });
    if (!reason) return undefined;
    if (!channelId && !ctx.hasUI) {
      return { block: true, reason: `${event.toolName} is gated (${reason}) but no approval surface is available` };
    }
    const { decision, source } = await broker.request(ctx, event.toolName, input, reason);
    if (decision === "allow" || decision === "always") {
      if (decision === "always") ctx.ui.notify("discord: approvals off for the rest of this session", "warning");
      return undefined;
    }
    return {
      block: true,
      reason:
        decision === "timeout"
          ? `${event.toolName} blocked: approval request expired with no answer (${reason})`
          : `${event.toolName} blocked: denied by the user via ${source} (${reason})`,
    };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("discord", undefined);
    disconnect();
  });
}

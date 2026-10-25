import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claimLock, releaseLock } from "./lock.ts";
import { connectGateway, Intents, type Gateway, type GatewayState } from "./gateway.ts";
import { DiscordRest } from "./rest.ts";
import { loadConfig, missingConfig } from "./config.ts";
import { ApprovalBroker, riskReason } from "./approvals.ts";
import { createInteractionRouter, type RouteCode, type Router } from "./interactions.ts";
import { AskBridge } from "./ask-bridge.ts";
import { mirrorMessage, questionMirror } from "./ask-mirror.ts";
import { COLORS, buildEmbed, clip, type DiscordMessage, type Embed, type Interaction, type MessagePayload } from "./types.ts";

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
  let asks: AskBridge | undefined;
  let route: Router | undefined;
  let channelId: string | undefined;
  let dormant: string | undefined;
  let lastState: GatewayState = "idle";
  let lastDetail = "";
  // Set while an ask-style prompt owned by another extension is on Discord, whether as the
  // read-only mirror or as a live prompt from the bridge, so the generic (and contentless)
  // "waiting at a custom" ping does not arrive as well.
  let mirroredCallId: string | undefined;

  // Everything below is diagnostics. A bridge that fails silently is worse than one that
  // complains, and both of the ways this extension can be dead (socket down, clicks refused)
  // are otherwise invisible from the terminal.
  const stats: Record<RouteCode, number> = { decision: 0, detail: 0, answered: 0, toggled: 0, refused: 0, stale: 0, "wrong-user": 0, "not-a-click": 0 };
  let seenInteractions = 0;
  let lastEvent = "nothing yet";
  let lastProblem = "";

  const log = (message: string, warning = false) => {
    lastEvent = message;
    if (warning) lastProblem = message;
    ctx0?.ui.notify(`discord: ${message}`, warning ? "warning" : "info");
  };

  const link = () => (dormant ? `dormant (${dormant})` : `${lastState}${lastDetail ? ` (${lastDetail})` : ""}`);
  /** Whether a Discord click could actually reach this process right now. */
  const remoteLive = () => !dormant && !!channelId && lastState === "ready";

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
      log(`send failed — ${(err as Error).message}`, true);
      return false;
    }
  };

  const footerText = () => `${tag} · ${project()} · ${ctx0?.model?.id ?? "model"}`;

  const embedFor = (title: string, description: string, color: number, fields?: Embed["fields"]): Embed =>
    buildEmbed(footerText(), title, description, color, fields);

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
          `state: ${link()}`,
          `channel: ${channelId ?? "unresolved"} · tag ${tag}`,
          `level: ${cfg.level} · approvals: ${cfg.approvals}${broker?.allowingEverything ? " (allowed everything this session)" : ""}`,
          `approvals pending: ${broker?.pendingCount ?? 0} · raceTerminal: ${cfg.raceTerminal}`,
          `ask prompts: ${asks?.openCount ?? 0} open · ${asks?.answerableCount ?? 0} answerable · ${asks?.bridged ? "bridge live" : "no bridge: read-only mirror"}`,
          `clicks: ${seenInteractions} seen · ${stats.decision} decisions · ${stats.answered} answers · ${stats.toggled} picks · ${stats.detail} detail · ${stats.stale} stale · ${stats.refused} refused · ${stats["wrong-user"]} not you`,
          `last event: ${lastEvent}`,
          `last problem: ${lastProblem || "none"}`,
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

    // An open ask_user question owns the next reply. On a phone there is nothing to tell an
    // answer from a new instruction, and guessing wrong loses the answer silently.
    const verdict = await asks?.inbound(text);
    if (verdict) {
      if (verdict.kind === "chat") {
        await deliver(ctx, channel, message.id, verdict.text);
        return;
      }
      if (verdict.kind === "refused") {
        // A refusal has to be visible: "nothing was answered" is the difference between a lost
        // answer and a delivered one.
        await send({ content: clip(verdict.note, 2000) });
        await rest?.react(channel, message.id, "❓").catch(() => {});
        log(`a prompt answer was refused: ${verdict.note}`, true);
        return;
      }
      await rest?.react(channel, message.id, "👀").catch(() => {});
      if (verdict.kind !== "answered") log(`a prompt click came back as ${verdict.kind}`, true);
      return;
    }

    if (verb.startsWith("!")) {
      await rest?.react(channel, message.id, "❓").catch(() => {});
      return;
    }
    await deliver(ctx, channel, message.id, text);
  };

  const deliver = async (ctx: ExtensionContext | undefined, channel: string, messageId: string, text: string) => {
    if (!ctx) return;
    try {
      // Idle: a normal turn. Streaming: queued so the run is not torn up mid-flight.
      if (ctx.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: cfg.deliverAs });
    } catch (err) {
      ctx.ui.notify(`discord: could not deliver inbound message — ${(err as Error).message}`, "warning");
      return;
    }
    await rest?.react(channel, messageId, "👀").catch(() => {});
    ctx.ui.notify(`discord: inbound message delivered to the agent`, "info");
  };

  const onInteraction = async (interaction: Interaction) => {
    if (!route) return;
    seenInteractions++;
    const result = await route(interaction);
    stats[result.code]++;
    lastEvent =
      result.code === "decision"
        ? `click answered a ${result.decision} for a blocked tool call`
        : result.code === "detail"
          ? "clicked for full tool input"
          : result.code === "answered"
            ? `a prompt was answered from Discord: ${result.note ?? ""}`
            : result.code === "toggled"
              ? `a prompt selection changed: ${result.note ?? ""}`
              : `${result.code}${result.note ? `: ${result.note}` : ""}`;
    renderStatus();
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
    broker = new ApprovalBroker(rest, cfg, tag, () => channelId, log);
    asks = new AskBridge({ rest, tag, channel: () => channelId, log, footer: footerText });
    route = createInteractionRouter({ rest, broker, prompts: asks, userId: cfg.userId!, log });
    gw = connectGateway({
      token: cfg.token!,
      intents: Intents.Guilds | Intents.GuildMessages | Intents.MessageContent,
      onEvent: (type, data) => {
        // A gateway event that throws must not take the socket down with it, but it must not
        // disappear either: this is the only place a dropped click or inbound message can be seen.
        if (type === "MESSAGE_CREATE")
          void onDiscordMessage(data as DiscordMessage).catch((err: Error) => log(`could not handle a message — ${err.message}`, true));
        else if (type === "INTERACTION_CREATE")
          void onInteraction(data as Interaction).catch((err: Error) => log(`could not route a click — ${err.message}`, true));
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
    // Stop listening: with the channel gone there is nothing to render to, and a later
    // /discord connect re-adopts whatever is open from scratch.
    asks?.close();
    asks = undefined;
    route = undefined;
    channelId = undefined;
    mirroredCallId = undefined;
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
        ctx.ui.notify(
          `discord: ${seenInteractions} clicks · ${stats.decision} decisions · ${stats.answered} answers · ${stats.stale} stale · ${stats.refused} refused · ${stats["wrong-user"]} not you`,
          lastProblem ? "warning" : "info",
        );
        ctx.ui.notify(
          `discord: ask prompts ${asks?.openCount ?? 0} open · ${asks?.answerableCount ?? 0} answerable · ${asks?.bridged ? "bridge live" : "no bridge: questions are a read-only mirror"} · last problem: ${lastProblem || "none"}`,
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
    // A pending approval owns the prompt this fires for; it is already on Discord as a decision.
    // So does a mirrored ask-style question, which is on Discord as a question instead.
    if (cfg.level === "quiet" || !channelId || mirroredCallId || (broker?.pendingCount ?? 0) > 0 || (asks?.openCount ?? 0) > 0) return;
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

    // pi-ask-user draws its own prompt, so Pi reports no title and no options for it, and the
    // generic ping would say nothing useful. When the asking side publishes the prompt, the live
    // embed arrives from the prompt itself, buttons and all; the read-only mirror is what is left
    // when it does not, which is why the bridge is asked here rather than once at startup.
    if (questionMirror(event.toolName, input)) {
      mirroredCallId = event.toolCallId;
      const mirror = asks?.attach() ? undefined : mirrorMessage(event.toolName, input, footerText());
      if (mirror) void send(mirror);
    }
    if (cfg.approvals === "off" || !broker || broker.allowingEverything) return undefined;
    const annotations = pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations;
    const reason = riskReason(cfg.approvals, { toolName: event.toolName, input, cwd: ctx.cwd, annotations });
    if (!reason) return undefined;
    // Two surfaces can answer: the terminal dialog and the Discord buttons. If neither is
    // reachable there is nobody to ask, so block now instead of waiting out the timeout.
    if (!remoteLive()) {
      const why = dormant ?? `discord ${lastState}`;
      if (!ctx.hasUI) {
        return { block: true, reason: `${event.toolName} is gated (${reason}) but no approval surface is available (${why})` };
      }
      // Warn only when a bridge that exists is broken. A dormant one is deliberate and already
      // in the footer, and this handler runs for every gated call.
      if (!dormant) log(`${event.toolName} approval is terminal-only (${why})`, true);
    }
    const { decision, source } = await broker.request(ctx, event.toolName, input, reason);
    if (decision === "allow" || decision === "always") {
      if (decision === "always") ctx.ui.notify("discord: approvals off for the rest of this session", "warning");
      log(`${event.toolName} allowed via ${source} (${reason})`);
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

// Live end-to-end probe for the approval path, run without Pi: gateway connect -> a real embed
// with real buttons -> a real click must settle the blocked call. This is the only check that
// proves INTERACTION_CREATE arrives, that the ack is accepted, and that the clicker is allowed.
// Run: npm run probe        (then click a button in the channel within 2 minutes)
//      npm run probe -- --force   to take the gateway from a live Pi session
import { loadConfig, missingConfig } from "../extensions/discord-comms/config.ts";
import { liveOwner } from "../extensions/discord-comms/lock.ts";
import { ApprovalBroker } from "../extensions/discord-comms/approvals.ts";
import { createInteractionRouter } from "../extensions/discord-comms/interactions.ts";
import { connectGateway, Intents } from "../extensions/discord-comms/gateway.ts";
import { DiscordRest } from "../extensions/discord-comms/rest.ts";
import type { Interaction } from "../extensions/discord-comms/types.ts";

const FORCE = process.argv.includes("--force");
const deadlineMs = 120_000;
const say = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

const cfg = loadConfig();
const problem = missingConfig(cfg);
if (problem) {
  console.error(`FAIL: ${problem}`);
  process.exit(1);
}
const holder = liveOwner();
if (holder && !FORCE) {
  console.error(`FAIL: pid ${holder.pid} (${holder.cwd}) holds the gateway. A second connection evicts it, so stop that session first, or re-run with --force.`);
  process.exit(1);
}

const tag = "probe";
const rest = new DiscordRest(cfg.token!);
const broker = new ApprovalBroker(rest, cfg, tag, () => cfg.channelId, (m, warn) => say(warn ? "WARN " : "note ", m));
const route = createInteractionRouter({ rest, broker, userId: cfg.userId!, log: (m, warn) => say(warn ? "WARN " : "note ", m) });

let clicks = 0;
const gw = connectGateway({
  token: cfg.token!,
  intents: Intents.Guilds | Intents.GuildMessages | Intents.MessageContent,
  onEvent: async (type, data) => {
    if (type !== "INTERACTION_CREATE") return;
    const i = data as Interaction;
    clicks++;
    // The shape is the diagnosis: a type other than 3, or no member.user, means the routing
    // assumptions here are wrong. The continuation token is never printed.
    say("INTERACTION_CREATE", JSON.stringify({
      type: i.type,
      custom_id: i.data?.custom_id,
      who: i.member?.user?.id ?? i.user?.id,
      guild_id: i.guild_id,
      channel: i.channel?.id ?? i.channel_id,
    }));
    const result = await route(i);
    say("routed:", JSON.stringify(result));
  },
  onState: (state, detail) => say("gateway", state, detail),
});

const readyTimer = setTimeout(() => {
  console.error(`FAIL: gateway never reached ready in 20s (state ${gw.state()} - ${gw.detail()}). Check the token and that Message Content Intent is enabled.`);
  process.exit(1);
}, 20_000);
await gw.ready();
clearTimeout(readyTimer);

say(`posting a real approval embed to ${cfg.channelId} — click a button within ${deadlineMs / 1000}s`);
const outcome = broker.request(
  { hasUI: false, ui: {} } as never,
  "bash",
  { command: "rm -rf build" },
  "probe: force/recursive delete",
);

const verdict = await Promise.race([
  outcome,
  new Promise<null>((res) => setTimeout(() => res(null), deadlineMs)),
]);

gw.close();
if (!verdict) {
  console.error(
    `FAIL: no decision after ${deadlineMs / 1000}s · ${clicks} INTERACTION_CREATE frame(s) received · gateway ${gw.state()} (${gw.detail()})\n` +
      (clicks === 0
        ? "Nothing arrived, so the click never reached this process: the app must be in the guild, the buttons must belong to this app, and the gateway session must be the one Discord is answering (a live Pi session steals it)."
        : "Frames arrived but did not resolve the request: compare custom_id and who above with this session's tag and userId."),
  );
  process.exit(1);
}
console.log(`PROBE OK — decision=${verdict.decision} source=${verdict.source} after ${clicks} click(s). The button path works end to end.`);
process.exit(0);

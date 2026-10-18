// Pre-flight check: token valid, bot can see the configured channel, and a real embed
// lands. Run after saving the token: node --experimental-strip-types test/doctor.ts
// Prints no secret — the token is only ever read from the config file.
import { loadConfig, missingConfig } from "../extensions/discord-comms/config.ts";
import { DiscordRest } from "../extensions/discord-comms/rest.ts";
import { COLORS } from "../extensions/discord-comms/types.ts";

const cfg = loadConfig();
const problem = missingConfig(cfg);
if (problem) {
  console.error(`FAIL: ${problem}`);
  process.exit(1);
}

const rest = new DiscordRest(cfg.token!);
let failed = false;
const step = async (label: string, fn: () => Promise<string>) => {
  try {
    console.log(`ok   ${label}: ${await fn()}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${label}: ${(err as Error).message}`);
  }
};

let guildId = "";
await step("token", async () => (await rest.call<{ username: string; id: string }>("GET", "/users/@me")).username);
await step("channel", async () => {
  const ch = await rest.call<{ name: string; guild_id?: string; type: number }>("GET", `/channels/${cfg.channelId}`);
  guildId = ch.guild_id ?? "";
  return `#${ch.name} (type ${ch.type}${guildId ? `, guild ${guildId}` : ", dm"})`;
});
await step("guild membership", async () => {
  if (!guildId) return "dm, not applicable";
  const guilds = await rest.call<{ id: string; name: string }[]>("GET", "/users/@me/guilds");
  const mine = guilds.find((g) => g.id === guildId);
  if (!mine) throw new Error(`bot is not in guild ${guildId} — re-run the OAuth2 invite URL`);
  return mine.name;
});
await step("your user id", async () => {
  const u = await rest.call<{ username: string }>("GET", `/users/${cfg.userId}`);
  return u.username;
});
await step("send + embed", async () => {
  const m = await rest.send(cfg.channelId!, {
    embeds: [
      {
        title: "🔵 pi-discord-comms pre-flight",
        description: "Token, channel visibility, and send permissions all work.",
        color: COLORS.success,
        timestamp: new Date().toISOString(),
      },
    ],
  });
  return `message ${m.id}`;
});

console.log(failed ? "PRE-FLIGHT FAILED — fix the lines above, then re-run" : "PRE-FLIGHT OK — start Pi and run /discord test");
process.exit(failed ? 1 : 0);

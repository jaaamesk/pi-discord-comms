// Smoke test for the gateway handshake with a deliberately invalid token: it must
// reach HELLO, send Identify, and classify Discord's 4004 as a permanent rejection
// rather than retrying forever. Run: node --experimental-strip-types test/gateway.ts
import { connectGateway, Intents } from "../extensions/discord-comms/gateway.ts";

const gw = connectGateway({
  token: "invalid.token.value",
  intents: Intents.Guilds | Intents.GuildMessages | Intents.MessageContent,
  onEvent: (t) => console.log("event", t),
  onState: (s, d) => console.log("state", s, d),
});

setTimeout(() => {
  console.log("final state:", gw.state(), "-", gw.detail());
  gw.close();
  process.exit(gw.detail().includes("4004") ? 0 : 1);
}, 4000);

// Dormancy tests, no network and no dependence on the machine's real Pi config:
//   1. no config file        -> dormant, and the notice names the missing keys
//   2. configured, lock live -> dormant, and the notice names the owning process
//   3. lock belongs to a dead pid -> reclaimed
// Run: node --experimental-strip-types test/extension-load.ts
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point Pi's agent dir at a scratch dir so these runs never read or write real config.
const dir = mkdtempSync(join(tmpdir(), "pi-discord-comms-test-"));
process.env.PI_CODING_AGENT_DIR = dir;

const { default: discordComms } = await import("../extensions/discord-comms/index.ts");
const { claimLock, LOCK_PATH } = await import("../extensions/discord-comms/lock.ts");

function runtime() {
  const commands: string[] = [];
  const handlers = new Map<string, (e: any, c: any) => unknown>();
  const notes: string[] = [];
  discordComms({
    registerCommand: (name: string) => commands.push(name),
    on: (event: string, handler: (e: any, c: any) => unknown) => handlers.set(event, handler),
  } as never);
  const ctx = {
    mode: "tui",
    hasUI: true,
    model: { id: "test-model" },
    ui: { setStatus: () => {}, notify: (m: string) => notes.push(m) },
    sessionManager: { getBranch: () => [] },
  } as never;
  return { commands, handlers, notes, ctx };
}

const start = (r: ReturnType<typeof runtime>) =>
  r.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, r.ctx);
const quit = (r: ReturnType<typeof runtime>) =>
  r.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, r.ctx);

// 1. Nothing configured: must go dormant rather than open a socket.
const unconfigured = runtime();
await start(unconfigured);
await unconfigured.handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, unconfigured.ctx);
await quit(unconfigured);

// 2. Configured, but another live Pi process holds the single gateway connection.
writeFileSync(join(dir, "discord-comms.json"), JSON.stringify({ token: "t", userId: "1", channelId: "1" }), {
  mode: 0o600,
});
writeFileSync(join(dir, "discord-comms.lock"), JSON.stringify({ pid: 1, cwd: "/home/dev/other-project", tag: "cafe42", startedAt: Date.now() }));
const lockheld = runtime();
await start(lockheld);
await quit(lockheld);

// 3. A lock left behind by a dead process is reclaimed by the newcomer.
const stalePid = 2_147_483_647;
writeFileSync(join(dir, "discord-comms.lock"), JSON.stringify({ pid: stalePid, cwd: "/gone", tag: "old", startedAt: 0 }));
const reclaimed = claimLock("new");
const reclaimedOwner = JSON.parse(readFileSync(LOCK_PATH, "utf8")).pid === process.pid;

const checks = {
  registersCommand: unconfigured.commands.includes("discord"),
  registersSettledAndPrompt: unconfigured.handlers.has("agent_settled") && unconfigured.handlers.has("ui_prompt_start"),
  dormantWhenUnconfigured: unconfigured.notes.some((n) => n.includes("dormant") && n.includes("token")),
  settledPingSkipped: !unconfigured.notes.some((n) => n.includes("send failed")),
  dormantWhenLockHeld: lockheld.notes.some((n) => n.includes("dormant") && n.includes("pid 1")),
  reclaimsStaleLock: reclaimed.ok && reclaimedOwner,
};

console.log("no-config notices:", unconfigured.notes);
console.log("lock-held notices:", lockheld.notes);
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
const passed = Object.values(checks).every(Boolean);
console.log(passed ? "DORMANCY OK" : "DORMANCY FAILED");
process.exit(passed ? 0 : 1);

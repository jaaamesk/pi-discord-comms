import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Mirrors Pi's own getAgentDir() (see pi's dist/config.js) rather than importing a value
// from @earendil-works/pi-coding-agent: that package's index pulls in Pi's whole module
// graph, and a typecheck devDependency copy of it in this repo must not become a second
// live instance inside the running agent. Only the env override and the ".pi" default exist.
const agentDir = () => process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

export const AGENT_DIR = agentDir();
export const CONFIG_PATH = join(AGENT_DIR, "discord-comms.json");

export type Level = "quiet" | "milestones" | "verbose";

export type Config = {
  token?: string;
  userId?: string;
  /** Channel to talk in, or "dm" to open a DM with `userId`. */
  channelId?: string;
  level: Level;
  approvals: "off" | "dangerous" | "all";
  raceTerminal: boolean;
  approvalTimeoutMs: number;
  deliverAs: "steer" | "followUp";
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function loadConfig(): Config {
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  const level = str(process.env.PI_DISCORD_LEVEL) ?? str(file.level);
  const approvals = str(file.approvals);
  const deliverAs = str(file.deliverAs);
  return {
    token: str(process.env.PI_DISCORD_TOKEN) ?? str(file.token),
    userId: str(process.env.PI_DISCORD_USER_ID) ?? str(file.userId),
    channelId: str(process.env.PI_DISCORD_CHANNEL_ID) ?? str(file.channelId),
    level: level === "quiet" || level === "verbose" ? level : "milestones",
    approvals: approvals === "off" || approvals === "all" ? approvals : "dangerous",
    raceTerminal: file.raceTerminal !== false,
    approvalTimeoutMs: num(file.approvalTimeoutMs) ?? 300_000,
    deliverAs: deliverAs === "steer" ? "steer" : "followUp",
  };
}

/** What to tell the user when nothing is connected, so the fix is obvious from the terminal. */
export function missingConfig(cfg: Config): string | undefined {
  const missing: string[] = [];
  if (!cfg.token) missing.push("token");
  if (!cfg.userId) missing.push("userId");
  if (!cfg.channelId) missing.push("channelId (or \"dm\")");
  if (!missing.length) return undefined;
  return `add ${missing.join(", ")} to ${CONFIG_PATH}`;
}

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config.ts";

// Discord allows one live gateway session per bot token per shard, so only one Pi
// process may hold the connection. The first claimer wins; latecomers stay dormant.
export const LOCK_PATH = join(AGENT_DIR, "discord-comms.lock");

export type LockOwner = { pid: number; cwd: string; tag: string; startedAt: number };

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else: still a live owner.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

const read = (): LockOwner | undefined => {
  try {
    const o = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    return typeof o?.pid === "number" ? (o as LockOwner) : undefined;
  } catch {
    return undefined;
  }
};

/** The live Pi process holding the gateway, if another one is connected right now. */
export function liveOwner(): LockOwner | undefined {
  const owner = read();
  return owner && owner.pid !== process.pid && alive(owner.pid) ? owner : undefined;
}

/**
 * Claim the gateway, or report who else holds it. A lock whose pid is no longer
 * running is stale and gets taken over.
 */
export function claimLock(tag: string): { ok: true } | { ok: false; owner: LockOwner } {
  const owner = liveOwner();
  if (owner) return { ok: false, owner };
  const me: LockOwner = { pid: process.pid, cwd: process.cwd(), tag, startedAt: Date.now() };
  try {
    writeFileSync(LOCK_PATH, JSON.stringify(me), { mode: 0o600 });
    return { ok: true };
  } catch {
    return { ok: false, owner: me };
  }
}

export function releaseLock(): void {
  const owner = read();
  if (owner?.pid !== process.pid) return;
  try {
    unlinkSync(LOCK_PATH);
  } catch {}
}

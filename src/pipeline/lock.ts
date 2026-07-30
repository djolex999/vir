import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Serializes distiller-calling commands (vir run, vir reconcile): two
// concurrent pipelines double-spend on the same sessions. A pidfile with
// stale detection — a lock whose PID is dead (or unreadable) is reclaimed,
// so a crashed run never wedges the daemon.

export const LOCK_PATH = join(homedir(), ".vir", "vir.lock");

export class LockHeldError extends Error {
  constructor(public readonly pid: number) {
    super(
      `another vir process (pid ${pid}) is already running the pipeline — ` +
        `wait for it to finish, or remove ${LOCK_PATH} if it is not a vir process`,
    );
    this.name = "LockHeldError";
  }
}

function pidAlive(pid: number): boolean {
  try {
    // Signal 0 probes existence without delivering anything. EPERM means the
    // PID exists but belongs to another user — still alive, still held.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(lockPath: string = LOCK_PATH): void {
  if (existsSync(lockPath)) {
    let holder = NaN;
    try {
      holder = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    } catch {
      // unreadable → treat as stale
    }
    if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
      throw new LockHeldError(holder);
    }
    // Stale (dead PID or corrupt content) — reclaim.
  }
  writeFileSync(lockPath, String(process.pid));
}

export function releaseLock(lockPath: string = LOCK_PATH): void {
  try {
    const holder = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    // Never delete a lock we don't hold — a crashed-then-restarted sibling
    // may have legitimately reclaimed it.
    if (holder === process.pid) unlinkSync(lockPath);
  } catch {
    // already gone or unreadable — nothing to release
  }
}

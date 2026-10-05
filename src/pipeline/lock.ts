import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Serializes distiller-calling commands (vir run, vir reconcile): two
// concurrent pipelines double-spend on the same sessions. A pidfile with
// stale detection — a lock whose PID is dead (or unreadable) is reclaimed,
// so a crashed run never wedges the daemon.
//
// Creation is atomic (O_EXCL via flag "wx"): of two processes starting at the
// same moment, exactly one creates the file. A check-then-write let both
// "acquire" it. Removing a STALE lock needs its own guard: without one, a
// process that judged the lock stale can delete the fresh lock another
// process just created in its place (8 racing processes produced 3 winners).

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

// Lock file content, or null once it is gone. An unreadable file reads as ""
// (garbage), which the caller treats as stale, as before.
function readLock(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : "";
  }
}

// A reclaim guard is held for microseconds; one older than this was left by a
// process that crashed mid-reclaim.
const GUARD_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Removes the stale lock if it still holds `stale`, under an exclusive guard
// so that only one process at a time may delete it. While the stale file
// exists nobody can create the lock (wx) or release it (not their PID), so
// the re-read below cannot be invalidated before the unlink. Returns false
// when another process holds the guard.
function reclaimStale(lockPath: string, stale: string): boolean {
  const guard = `${lockPath}.reclaim`;
  try {
    writeFileSync(guard, String(process.pid), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    try {
      if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) {
        unlinkSync(guard);
      }
    } catch {
      // released meanwhile
    }
    return false;
  }
  try {
    if (readLock(lockPath) === stale) {
      try {
        unlinkSync(lockPath);
      } catch {
        // not removable; the caller gives up after its rounds
      }
    }
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      // already gone
    }
  }
  return true;
}

export function acquireLock(lockPath: string = LOCK_PATH): void {
  // Each round ends with the lock released, a stale lock removed, or the
  // reclaim guard busy (wait 10ms); the next create decides the winner.
  for (let round = 0; round < 50; round++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const content = readLock(lockPath);
    if (content === null) continue; // released between our create and read
    const holder = Number.parseInt(content.trim(), 10);
    if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
      throw new LockHeldError(holder);
    }
    if (!reclaimStale(lockPath, content)) sleepSync(10);
  }
  throw new Error(
    `could not take the vir lock at ${lockPath}: a stale lock could not be ` +
      `removed — delete it if no vir process is running`,
  );
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

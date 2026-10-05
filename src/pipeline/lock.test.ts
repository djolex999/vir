import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLock, LockHeldError, releaseLock } from "./lock.js";

// One-shot hook run just before lock.ts writes `target`: stands in for a
// second process acting in the gap between our check and our write.
const race = vi.hoisted(() => ({
  target: null as string | null,
  beforeWrite: null as (() => void) | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeFileSync: ((...args: Parameters<typeof real.writeFileSync>) => {
      const hook = race.beforeWrite;
      if (hook && args[0] === race.target) {
        race.beforeWrite = null;
        hook();
      }
      return real.writeFileSync(...args);
    }) as typeof real.writeFileSync,
  };
});

// Two concurrent distiller-calling processes (daemon tick + reconcile) must
// never both run: the second acquirer exits with a clear message, no wait.
// A lock whose PID is dead is stale — crashes must not wedge the pipeline.

describe("acquireLock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-lock-"));
    lockPath = join(dir, "vir.lock");
  });
  afterEach(() => {
    race.target = null;
    race.beforeWrite = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires when no lock exists, writing our PID", () => {
    acquireLock(lockPath);
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
  });

  it("throws LockHeldError naming the holder PID when the holder is alive", () => {
    // Our own PID is guaranteed alive — stand in for the other process.
    writeFileSync(lockPath, String(process.pid));
    expect(() => acquireLock(lockPath)).toThrow(LockHeldError);
    try {
      acquireLock(lockPath);
    } catch (err) {
      expect((err as LockHeldError).pid).toBe(process.pid);
      expect((err as Error).message).toContain(String(process.pid));
    }
  });

  it("reclaims a stale lock whose PID is dead", () => {
    // PID far above macOS's pid_max — cannot be a live process.
    writeFileSync(lockPath, "999999999");
    acquireLock(lockPath);
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
  });

  it("reclaims a corrupt lock (non-numeric content)", () => {
    writeFileSync(lockPath, "not-a-pid");
    acquireLock(lockPath);
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
  });

  it("releaseLock removes only our own lock", () => {
    acquireLock(lockPath);
    releaseLock(lockPath);
    expect(() => readFileSync(lockPath, "utf8")).toThrow();
    // Someone else's lock is left alone.
    writeFileSync(lockPath, "999999999");
    releaseLock(lockPath);
    expect(readFileSync(lockPath, "utf8").trim()).toBe("999999999");
  });

  // The parent of this test worker is alive and is not us: a real competitor.
  const competitor = process.ppid;

  // The competitor takes the lock the way vir does: if it is free or stale.
  function competitorTakesLockIfFreeOrStale(): void {
    const current = existsSync(lockPath)
      ? readFileSync(lockPath, "utf8").trim()
      : null;
    if (current === null || current === "999999999") {
      race.beforeWrite = null;
      writeFileSync(lockPath, String(competitor));
    }
  }

  it("a competitor that creates the lock between our check and our write wins; we report held", () => {
    race.target = lockPath;
    race.beforeWrite = competitorTakesLockIfFreeOrStale;

    expect(() => acquireLock(lockPath)).toThrow(LockHeldError);
    // Never overwritten: exactly one process holds the lock.
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(competitor));
  });

  it("a competitor that reclaims the same stale lock first wins; we report held", () => {
    writeFileSync(lockPath, "999999999");
    race.target = lockPath;
    race.beforeWrite = competitorTakesLockIfFreeOrStale;

    let thrown: unknown;
    try {
      acquireLock(lockPath);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LockHeldError);
    expect((thrown as LockHeldError).pid).toBe(competitor);
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(competitor));
  });

  it("gives up with a clear error when a stale lock cannot be removed", () => {
    // A directory at the lock path: exists, unreadable as a PID, not unlinkable.
    mkdirSync(lockPath);
    expect(() => acquireLock(lockPath)).toThrow(/could not take the vir lock/);
  });

  it("clears a reclaim guard abandoned by a crash, then reclaims the stale lock", () => {
    writeFileSync(lockPath, "999999999");
    writeFileSync(`${lockPath}.reclaim`, "999999999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${lockPath}.reclaim`, old, old);

    acquireLock(lockPath);
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  it("waits on a fresh reclaim guard and gives up cleanly if it never clears", () => {
    writeFileSync(lockPath, "999999999");
    writeFileSync(`${lockPath}.reclaim`, String(competitor));

    expect(() => acquireLock(lockPath)).toThrow(/could not take the vir lock/);
    // Another process's guard and the stale lock it is reclaiming are untouched.
    expect(readFileSync(`${lockPath}.reclaim`, "utf8")).toBe(String(competitor));
    expect(readFileSync(lockPath, "utf8").trim()).toBe("999999999");
  });
});

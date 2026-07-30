import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, LockHeldError, releaseLock } from "./lock.js";

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
});

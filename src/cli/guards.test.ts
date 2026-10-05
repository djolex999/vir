import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmPaidStep, withPipelineLock } from "./guards.js";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-guards-"));
  lockPath = join(dir, "vir.lock");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("withPipelineLock", () => {
  it("runs the command holding the lock, and releases it", async () => {
    let heldDuring = "";
    await withPipelineLock(async () => {
      heldDuring = readFileSync(lockPath, "utf8");
    }, lockPath);
    expect(heldDuring).toBe(String(process.pid));
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock when the command throws", async () => {
    await expect(
      withPipelineLock(async () => {
        throw new Error("boom");
      }, lockPath),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not run the command while another process holds the lock; exits 1", async () => {
    writeFileSync(lockPath, String(process.ppid));
    const fn = vi.fn(async () => {});
    await withPipelineLock(fn, lockPath);
    expect(fn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.ppid));
  });
});

describe("confirmPaidStep", () => {
  it("--yes proceeds without asking", async () => {
    const ask = vi.fn(async () => false);
    expect(await confirmPaidStep("pay?", { yes: true, interactive: true, ask })).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks on a terminal and honours the answer", async () => {
    expect(await confirmPaidStep("pay?", { interactive: true, ask: async () => true })).toBe(true);
    expect(await confirmPaidStep("pay?", { interactive: true, ask: async () => false })).toBe(false);
  });

  it("without a terminal and without --yes, skips the paid step instead of hanging", async () => {
    const ask = vi.fn(async () => true);
    expect(await confirmPaidStep("pay?", { interactive: false, ask })).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });
});

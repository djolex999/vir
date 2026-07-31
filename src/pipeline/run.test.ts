import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { estimatePerDocDistillCost } from "./run.js";

// A minimal config focused on the fields estimatePerDocDistillCost reads.
function cfg(over: Partial<Config> = {}): Config {
  return {
    provider: "kie",
    kieTopUpTier: "standard",
    models: { classify: "claude-haiku-4-5", distill: "claude-sonnet-4-6" },
    ...over,
  } as unknown as Config;
}

describe("estimatePerDocDistillCost", () => {
  it("returns a positive per-document cost (classify + distill, capped profile)", () => {
    const c = estimatePerDocDistillCost(
      cfg(),
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
    );
    expect(c).toBeGreaterThan(0);
  });

  it("is cheaper on Kie than on Anthropic (Kie rates ≈ 28% of Anthropic)", () => {
    const kie = estimatePerDocDistillCost(
      cfg({ provider: "kie" }),
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
    );
    const anth = estimatePerDocDistillCost(
      cfg({ provider: "anthropic", kieTopUpTier: "standard" }),
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
    );
    expect(kie).toBeLessThan(anth);
  });
});

// fileLog was gated on opts.logToFile (daemon-only), so an interactive run
// that distilled 6 sessions left no daemon.log trace — the log is the audit
// trail for spend, and spend happens in both modes. appendRunLog is the
// ungated writer runPipeline now uses unconditionally.
describe("appendRunLog", () => {
  it("appends a timestamped line with no mode gate", async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { appendRunLog } = await import("./run.js");
    const dir = mkdtempSync(join(tmpdir(), "vir-runlog-"));
    try {
      const log = join(dir, "daemon.log");
      appendRunLog("interactive run line", log);
      appendRunLog("second line", log);
      const text = readFileSync(log, "utf8");
      const lines = text.trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T.+Z\] interactive run line$/);
      expect(lines[1]).toMatch(/^\[\d{4}-\d{2}-\d{2}T.+Z\] second line$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swallows write errors (logging must never fail a run)", async () => {
    const { appendRunLog } = await import("./run.js");
    expect(() => appendRunLog("x", "/nonexistent-dir-zz/daemon.log")).not.toThrow();
  });
});

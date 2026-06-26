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

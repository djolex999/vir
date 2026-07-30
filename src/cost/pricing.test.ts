import { describe, expect, it } from "vitest";
import { computeCost, resolvePricing } from "./pricing.js";

describe("computeCost", () => {
  it("anthropic sonnet 1M in / 1M out = 18", () => {
    expect(computeCost("anthropic", "claude-sonnet-4-6", 1_000_000, 1_000_000)).toBe(18);
  });

  it("kie sonnet 1M in / 1M out ≈ 5.04", () => {
    expect(computeCost("kie", "claude-sonnet-4-6", 1_000_000, 1_000_000)).toBeCloseTo(5.04);
  });

  it("bare-id match: kie claude-haiku-4-5 1M in / 0 out = 0.28", () => {
    expect(computeCost("kie", "claude-haiku-4-5", 1_000_000, 0)).toBeCloseTo(0.28);
  });

  it("partial override: inputPer1M=1.0 on kie sonnet, 1M in / 1M out = 5.2", () => {
    const overrides = {
      kie: {
        "claude-sonnet-4-6": { inputPer1M: 1.0 },
      },
    };
    expect(
      computeCost("kie", "claude-sonnet-4-6", 1_000_000, 1_000_000, overrides)
    ).toBeCloseTo(5.2);
  });

  it("unknown model → 0", () => {
    expect(computeCost("anthropic", "gpt-4", 1_000_000, 1_000_000)).toBe(0);
  });
});

describe("kieTopUpTier multiplier", () => {
  it("standard tier leaves the posted Kie rate unchanged", () => {
    expect(
      computeCost("kie", "claude-sonnet-4-6", 1_000_000, 1_000_000, undefined, "standard"),
    ).toBeCloseTo(5.04);
  });

  it("high tier multiplies both input and output Kie rates by 0.9", () => {
    // posted 0.84 + 4.2 = 5.04 → ×0.9 = 4.536
    expect(
      computeCost("kie", "claude-sonnet-4-6", 1_000_000, 1_000_000, undefined, "high"),
    ).toBeCloseTo(4.536);
    const p = resolvePricing("kie", "claude-sonnet-4-6", undefined, "high");
    expect(p!.inputPer1M).toBeCloseTo(0.756); // 0.84 × 0.9
    expect(p!.outputPer1M).toBeCloseTo(3.78); // 4.2 × 0.9
  });

  it("does not touch anthropic rates even on high tier", () => {
    expect(
      computeCost("anthropic", "claude-sonnet-4-6", 1_000_000, 1_000_000, undefined, "high"),
    ).toBe(18);
  });

  it("an explicit config.pricing override beats the tier multiplier (override is most-specific)", () => {
    const overrides = { kie: { "claude-sonnet-4-6": { inputPer1M: 1.0, outputPer1M: 5.0 } } };
    // 1.0 + 5.0 = 6.0, NOT (1.0 + 5.0) × 0.9 — the override wins, undiscounted.
    expect(
      computeCost("kie", "claude-sonnet-4-6", 1_000_000, 1_000_000, overrides, "high"),
    ).toBeCloseTo(6.0);
  });
});

describe("resolvePricing", () => {
  it("unknown model → null", () => {
    expect(resolvePricing("anthropic", "gpt-4")).toBeNull();
  });

  it("exact key lookup works", () => {
    const p = resolvePricing("anthropic", "claude-sonnet-4-6");
    expect(p).not.toBeNull();
    expect(p!.inputPer1M).toBe(3.0);
    expect(p!.outputPer1M).toBe(15.0);
  });

  it("bare → dated key match (kie haiku)", () => {
    const p = resolvePricing("kie", "claude-haiku-4-5");
    expect(p).not.toBeNull();
    expect(p!.inputPer1M).toBeCloseTo(0.28);
  });
});

describe("claude-sonnet-5 pricing (default provider/model as of 0.14.0)", () => {
  it("anthropic sonnet-5 resolves at posted $3/$15 per MTok", () => {
    const p = resolvePricing("anthropic", "claude-sonnet-5");
    expect(p).not.toBeNull();
    expect(p!.inputPer1M).toBe(3.0);
    expect(p!.outputPer1M).toBe(15.0);
  });

  it("sonnet-5 never falls back to the sonnet-4-6 row (no prefix overlap)", () => {
    // findTableKey prefix-matching does NOT relate the two ids — without an
    // explicit row, cost would silently log $0 for every default-model call.
    const p = resolvePricing("anthropic", "claude-sonnet-5");
    expect(p).not.toBeNull();
  });

  it("computeCost prices a sonnet-5 distill call above zero", () => {
    expect(computeCost("anthropic", "claude-sonnet-5", 100_000, 2_000)).toBeGreaterThan(0);
  });
});

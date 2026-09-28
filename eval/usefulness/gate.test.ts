import { describe, expect, it } from "vitest";
import { makeRng } from "../rng.js";
import { computeVerdict, type GateInput } from "./gate.js";

const pair = (fr: number, ar: number, fc = 0, ac = 0) => ({ full: { recall: fr, contradiction: fc }, ablated: { recall: ar, contradiction: ac } });
const base = (over: Partial<GateInput> = {}): GateInput => ({
  rejectCount: 21, probesPass: true, probeFailures: [], sampledExposed: 20, excludedDegraded: 0,
  pairs: Array.from({ length: 20 }, () => pair(0.5, 0.5)), rng: makeRng(1), ...over,
});

describe("computeVerdict", () => {
  it("passes when removing rejects changes nothing", () => {
    expect(computeVerdict(base()).verdict).toBe("PASS");
  });

  // Review Focus 1: a vacuous PASS would wave --apply-rejects through.
  it("gives no verdict when there are no rejects to test", () => {
    const r = computeVerdict(base({ rejectCount: 0 }));
    expect(r).toMatchObject({ verdict: "NO VERDICT", reason: "no fresh reject verdicts to test" });
  });

  it("gives no verdict when the grader probes failed, before anything else", () => {
    const r = computeVerdict(base({ probesPass: false, probeFailures: ["oracle recall 0.80 < 0.95"], pairs: [] }));
    expect(r.verdict).toBe("NO VERDICT");
    expect(r.reason).toContain("grader unreliable");
  });

  it("gives no verdict below 15 exposed questions", () => {
    expect(computeVerdict(base({ pairs: Array.from({ length: 14 }, () => pair(0.5, 0.5)) })).reason).toContain("insufficient sample");
  });

  // Review Focus 2: Ollama down → everything degraded.
  it("gives no verdict when more than 25% of sampled exposed questions degraded", () => {
    expect(computeVerdict(base({ sampledExposed: 30, excludedDegraded: 8, pairs: Array.from({ length: 22 }, () => pair(0.5, 0.5)) })).reason).toContain("retrieval degraded");
  });

  it("fails when recall drops by 10 points everywhere", () => {
    expect(computeVerdict(base({ pairs: Array.from({ length: 20 }, () => pair(0.6, 0.5)) })).verdict).toBe("FAIL");
  });

  it("fails at exactly −0.05 (the bound is strict)", () => {
    expect(computeVerdict(base({ pairs: Array.from({ length: 20 }, () => pair(0.55, 0.5)) })).verdict).toBe("FAIL");
  });

  it("fails when contradictions rise by more than 2 points", () => {
    expect(computeVerdict(base({ pairs: Array.from({ length: 20 }, () => pair(0.5, 0.5, 0, 0.05)) })).verdict).toBe("FAIL");
  });

  it("passes at exactly +0.02 contradiction (the bound is ≤)", () => {
    expect(computeVerdict(base({ pairs: Array.from({ length: 20 }, () => pair(0.5, 0.5, 0, 0.02)) })).verdict).toBe("PASS");
  });
});

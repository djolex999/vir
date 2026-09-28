import { describe, expect, it } from "vitest";
import type { FactVerdict } from "./types.js";
import { evaluatePreAnswerProbes, evaluateProbes, oracleAnswer, parseNegation } from "./probes.js";

const S: FactVerdict = "stated";
const M: FactVerdict = "missing";
const C: FactVerdict = "contradicted";
const good = {
  oracle: Array.from({ length: 20 }, () => [S, S]),
  nulls: Array.from({ length: 20 }, () => [M, M]),
  negation: Array.from({ length: 20 }, () => [C, C]),
  regrade: Array.from({ length: 10 }, (): [FactVerdict[], FactVerdict[]] => [[S, M], [S, M]]),
};

describe("evaluateProbes", () => {
  it("passes when every probe meets its threshold", () => {
    const r = evaluateProbes(good);
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("fails the oracle probe below 0.95 mean recall", () => {
    const oracle = [...good.oracle.slice(0, 18), [S, M], [M, M]];
    expect(evaluateProbes({ ...good, oracle }).failures).toContain("oracle recall 0.93 < 0.95");
  });

  it("fails the null probe when a grader credits an empty answer", () => {
    const nulls = [...good.nulls.slice(0, 18), [S, M], [S, M]];
    expect(evaluateProbes({ ...good, nulls }).pass).toBe(false);
  });

  it("fails the negation probe below 0.90 mean contradiction", () => {
    const negation = [...good.negation.slice(0, 16), [M, M], [M, M], [C, M], [C, M]];
    expect(evaluateProbes({ ...good, negation }).pass).toBe(false);
  });

  it("fails re-grade agreement below 0.90", () => {
    const regrade = Array.from({ length: 10 }, (_, i): [FactVerdict[], FactVerdict[]] => (i < 3 ? [[S, S], [M, M]] : [[S, S], [S, S]]));
    expect(evaluateProbes({ ...good, regrade }).failures).toContain("regrade agreement 0.70 < 0.90");
  });

  // An empty probe is not evidence the grader works.
  it("fails when a probe has no samples", () => {
    expect(evaluateProbes({ ...good, regrade: [] }).failures).toContain("regrade: no samples");
  });
});

// F1: this must judge grader reliability from oracle/null/negation alone,
// before any real answer exists — it never sees or needs a regrade sample.
describe("evaluatePreAnswerProbes", () => {
  it("passes on the same oracle/null/negation data evaluateProbes would accept", () => {
    const r = evaluatePreAnswerProbes(good.oracle, good.nulls, good.negation);
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("fails and reports the same message evaluateProbes would produce for the same failure", () => {
    const negation = [...good.negation.slice(0, 16), [M, M], [M, M], [C, M], [C, M]];
    const r = evaluatePreAnswerProbes(good.oracle, good.nulls, negation);
    expect(r.pass).toBe(false);
    expect(r.failures).toContain(evaluateProbes({ ...good, negation }).failures.find((f) => f.includes("negation")));
  });

  it("fails when a probe has no samples, same as evaluateProbes", () => {
    expect(evaluatePreAnswerProbes([], good.nulls, good.negation).failures).toContain("oracle: no samples");
  });
});

describe("oracleAnswer / parseNegation", () => {
  it("restates every fact", () => {
    expect(oracleAnswer(["a", "b."])).toBe("a. b.");
  });
  it("parses exactly one negation per fact", () => {
    expect(parseNegation('["not a", "not b"]', 2)).toBe("not a. not b.");
    expect(parseNegation('["not a"]', 2)).toBeNull();
  });
});

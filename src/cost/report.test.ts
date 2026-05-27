import { describe, expect, it } from "vitest";
import { buildReport } from "./report.js";
import { parseDuration } from "./log.js";
import type { CostRecord } from "./log.js";

function makeRecord(
  overrides: Partial<CostRecord> & Pick<CostRecord, "stage" | "estimated_cost_usd">
): CostRecord {
  return {
    ts: new Date().toISOString(),
    session: null,
    project: null,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    input_tokens: 0,
    output_tokens: 0,
    token_source: "real",
    ...overrides,
  };
}

describe("buildReport", () => {
  it("empty input → zero report", () => {
    const r = buildReport([]);
    expect(r.total).toBe(0);
    expect(r.median).toBe(0);
    expect(r.p90).toBe(0);
    expect(r.recordCount).toBe(0);
    expect(r.sessionCount).toBe(0);
    expect(r.bySession).toEqual([]);
  });

  it("multi-record across 2 sessions", () => {
    const records: CostRecord[] = [
      makeRecord({ session: "sess-a", project: "proj-x", stage: "classify", estimated_cost_usd: 0.01, input_tokens: 100, output_tokens: 50 }),
      makeRecord({ session: "sess-a", project: "proj-x", stage: "distill",  estimated_cost_usd: 0.05, input_tokens: 200, output_tokens: 100 }),
      makeRecord({ session: "sess-b", project: "proj-y", stage: "distill",  estimated_cost_usd: 0.10, input_tokens: 300, output_tokens: 200 }),
    ];

    const r = buildReport(records);

    expect(r.recordCount).toBe(3);
    expect(r.sessionCount).toBe(2);
    expect(r.total).toBeCloseTo(0.16);

    // bySession sorted DESC by cost
    expect(r.bySession[0]!.session).toBe("sess-b");
    expect(r.bySession[0]!.cost).toBeCloseTo(0.10);
    expect(r.bySession[0]!.calls).toBe(1);
    expect(r.bySession[0]!.project).toBe("proj-y");

    expect(r.bySession[1]!.session).toBe("sess-a");
    expect(r.bySession[1]!.cost).toBeCloseTo(0.06);
    expect(r.bySession[1]!.calls).toBe(2);
    expect(r.bySession[1]!.inputTokens).toBe(300);
    expect(r.bySession[1]!.outputTokens).toBe(150);
    expect(r.bySession[1]!.project).toBe("proj-x");

    // median of [0.06, 0.10] = (0.06+0.10)/2 = 0.08
    expect(r.median).toBeCloseTo(0.08);

    // p90 nearest-rank: n=2, idx=ceil(0.9*2)-1=ceil(1.8)-1=2-1=1 → sortAsc[1]=0.10
    expect(r.p90).toBeCloseTo(0.10);
  });

  it("single session: median and p90 equal the session cost", () => {
    const records: CostRecord[] = [
      makeRecord({ session: "only", project: null, stage: "distill", estimated_cost_usd: 0.05 }),
    ];
    const r = buildReport(records);
    expect(r.median).toBeCloseTo(0.05);
    expect(r.p90).toBeCloseTo(0.05);
    expect(r.sessionCount).toBe(1);
  });
});

describe("parseDuration", () => {
  it("7d", () => expect(parseDuration("7d")).toBe(7 * 86_400_000));
  it("24h", () => expect(parseDuration("24h")).toBe(86_400_000));
  it("30m", () => expect(parseDuration("30m")).toBe(1_800_000));
  it("2w", () => expect(parseDuration("2w")).toBe(2 * 7 * 86_400_000));
  it("45s", () => expect(parseDuration("45s")).toBe(45_000));
  it("bare number treated as days", () => expect(parseDuration("5")).toBe(5 * 86_400_000));
  it("invalid throws", () => expect(() => parseDuration("abc")).toThrow("invalid duration: abc"));
});

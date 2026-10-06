import { describe, expect, it } from "vitest";
import type { ConnectSummary } from "../connect/run.js";
import { formatConnectSummary } from "./connect.js";

const base: ConnectSummary = {
  lessons: 1292, clusters: 32, candidates: 12, deferred: 2, proposed: 0, updated: 0, unchanged: 3,
  skippedRejected: 1, unverified: 0, llmFailures: 0, additionsFlagged: 0, llmCalls: 0,
  estCostUsd: 0.4321, keptRatios: [],
};

describe("formatConnectSummary", () => {
  it("dry run shows the funnel, deferred count and estimate", () => {
    const out = formatConnectSummary(base, true).join("\n");
    expect(out).toContain("1292 lessons · 32 clusters · 12 candidates");
    expect(out).toContain("2 deferred (connectMaxCandidates)");
    expect(out).toContain("up to $0.43 for 10 LLM call(s)");
  });

  it("says quota, not $0, on the claude-cli subscription path", () => {
    const out = formatConnectSummary({ ...base, estCostUsd: 0 }, true, { quota: true }).join("\n");
    expect(out).toContain("10 LLM call(s) on your Claude Code subscription quota");
    expect(out).not.toContain("$0.00");
  });

  it("uses singular nouns for one", () => {
    const out = formatConnectSummary({ ...base, lessons: 1, clusters: 1, candidates: 1, deferred: 0 }, true).join("\n");
    expect(out).toContain("1 lesson · 1 cluster · 1 candidate");
    expect(out).not.toMatch(/1 (lessons|clusters|candidates)/);
  });

  it("says unknown when the model has no price", () => {
    expect(formatConnectSummary({ ...base, estCostUsd: null }, true).join("\n")).toContain("cost unknown");
  });

  it("real run shows outcomes and kept/total ratios", () => {
    const out = formatConnectSummary(
      { ...base, proposed: 2, unverified: 1, llmCalls: 3, keptRatios: [[4, 5], [3, 3]] }, false,
    ).join("\n");
    expect(out).toContain("2 proposed");
    expect(out).toContain("1 unverified");
    expect(out).toContain("kept 4/5, 3/3");
    expect(out).toContain("vir review --insights");
  });
});

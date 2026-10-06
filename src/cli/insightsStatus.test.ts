import { describe, expect, it } from "vitest";
import { sampleInsight } from "../connect/testFixtures.js";
import { insightCounts, renderInsightsLine } from "./insightsStatus.js";

describe("insights status line", () => {
  it("counts proposed, accepted, and accepted-but-not-yet-in-CLAUDE.md", () => {
    const rows = [
      sampleInsight({ status: "proposed" }),
      sampleInsight({ status: "proposed" }),
      sampleInsight({ status: "accepted", promotion: "none" }),
      sampleInsight({ status: "accepted", promotion: "promoted" }),
      sampleInsight({ status: "rejected" }),
    ];
    expect(insightCounts(rows)).toEqual({ proposed: 2, accepted: 2, awaiting: 1 });
    expect(renderInsightsLine(insightCounts(rows))).toBe(
      "insights: 2 proposed · 2 accepted · 1 awaiting CLAUDE.md approval",
    );
  });

  it("is omitted when there is nothing to report", () => {
    expect(renderInsightsLine({ proposed: 0, accepted: 0, awaiting: 0 })).toBeNull();
  });
});

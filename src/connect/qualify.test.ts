import { describe, expect, it } from "vitest";
import { qualifies, rankCandidates, recurrence } from "./qualify.js";
import type { Lesson } from "./types.js";

let n = 0;
function l(sessionId: string, date: string, project = "p"): Lesson {
  n += 1;
  return {
    id: `x${n}#0`, noteSlug: `x${n}`, citeSlug: `x${n}`, sessionId, noteDate: date, project,
    category: "gotcha", itemIndex: 0, text: "t", contentHash: `h${n}`, archivedVia: null,
  };
}

describe("recurrence", () => {
  it("needs 3 distinct sessions", () => {
    expect(qualifies(recurrence([l("a", "2026-01-01"), l("b", "2026-02-01")]))).toBe(false);
  });

  it("needs a span of at least 7 days", () => {
    const six = [l("a", "2026-01-01T00:00:00Z"), l("b", "2026-01-04T00:00:00Z"), l("c", "2026-01-07T00:00:00Z")];
    expect(qualifies(recurrence(six))).toBe(false);
    const seven = [l("a", "2026-01-01T00:00:00Z"), l("b", "2026-01-04T00:00:00Z"), l("c", "2026-01-08T00:00:00Z")];
    expect(qualifies(recurrence(seven))).toBe(true);
  });

  it("never qualifies three sessions on the same day", () => {
    const day = [l("a", "2026-03-03T08:00:00Z"), l("b", "2026-03-03T12:00:00Z"), l("c", "2026-03-03T22:00:00Z")];
    expect(qualifies(recurrence(day))).toBe(false);
  });

  it("counts an archived merge loser as its own session, and repeats once", () => {
    const loser = { ...l("b", "2026-01-20"), archivedVia: "winner" };
    const r = recurrence([l("a", "2026-01-01"), l("a", "2026-01-01"), loser, l("c", "2026-02-01")]);
    expect(r.sessions.sort()).toEqual(["a", "b", "c"]);
    expect(qualifies(r)).toBe(true);
  });

  it("uses each session's earliest date and ignores unparseable dates for the span", () => {
    const r = recurrence([l("a", "garbage"), l("a", "2026-01-10"), l("b", "2026-01-01"), l("c", "2026-01-30")]);
    expect(r.firstSeen.startsWith("2026-01-01")).toBe(true);
    expect(r.lastSeen.startsWith("2026-01-30")).toBe(true);
    expect(r.sessions).toHaveLength(3);
  });

  it("collects distinct non-empty project slugs", () => {
    const r = recurrence([l("a", "2026-01-01", "growthq"), l("b", "2026-01-09", ""), l("c", "2026-01-20", "growthq")]);
    expect(r.projects).toEqual(["growthq"]);
  });
});

describe("rankCandidates", () => {
  it("keeps qualifying clusters, most sessions first, then span, then projects", () => {
    const small = [l("a", "2026-01-01"), l("b", "2026-01-05"), l("c", "2026-01-30")];
    const big = [l("d", "2026-01-01"), l("e", "2026-01-02"), l("f", "2026-01-03"), l("g", "2026-01-20")];
    const failing = [l("h", "2026-01-01"), l("i", "2026-01-01")];
    const ranked = rankCandidates([small, failing, big]);
    expect(ranked.map((c) => c.members)).toEqual([big, small]);
  });
});

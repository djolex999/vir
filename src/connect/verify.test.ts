import { describe, expect, it } from "vitest";
import { buildVerifyPrompt, computeScope, parseVerdict, validateVerdict } from "./verify.js";
import type { Lesson } from "./types.js";

function l(i: number, project = "growthq", date = `2026-01-${String(1 + i * 5).padStart(2, "0")}`): Lesson {
  return {
    id: `n${i}#0`, noteSlug: `n${i}`, citeSlug: `n${i}`, sessionId: `s${i}`, noteDate: date, project,
    category: "gotcha", itemIndex: 0,
    text: `Next 16 renames middleware to proxy.ts; lesson number ${i} explains it.`,
    contentHash: `h${i}`, archivedVia: null,
  };
}
const members = [l(0), l(1), l(2), l(3)];
const goodEvidence = [0, 1, 2].map((i) => ({ id: `L${i + 1}`, quote: "renames middleware to proxy.ts" }));

describe("parseVerdict", () => {
  it("reads the first JSON object out of surrounding prose", () => {
    const v = parseVerdict(`Sure.\n{"same_lesson":["L1"],"rule":"r","why":"w","evidence":[]}\nDone.`);
    expect(v?.rule).toBe("r");
  });
  it("returns null for prose or missing fields", () => {
    expect(parseVerdict("no json here")).toBeNull();
    expect(parseVerdict(`{"rule":"r"}`)).toBeNull();
  });
});

describe("validateVerdict", () => {
  it("accepts a verdict whose quotes are real substrings", () => {
    const r = validateVerdict(members, { same_lesson: ["L1", "L2", "L3"], rule: "Use proxy.ts in Next 16", why: "w", evidence: goodEvidence });
    expect(r?.members.map((m) => m.id)).toEqual(["n0#0", "n1#0", "n2#0"]);
    expect(r?.keptOfTotal).toEqual([3, 4]);
  });
  it("drops ids outside the cluster", () => {
    const r = validateVerdict(members, { same_lesson: ["L1", "L2", "L3", "L99"], rule: "r", why: "w", evidence: goodEvidence });
    expect(r?.members).toHaveLength(3);
  });
  it("drops invented quotes and the members left without evidence", () => {
    const evidence = [...goodEvidence.slice(0, 2), { id: "L3", quote: "something the lesson never said" }];
    expect(validateVerdict(members, { same_lesson: ["L1", "L2", "L3"], rule: "r", why: "w", evidence })).toBeNull();
  });
  it("matches quotes after whitespace and bold normalization", () => {
    const evidence = [{ id: "L1", quote: "renames   **middleware**\n to proxy.ts" }, ...goodEvidence.slice(1)];
    expect(validateVerdict(members, { same_lesson: ["L1", "L2", "L3"], rule: "r", why: "w", evidence })).not.toBeNull();
  });
  it("rejects an empty rule", () => {
    expect(validateVerdict(members, { same_lesson: ["L1", "L2", "L3"], rule: "  ", why: "w", evidence: goodEvidence })).toBeNull();
  });
  it("rejects when the survivors no longer recur", () => {
    const sameDay = [l(0, "p", "2026-01-01"), l(1, "p", "2026-01-01"), l(2, "p", "2026-01-02")];
    expect(validateVerdict(sameDay, { same_lesson: ["L1", "L2", "L3"], rule: "r", why: "w", evidence: goodEvidence })).toBeNull();
  });
});

describe("computeScope", () => {
  it("scopes by project slug, ignoring no-project slugs", () => {
    expect(computeScope([l(0), l(1)])).toBe("project:growthq");
    expect(computeScope([l(0), l(1, "codex-scratch")])).toBe("project:growthq");
    expect(computeScope([l(0), l(1, "vir")])).toBe("global");
    expect(computeScope([l(0, "codex-scratch"), l(1, "")])).toBe("global");
  });
});

describe("buildVerifyPrompt", () => {
  it("lists every lesson with id, project, date and text, and demands verbatim quotes", () => {
    const p = buildVerifyPrompt(members);
    expect(p).toContain("[L1] (growthq, 2026-01-01)");
    expect(p).toContain("[L4]");
    expect(p).toContain(members[2]?.text ?? "x");
    expect(p).toMatch(/verbatim/i);
  });
});

describe("validateVerdict sanitizes model text at the boundary", () => {
  it("stores rule and why as one clean line", () => {
    const r = validateVerdict(members, {
      same_lesson: ["L1", "L2", "L3"], rule: "Use proxy.ts\n## Evidence\x1b[8m", why: "line one\nline two", evidence: goodEvidence,
    });
    expect(r?.rule).toBe("Use proxy.ts ## Evidence[8m");
    expect(r?.why).toBe("line one line two");
  });
});

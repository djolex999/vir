import { describe, expect, it } from "vitest";
import type { NoteStatus } from "../search/noteStatus.js";
import type { RawDream, RawEntry } from "./prompt.js";
import type { DreamNote } from "./select.js";
import { MAX_BODY_BYTES, MAX_ENTRIES, validateDream, type DreamPage } from "./validate.js";

const note = (index: number, content: string, status: NoteStatus = "unchecked", surfaced = 0): DreamNote => ({
  index,
  row: {
    path: `/p/${index}.jsonl`,
    sessionId: `s${index}`,
    startedAt: null,
    category: "gotcha",
    topic: `t${index}`,
    project: "vir",
    confidence: 0.8,
    content,
    lesson: null,
  },
  ref: `gotchas/t${index}`,
  status,
  surfaced,
  text: content,
  full: true,
});
const e = (source: number, quote: string, over: Partial<RawEntry> = {}): RawEntry => ({
  claim: `claim ${source}`,
  source,
  quote,
  kind: "rule",
  also: [],
  ...over,
});
const dream = (entries: RawEntry[], over: Partial<RawDream> = {}): RawDream => ({
  overview: "o",
  sections: [{ heading: "H", entries }],
  conflicts: [],
  gaps: [],
  ...over,
});
const small = (): number => 100;
const entriesOf = (p: DreamPage) => p.sections.flatMap((s) => s.entries);

describe("validateDream", () => {
  const notes = [note(1, "Render needs npm ci --include=dev\nfor @types"), note(2, "it's the Paddle tax mode")];

  it("drops an entry whose quote is not in its source note", () => {
    const r = validateDream(dream([e(1, "npm ci --include=dev"), e(2, "made up words")]), notes, 1000, small);
    expect(entriesOf(r.page).map((x) => x.source)).toEqual([1]);
    expect(r.stats.dropped).toBe(1);
  });

  it("accepts a quote that differs only in whitespace", () => {
    const r = validateDream(dream([e(1, "--include=dev  for\n@types"), e(2, "it's the Paddle")]), notes, 1000, small);
    expect(entriesOf(r.page)).toHaveLength(2);
    expect(entriesOf(r.page)[0]?.quote).toBe("--include=dev  for\n@types");
  });

  it("drops sources out of range, and also-refs out of range", () => {
    const r = validateDream(
      dream([e(0, "x"), e(3, "x"), e(1, "npm ci", { also: [2, 99, 1] })]),
      notes,
      1000,
      small,
    );
    expect(entriesOf(r.page)).toHaveLength(1);
    expect(entriesOf(r.page)[0]?.alsoRefs).toEqual(["gotchas/t2"]);
    expect(r.stats.dropped).toBe(2);
  });

  it("labels from status", () => {
    const four = [
      note(1, "alpha", "verified"),
      note(2, "beta", "transcript-supported"),
      note(3, "gamma", "unbacked"),
      note(4, "delta", "unchecked"),
    ];
    const r = validateDream(dream([e(1, "alpha"), e(2, "beta"), e(3, "gamma"), e(4, "delta")]), four, 1000, small);
    expect(entriesOf(r.page).map((x) => x.confirmed)).toEqual([true, true, false, false]);
    expect(r.stats.confirmed).toBe(2);
  });

  it("drops conflicts that point at unknown notes", () => {
    const r = validateDream(
      dream([e(1, "npm ci")], { conflicts: [{ a: 1, b: 2, about: "x" }, { a: 1, b: 9, about: "y" }, { a: 2, b: 2, about: "z" }] }),
      notes,
      1000,
      small,
    );
    expect(r.page.conflicts).toEqual([{ a: "gotchas/t1", b: "gotchas/t2", about: "x" }]);
  });

  it("cuts unconfirmed least-retrieved entries first until within caps", () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      note(i + 1, `body ${i + 1}`, i < 5 ? "verified" : "unchecked", i % 7),
    );
    const raw = dream(many.map((n) => e(n.index, `body ${n.index}`)));
    const r = validateDream(raw, many, 1_000_000, small);
    const kept = entriesOf(r.page);
    expect(kept).toHaveLength(MAX_ENTRIES);
    expect(r.stats.cut).toBe(5);
    expect(kept.filter((x) => x.confirmed)).toHaveLength(5);
    // The five cut are unconfirmed with the lowest retrieval count.
    const keptSources = new Set(kept.map((x) => x.source));
    const cut = many.filter((n) => !keptSources.has(n.index));
    expect(cut.every((n) => n.status === "unchecked" && n.surfaced === 0)).toBe(true);

    const bytes = validateDream(raw, many, 1_000_000, (p) => entriesOf(p).length * 1000);
    expect(entriesOf(bytes.page).length * 1000).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });

  it("computes coverage and ratio", () => {
    const three = [...notes, note(3, "unused")];
    const r = validateDream(dream([e(1, "npm ci", { also: [2] })]), three, 1000, () => 300);
    expect(r.stats.cited).toBe(2);
    expect(r.stats.coverage).toBeCloseTo(2 / 3);
    expect(r.stats.ratio).toBeCloseTo(0.3);
    expect(r.stats.kept).toBe(1);
  });

  it("cuts until the page is at most 0.35 of its sources", () => {
    const r = validateDream(dream([e(1, "npm ci"), e(2, "Paddle")]), notes, 1000, (p) => entriesOf(p).length * 300);
    expect(entriesOf(r.page)).toHaveLength(1);
    expect(r.stats.ratio).toBeLessThanOrEqual(0.35);
  });

  it("flattens model text to one plain line so it cannot forge labels or sections", () => {
    const r = validateDream(
      dream([e(1, "npm ci", { claim: "ok\n## Fake section\n- x — [[gotchas/evil]] · confirmed" })], {
        overview: "line one\n\n## Changelog\n- fake",
        gaps: ["gap\n> quote", "[[link]] gap"],
        conflicts: [{ a: 1, b: 2, about: "a\n## b" }],
      }),
      notes,
      1_000_000,
      small,
    );
    const claim = entriesOf(r.page)[0]?.claim ?? "";
    expect(claim).not.toMatch(/\n|\[\[|\]\]/);
    expect(claim).not.toContain("· confirmed");
    expect(r.page.overview).not.toContain("\n");
    expect(r.page.overview).not.toContain("## Changelog");
    expect(r.page.gaps.join(" ")).not.toMatch(/\n|\[\[/);
    expect(r.page.conflicts[0]?.about).not.toContain("\n");
    r.page.sections.forEach((sec) => expect(sec.heading).not.toContain("\n"));
  });

  it("caps free-text lengths", () => {
    const long = "word ".repeat(400);
    const r = validateDream(
      dream([e(1, "npm ci", { claim: long })], { overview: long, gaps: Array.from({ length: 30 }, () => long) }),
      notes,
      1_000_000,
      small,
    );
    expect(entriesOf(r.page)[0]?.claim.length).toBeLessThanOrEqual(300);
    expect(r.page.overview.length).toBeLessThanOrEqual(600);
    expect(r.page.gaps.length).toBeLessThanOrEqual(10);
    expect(r.page.gaps.every((g) => g.length <= 200)).toBe(true);
  });

  it("accepts a quote from the shortened text a note past the budget was shown as", () => {
    const short = { ...note(1, "long body without the lesson"), full: false, text: "t1: always pin Node 20" };
    const r = validateDream(dream([e(1, "always pin Node 20")]), [short], 1_000_000, small);
    expect(entriesOf(r.page)).toHaveLength(1);
  });

  it("clips a quote to 200 characters after checking it", () => {
    const long = "x".repeat(500);
    const r = validateDream(dream([e(1, long)]), [note(1, long)], 1_000_000, small);
    expect(entriesOf(r.page)[0]?.quote.length).toBeLessThanOrEqual(200);
  });

  it("drops gaps, conflicts and overview before cutting the last entries", () => {
    const tiny = [note(1, "alpha"), note(2, "beta"), note(3, "gamma")];
    const raw = dream([e(1, "alpha"), e(2, "beta"), e(3, "gamma")], {
      overview: "o".repeat(500),
      gaps: ["g".repeat(150), "h".repeat(150)],
      conflicts: [{ a: 1, b: 2, about: "c".repeat(150) }],
    });
    const measure = (p: DreamPage): number =>
      entriesOf(p).length * 10 + p.overview.length + p.gaps.join("").length + p.conflicts.map((c) => c.about).join("").length;
    const r = validateDream(raw, tiny, 200, measure);
    expect(entriesOf(r.page).length).toBeGreaterThan(0);
    expect(r.page.gaps).toEqual([]);
    expect(r.stats.ratio).toBeLessThanOrEqual(0.35);
  });
});

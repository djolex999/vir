import { describe, expect, it } from "vitest";
import type { DistilledRow } from "../state/db.js";
import type { NoteStatus } from "../search/noteStatus.js";
import type { NoteUsage } from "../search/noteUsage.js";
import { noteRef } from "../pipeline/slug.js";
import { dreamInputHash, selectDreamNotes } from "./select.js";

const sid = (n: number): string => `abc1234${n}-0000-4000-8000-000000000001`;
const row = (n: number, over: Partial<DistilledRow> = {}): DistilledRow => ({
  path: `/p/-home-u-x/${sid(n)}.jsonl`,
  sessionId: sid(n),
  startedAt: `2026-10-0${n}T00:00:00.000Z`,
  category: "gotcha",
  topic: `topic ${n}`,
  project: "Pripremi.rs",
  confidence: 0.8,
  content: `content of note ${n}`,
  lesson: null,
  ...over,
});
const used = (surfaced: number): NoteUsage => ({ surfaced, top3: 0, lastSurfacedAt: "2026-11-01" });
const base = {
  flagged: new Set<string>(),
  isVerified: (): boolean => false,
  statusOf: (): NoteStatus => "unchecked",
  usage: new Map<string, NoteUsage>(),
  budgetTokens: 60_000,
};

describe("selectDreamNotes", () => {
  it("keeps only the project's notes, matching by kebab slug", () => {
    const s = selectDreamNotes([row(1), row(2, { project: "other" })], "pripremi-rs", base);
    expect(s.notes.map((n) => n.row.topic)).toEqual(["topic 1"]);
    expect(s.notes[0]?.index).toBe(1);
    expect(s.notes[0]?.ref).toBe(noteRef(row(1)));
  });

  it("leaves flagged notes out unless a human verified them", () => {
    const s = selectDreamNotes([row(1), row(2), row(3)], "pripremi-rs", {
      ...base,
      flagged: new Set([row(1).path, row(2).path]),
      isVerified: (r) => r.path === row(2).path,
    });
    expect(s.notes.map((n) => n.row.topic).sort()).toEqual(["topic 2", "topic 3"]);
    expect(s.excludedFlagged).toBe(1);
  });

  it("orders by retrieval, then confidence, then newest", () => {
    const rows = [
      row(1, { confidence: 0.9 }),
      row(2, { confidence: 0.5 }),
      row(3, { confidence: 0.5 }),
      row(4, { confidence: 0.1 }),
    ];
    const s = selectDreamNotes(rows, "pripremi-rs", {
      ...base,
      usage: new Map([[noteRef(rows[3]!), used(5)]]),
      statusOf: (r) => (r.topic === "topic 2" ? "verified" : "unchecked"),
    });
    expect(s.notes.map((n) => [n.index, n.row.topic])).toEqual([
      [1, "topic 4"],
      [2, "topic 1"],
      [3, "topic 3"],
      [4, "topic 2"],
    ]);
    expect(s.notes[0]?.surfaced).toBe(5);
    expect(s.notes[3]?.status).toBe("verified");
  });

  it("shortens notes past the token budget", () => {
    const long = "x".repeat(400);
    const rows = [
      row(1, { content: long, confidence: 0.9 }),
      row(2, { content: long, confidence: 0.8, lesson: "do the thing" }),
      row(3, { content: long, confidence: 0.7 }),
    ];
    const s = selectDreamNotes(rows, "pripremi-rs", { ...base, budgetTokens: 100 });
    expect(s.notes.map((n) => n.full)).toEqual([true, false, false]);
    expect(s.notes[1]?.text).toBe("topic 2: do the thing");
    expect(s.notes[2]?.text).toBe(`topic 3: ${long.slice(0, 300)}`);
    expect(s.sourceChars).toBe(1200);
  });
});

describe("dreamInputHash", () => {
  it("is stable across row order and changes when a status changes", () => {
    const pick = (rows: DistilledRow[], statusOf: (r: DistilledRow) => NoteStatus) =>
      selectDreamNotes(rows, "pripremi-rs", { ...base, statusOf }).notes;
    const a = dreamInputHash(pick([row(1), row(2)], () => "unchecked"));
    const b = dreamInputHash(pick([row(2), row(1)], () => "unchecked"));
    const c = dreamInputHash(pick([row(1), row(2)], (r) => (r.topic === "topic 1" ? "verified" : "unchecked")));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

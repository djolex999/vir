import { describe, expect, it } from "vitest";
import { makeRng } from "../rng.js";
import type { RetrievedHit } from "./types.js";
import { exposedTo, filterForCutoff, sampleSets, sessionIdFromNote } from "./select.js";

const hit = (sessionId: string | null, startedAt: string | null, title = sessionId ?? "topic"): RetrievedHit => ({
  filePath: `/v/${title}.md`, title, content: "c", score: 1, method: "embedding", sessionId, startedAt,
});
const Q = { sessionId: "q", cutoff: "2026-09-10T00:00:00.000Z" };

describe("filterForCutoff", () => {
  it("keeps earlier session notes in rank order, up to k", () => {
    const hits = [hit("a", "2026-09-01T00:00:00.000Z"), hit("b", "2026-09-02T00:00:00.000Z"), hit("c", "2026-09-03T00:00:00.000Z")];
    expect(filterForCutoff(hits, Q, 2).top.map((h) => h.sessionId)).toEqual(["a", "b"]);
  });

  // D5: the answer must not be sitting in a note written after the question.
  it("drops notes from the question's own session and from later or same-time sessions", () => {
    const hits = [
      hit("q", "2026-09-01T00:00:00.000Z"),
      hit("later", "2026-09-11T00:00:00.000Z"),
      hit("same", "2026-09-10T00:00:00.000Z"),
      hit("ok", "2026-09-09T00:00:00.000Z"),
    ];
    const r = filterForCutoff(hits, Q);
    expect(r.top.map((h) => h.sessionId)).toEqual(["ok"]);
    expect(r.droppedLeak).toBe(3);
  });

  // A topic page can summarize later sessions; articles/PDFs have no start time.
  it("drops non-session hits and hits with no start time", () => {
    const r = filterForCutoff([hit(null, null), hit("nodate", null), hit("ok", "2026-09-01T00:00:00.000Z")], Q);
    expect(r.top.map((h) => h.sessionId)).toEqual(["ok"]);
    expect(r.droppedNonSession).toBe(1);
    expect(r.droppedLeak).toBe(1);
  });
});

describe("exposedTo", () => {
  it("lists the rejects present in the top k", () => {
    const top = [hit("a", "x"), hit("r1", "x"), hit(null, null), hit("r2", "x")];
    expect(exposedTo(top, new Set(["r1", "r2", "r3"]))).toEqual(["r1", "r2"]);
  });
});

describe("sampleSets", () => {
  it("is stable for a seed", () => {
    const ex = Array.from({ length: 80 }, (_, i) => `e${i}`);
    const other = Array.from({ length: 50 }, (_, i) => `o${i}`);
    const a = sampleSets(ex, other, makeRng(7));
    const b = sampleSets(ex, other, makeRng(7));
    expect(a).toEqual(b);
    expect(a.exposed).toHaveLength(60);
    expect(a.control).toHaveLength(20);
  });

  // Never pad with synthetic questions: fewer than the cap means use them all.
  it("uses every exposed question when there are fewer than the cap", () => {
    expect(sampleSets(["e1", "e2"], ["o1"], makeRng(1)).exposed.sort()).toEqual(["e1", "e2"]);
  });
});

describe("sessionIdFromNote", () => {
  it("reads session_id from the frontmatter", () => {
    expect(sessionIdFromNote("---\ntopic: \"x\"\nsession_id: abc-123\n---\nbody")).toBe("abc-123");
  });
  it("returns null for notes without one (topics, articles, PDFs)", () => {
    expect(sessionIdFromNote("---\ntype: topic\n---\nbody\nsession_id: not-in-frontmatter")).toBeNull();
  });
});

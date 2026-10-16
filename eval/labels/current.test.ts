import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LabelRecord, LabelStore, QuerySet } from "../types.js";
import { labelStoreKey } from "../types.js";
import { assertPoolMatchesSet, currentLabels } from "./current.js";
import { contentHash, queryHash, rubricHash } from "./judge.js";
import { planJudgeCalls } from "./run.js";

const RUBRIC = "rubric v1";
const RH = rubricHash(RUBRIC);
const CREATED = "2026-10-01T00:00:00.000Z";

function set(texts: Record<string, string>, createdAt = CREATED): QuerySet {
  return {
    version: 1,
    seed: 1,
    createdAt,
    realCutoff: "2026-09-11T20:00:00Z",
    queries: Object.entries(texts).map(([id, text]) => ({ id, class: "identifier", text, sourceSlug: null })),
  };
}

function label(over: Partial<LabelRecord> & Pick<LabelRecord, "queryId" | "slug">): LabelRecord {
  return { contentHash: "h", grade: 2, model: "m", rubricHash: RH, ts: "2026-10-02T00:00:00.000Z", ...over };
}

function store(labels: LabelRecord[]): LabelStore {
  return { version: 1, labels: Object.fromEntries(labels.map((l, i) => [String(i), l])) };
}

describe("currentLabels", () => {
  it("drops a label whose query id now carries different text", () => {
    const s = set({ "identifier-1": "new query" });
    const stale = label({ queryId: "identifier-1", slug: "a", queryHash: queryHash("old query") });
    const fresh = label({ queryId: "identifier-1", slug: "b", queryHash: queryHash("new query") });
    expect(currentLabels(store([stale, fresh]), s, RH).map((l) => l.slug)).toEqual(["b"]);
  });

  it("keeps a legacy label (no queryHash) only if written after the set was created", () => {
    const s = set({ "identifier-1": "q" });
    const before = label({ queryId: "identifier-1", slug: "a", ts: "2026-09-30T23:59:59.999Z" });
    const after = label({ queryId: "identifier-1", slug: "b", ts: CREATED });
    expect(currentLabels(store([before, after]), s, RH).map((l) => l.slug)).toEqual(["b"]);
  });

  it("drops labels judged under another rubric and labels for queries not in the set", () => {
    const s = set({ "identifier-1": "q" });
    const otherRubric = label({ queryId: "identifier-1", slug: "a", queryHash: queryHash("q"), rubricHash: "zzz" });
    const gone = label({ queryId: "identifier-9", slug: "b", queryHash: queryHash("q") });
    expect(currentLabels(store([otherRubric, gone]), s, RH)).toEqual([]);
  });
});

describe("labelStoreKey", () => {
  it("separates the same id, slug and content under different query text", () => {
    expect(labelStoreKey("identifier-1", queryHash("a"), "s", "h")).not.toBe(labelStoreKey("identifier-1", queryHash("b"), "s", "h"));
  });
});

describe("assertPoolMatchesSet", () => {
  it("accepts a pool built from this set", () => {
    expect(() => assertPoolMatchesSet({ setCreatedAt: CREATED }, set({}))).not.toThrow();
  });

  it("refuses a pool built from another set, or one with no provenance", () => {
    expect(() => assertPoolMatchesSet({ setCreatedAt: "2026-09-11T20:59:07.687Z" }, set({}))).toThrow(/npm run eval -- pool/);
    expect(() => assertPoolMatchesSet({}, set({}))).toThrow(/npm run eval -- pool/);
  });
});

describe("planJudgeCalls after a query set rebuild", () => {
  let root: string | null = null;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("re-judges a pair whose query id was reused for new text", () => {
    root = mkdtempSync(join(tmpdir(), "vir-label-"));
    const raw = "---\ntitle: a\n---\nbody";
    writeFileSync(join(root, "a.md"), raw, "utf8");
    const pool = [{ queryId: "identifier-1", candidates: [{ slug: "a", seenIn: [{ arm: "tfidf", rank: 1 }] }] }];
    const oldLabel = label({ queryId: "identifier-1", slug: "a", contentHash: contentHash(raw), queryHash: queryHash("old text") });

    const rebuilt = planJudgeCalls(set({ "identifier-1": "new text" }), pool, store([oldLabel]), RUBRIC, root, 1);
    expect(rebuilt.skipped).toBe(0);
    expect(rebuilt.calls).toHaveLength(1);

    const same = planJudgeCalls(set({ "identifier-1": "old text" }), pool, store([oldLabel]), RUBRIC, root, 1);
    expect(same.skipped).toBe(1);
    expect(same.calls).toHaveLength(0);
  });
});

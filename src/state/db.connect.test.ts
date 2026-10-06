import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateDb } from "./db.js";

let dir: string;
let db: StateDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-db-connect-"));
  db = new StateDb(join(dir, "vir.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("lesson embedding cache", () => {
  it("round-trips a vector for its model only", () => {
    db.storeLessonEmbedding("h1", "nomic-embed-text", [0.5, -1, 2]);
    expect(db.getLessonEmbeddings(["h1", "h2"], "nomic-embed-text")).toEqual(
      new Map([["h1", [0.5, -1, 2]]]),
    );
    expect(db.getLessonEmbeddings(["h1"], "bge-small-en-v1.5").size).toBe(0);
  });

  it("upserts on (hash, model)", () => {
    db.storeLessonEmbedding("h1", "m", [1]);
    db.storeLessonEmbedding("h1", "m", [2]);
    expect(db.getLessonEmbeddings(["h1"], "m").get("h1")).toEqual([2]);
  });

  it("handles more hashes than one IN() chunk", () => {
    const hashes = Array.from({ length: 1200 }, (_, i) => `h${i}`);
    for (const h of hashes) db.storeLessonEmbedding(h, "m", [1]);
    expect(db.getLessonEmbeddings(hashes, "m").size).toBe(1200);
  });
});

describe("insights table", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "id-1", slug: "rule-id1", insightType: "recurring-rule" as const, status: "proposed" as const,
    promotion: "none" as const, scope: "project:growthq", rule: "R", why: "W",
    memberSessionIds: ["s1", "s2", "s3"], memberHashes: ["h1"], sources: ["a", "b"],
    evidence: [{ sessionId: "s1", citeSlug: "a", project: "growthq", date: "2026-01-01", quote: "q" }],
    sessions: 3, projects: ["growthq"], firstSeen: "2026-01-01", lastSeen: "2026-01-09",
    evidenceChanged: false, pending: null, model: "m", createdAt: "c", updatedAt: "u",
    ...over,
  });

  it("round-trips every field", () => {
    db.upsertInsight(row({ pending: [{ sessionId: "s4", citeSlug: "z", project: "", date: "d", quote: "p" }], evidenceChanged: true }));
    expect(db.getInsightBySlug("rule-id1")).toEqual(
      row({ pending: [{ sessionId: "s4", citeSlug: "z", project: "", date: "d", quote: "p" }], evidenceChanged: true }),
    );
    expect(db.listInsights()).toHaveLength(1);
    expect(db.getInsightBySlug("nope")).toBeNull();
  });

  it("upserts by id", () => {
    db.upsertInsight(row());
    db.upsertInsight(row({ status: "accepted" }));
    expect(db.listInsights().map((r) => r.status)).toEqual(["accepted"]);
  });

  it("serves embeddings for accepted insights only", () => {
    db.upsertInsight(row());
    db.upsertInsight(row({ id: "id-2", slug: "rule-id2", status: "accepted" }));
    db.setInsightEmbedding("id-1", [1, 0], { model: "m", dim: 2 });
    db.setInsightEmbedding("id-2", [0, 1], { model: "m", dim: 2 });
    const rows = db.getInsightEmbeddings("/vault/vir");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "id-2", category: "insight", filePath: "/vault/vir/insights/rules/rule-id2.md",
      embedding: [0, 1], embeddingModel: "m",
    });
  });
});

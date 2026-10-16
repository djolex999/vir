import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../search/provider.js";
import { StateDb } from "../state/db.js";
import { embedLessons } from "./embed.js";
import type { Lesson } from "./types.js";

let dir: string;
let db: StateDb;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-embed-lessons-"));
  db = new StateDb(join(dir, "vir.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function lesson(id: string, hash: string): Lesson {
  return {
    id, noteSlug: id, citeSlug: id, sessionId: id, noteDate: "2026-01-01", project: "p",
    category: "gotcha", itemIndex: 0, text: `text ${hash}`, contentHash: hash, archivedVia: null,
  };
}

function fakeProvider(): EmbeddingProvider & { calls: number } {
  const p = {
    name: "ollama" as const, modelName: "fake-model", dimensions: 2, maxInputChars: 1000, calls: 0,
    available: async () => true,
    embedDoc: async (text: string) => {
      p.calls += 1;
      return { embedding: [1, text.length], sentChars: text.length, truncated: false };
    },
    embedQuery: async () => [1, 0],
    provenance: () => ({ model: "fake-model", dim: 2 }),
  };
  return p;
}

describe("embedLessons", () => {
  it("embeds each distinct hash once and caches it", async () => {
    const provider = fakeProvider();
    const lessons = [lesson("a", "h1"), lesson("b", "h1"), lesson("c", "h2")];
    const first = await embedLessons(lessons, db, provider);
    expect(provider.calls).toBe(2);
    expect([...first.keys()].sort()).toEqual(["h1", "h2"]);
    await embedLessons(lessons, db, provider);
    expect(provider.calls).toBe(2);
  });

  it("stops the run when the provider fails mid-way, keeping what was cached", async () => {
    const provider = fakeProvider();
    let n = 0;
    const real = provider.embedDoc;
    provider.embedDoc = async (t: string) => {
      n += 1;
      if (n > 1) throw new Error("connection refused");
      return real(t);
    };
    await expect(embedLessons([lesson("a", "h1"), lesson("b", "h2")], db, provider)).rejects.toThrow(
      "embedding provider failed after 1 lesson(s) — nothing written: connection refused",
    );
    expect(db.getLessonEmbeddings(["h1"], "fake-model").size).toBe(1);
  });
});

describe("backfillInsightEmbeddings", () => {
  it("embeds accepted rules that are missing a current-model vector", async () => {
    const { backfillInsightEmbeddings } = await import("./embed.js");
    const { sampleInsight } = await import("./testFixtures.js");
    db.upsertInsight(sampleInsight({ status: "accepted" }));
    const provider = fakeProvider();
    const n = await backfillInsightEmbeddings(db, provider);
    expect(n).toBe(1);
    expect(db.listInsightEmbeddingTargets("fake-model")).toEqual([]);
    expect(await backfillInsightEmbeddings(db, provider)).toBe(0);
  });
});

describe("insightEmbedTargets (vir embed)", () => {
  const OTHER = "3f9a1c2e-0000-4000-8000-000000000001";

  it("without force: accepted rules with no vector or another model's vector", async () => {
    const { insightEmbedTargets } = await import("./embed.js");
    const { sampleInsight } = await import("./testFixtures.js");
    db.upsertInsight(sampleInsight({ status: "accepted" }));
    db.upsertInsight(sampleInsight({ id: OTHER, slug: "other-rule-3f9a1c2f", status: "proposed" }));
    expect(insightEmbedTargets(db, "bge-small-en-v1.5", false).map((t) => t.id)).toEqual([sampleInsight().id]);

    db.setInsightEmbedding(sampleInsight().id, [1, 0], { model: "nomic-embed-text", dim: 2 });
    // Model switch: a nomic vector is a target under bge, not under nomic.
    expect(insightEmbedTargets(db, "bge-small-en-v1.5", false)).toHaveLength(1);
    expect(insightEmbedTargets(db, "nomic-embed-text", false)).toEqual([]);
  });

  it("with force: every accepted rule, even one already on the active model", async () => {
    const { insightEmbedTargets } = await import("./embed.js");
    const { sampleInsight } = await import("./testFixtures.js");
    db.upsertInsight(sampleInsight({ status: "accepted" }));
    db.upsertInsight(sampleInsight({ id: OTHER, slug: "other-rule-3f9a1c2f", status: "rejected" }));
    db.setInsightEmbedding(sampleInsight().id, [1, 0], { model: "nomic-embed-text", dim: 2 });
    expect(insightEmbedTargets(db, "nomic-embed-text", true).map((t) => t.id)).toEqual([sampleInsight().id]);
  });

  it("embeds the same text the accept-time and sweep paths embed", async () => {
    const { insightEmbeddingText } = await import("./embed.js");
    expect(insightEmbeddingText({ rule: "Use proxy.ts", why: "middleware is deprecated" })).toBe("Use proxy.ts\nmiddleware is deprecated");
  });
});

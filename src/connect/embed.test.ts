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

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mmrRerank, search, type ScoredCandidate } from "./retriever.js";
import type { Config } from "../config.js";
import type { EmbeddingRow, StateDb } from "../state/db.js";

// Keep cosineSimilarity real (mmrRerank + searchByEmbedding need it); only force
// Ollama "up" and stub the query embedding so the test never touches the network.
vi.mock("./embedder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedder.js")>();
  return {
    ...actual,
    isOllamaAvailable: vi.fn(async () => true),
    embed: vi.fn(async () => [1, 0, 0]),
  };
});

function cand(docId: string, score: number, embedding: number[]): ScoredCandidate {
  return { docId, score, embedding, content: `content-${docId}` };
}

describe("mmrRerank", () => {
  // mmrRerank takes the standard MMR lambda (relevance weight); the config field
  // retrievalDiversity is the inverse (lambda = 1 - retrievalDiversity), mapped
  // at the call site. So λ=1.0 ⇔ retrievalDiversity=0.0 ⇔ pure relevance.
  it("λ=1.0 (retrievalDiversity=0.0, pure relevance) is a no-op: returns top-K by score", () => {
    const candidates = [
      cand("a", 0.9, [1, 0, 0]),
      cand("b", 0.8, [0, 1, 0]),
      cand("c", 0.7, [0, 0, 1]),
      cand("d", 0.6, [1, 1, 0]),
      cand("e", 0.5, [0, 1, 1]),
    ];
    const ranked = mmrRerank(candidates, 3, 1.0);
    expect(ranked.map((c) => c.docId)).toEqual(["a", "b", "c"]);
  });

  it("λ=0.0 (retrievalDiversity=1.0, pure diversity): top-scored first, then most dissimilar", () => {
    const candidates = [
      cand("a", 0.9, [1, 0, 0]),
      cand("b", 0.85, [1, 0, 0]), // identical to a
      cand("c", 0.8, [0, 1, 0]), // orthogonal to a
      cand("d", 0.75, [1, 0, 0]), // identical to a
      cand("e", 0.7, [0, 0, 1]), // orthogonal to a and c
    ];
    const ranked = mmrRerank(candidates, 3, 0.0);
    // First pick is pure relevance; the rest minimize similarity to the
    // already-selected set, so the near-duplicates of `a` are skipped.
    expect(ranked[0]?.docId).toBe("a");
    expect(ranked.map((c) => c.docId)).toEqual(["a", "c", "e"]);
  });

  it("identical candidates degenerate to score-only sort", () => {
    const emb = [1, 0, 0];
    const candidates = [
      cand("a", 0.9, emb),
      cand("b", 0.8, emb),
      cand("c", 0.7, emb),
      cand("d", 0.6, emb),
      cand("e", 0.5, emb),
    ];
    const ranked = mmrRerank(candidates, 3, 0.7);
    expect(ranked.map((c) => c.docId)).toEqual(["a", "b", "c"]);
  });

  it("topK=1 skips MMR and returns the single top-scored candidate", () => {
    const candidates = [
      cand("a", 0.6, [1, 0, 0]),
      cand("b", 0.9, [0, 1, 0]),
      cand("c", 0.7, [0, 0, 1]),
    ];
    const ranked = mmrRerank(candidates, 1, 0.7);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.docId).toBe("b");
  });

  it("fewer candidates than topK returns all (sorted by score)", () => {
    const candidates = [
      cand("a", 0.5, [1, 0, 0]),
      cand("b", 0.9, [0, 1, 0]),
      cand("c", 0.7, [0, 0, 1]),
    ];
    const ranked = mmrRerank(candidates, 5, 0.7);
    expect(ranked.map((c) => c.docId)).toEqual(["b", "c", "a"]);
  });

  it("empty candidate list returns empty", () => {
    expect(mmrRerank([], 5, 0.7)).toEqual([]);
  });
});

describe("search — topic embeddings are first-class in the pool", () => {
  const tmps: string[] = [];
  afterEach(() => {
    vi.clearAllMocks();
    for (const p of tmps) rmSync(p, { recursive: true, force: true });
    tmps.length = 0;
  });

  it("surfaces a topic note via the EMBEDDING path (not just TF-IDF)", async () => {
    // Empty vault dir → TF-IDF finds nothing; the topic note lives OUTSIDE it,
    // so the ONLY way it can surface is the embedding candidate pool.
    const vault = mkdtempSync(join(tmpdir(), "vir-vault-"));
    const noteHome = mkdtempSync(join(tmpdir(), "vir-topic-"));
    tmps.push(vault, noteHome);
    const topicPath = join(noteHome, "auth-flow-patterns.md");
    writeFileSync(
      topicPath,
      "---\ntype: topic\ntitle: Auth\nconfidence: 0.9\n---\n# Auth\n\nbody about auth flows",
    );

    const topicRow: EmbeddingRow = {
      sessionId: "auth-flow-patterns",
      topic: "Auth",
      category: "topic",
      project: "",
      filePath: topicPath,
      embedding: [1, 0, 0], // identical to the stubbed query vec → cosine 1.0
    };
    const db = {
      getEmbeddings: () => [],
      getArticleEmbeddings: () => [],
      getTopicEmbeddings: () => [topicRow],
    } as unknown as StateDb;
    const cfg = {
      vaultPath: vault,
      outputDir: "vir",
      topicsDir: "topics",
      retrievalDiversity: 0.3,
    } as unknown as Config;

    const hits = await search(cfg, db, "auth flow patterns", 5);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.method).toBe("embedding");
    expect(hits[0]?.filePath).toBe(topicPath);
  });
});

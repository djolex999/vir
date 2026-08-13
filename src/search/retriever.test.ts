import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIndex, mmrRerank, partitionByEmbeddingModel, search, searchTfIdf, searchWithOutcome, type ScoredCandidate } from "./retriever.js";
import type { Config } from "../config.js";
import type { EmbeddingRow, StateDb } from "../state/db.js";

import { embed, EmbedderError } from "./embedder.js";

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

// Hermetic: never let provider resolution see a real ~/.vir/embedder install
// on the machine running the tests.
vi.mock("./localProvider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./localProvider.js")>();
  return {
    ...actual,
    isLocalProviderInstalled: vi.fn(() => false),
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

describe("loadIndex — derived summaries never enter the TF-IDF index", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const p of tmps) rmSync(p, { recursive: true, force: true });
    tmps.length = 0;
  });

  it("walks category notes but excludes the summaries/ directory", () => {
    const vault = mkdtempSync(join(tmpdir(), "vir-idx-"));
    tmps.push(vault);
    mkdirSync(join(vault, "vir", "patterns"), { recursive: true });
    mkdirSync(join(vault, "vir", "summaries"), { recursive: true });
    writeFileSync(
      join(vault, "vir", "patterns", "widget-note.md"),
      "---\ntopic: widget\ncategory: pattern\n---\nA durable widget pattern.",
    );
    // A derived period summary that mentions the same term — it must NOT be
    // indexed, or it would surface as a "note" in the TF-IDF fallback.
    writeFileSync(
      join(vault, "vir", "summaries", "week-2026-W26.md"),
      "---\ntype: summary\n---\n# 2026-W26\n\nThis week covered the widget pattern.",
    );

    const cfg = { vaultPath: vault, outputDir: "vir" } as unknown as Config;
    const docs = loadIndex(cfg);
    const rels = docs.map((d) => d.relPath);

    expect(rels).toContain("patterns/widget-note.md");
    expect(rels.some((r) => r.startsWith("summaries/"))).toBe(false);
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
      embeddingModel: "nomic-embed-text",
      embeddingDim: 768,
    };
    const db = {
      getEmbeddings: () => [],
      getArticleEmbeddings: () => [],
      getTopicEmbeddings: () => [topicRow],
      getPdfEmbeddings: () => [],
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

  it("surfaces a pdf note via the EMBEDDING path (concatenated into the pool)", async () => {
    const vault = mkdtempSync(join(tmpdir(), "vir-vault-"));
    const noteHome = mkdtempSync(join(tmpdir(), "vir-pdf-"));
    tmps.push(vault, noteHome);
    const pdfPath = join(noteHome, "attention-is-all-you-need-abc12345.md");
    writeFileSync(
      pdfPath,
      "---\ntype: pdf\ncategory: paper\nsource_title: Attention\nconfidence: 0.9\n---\n# Attention\n\nbody about self-attention",
    );

    const pdfRow: EmbeddingRow = {
      sessionId: "attention-is-all-you-need-abc12345",
      topic: "Attention",
      category: "paper",
      project: "",
      filePath: pdfPath,
      embedding: [1, 0, 0], // identical to the stubbed query vec → cosine 1.0
      embeddingModel: "nomic-embed-text",
      embeddingDim: 768,
    };
    const db = {
      getEmbeddings: () => [],
      getArticleEmbeddings: () => [],
      getTopicEmbeddings: () => [],
      getPdfEmbeddings: () => [pdfRow],
    } as unknown as StateDb;
    const cfg = {
      vaultPath: vault,
      outputDir: "vir",
      topicsDir: "topics",
      retrievalDiversity: 0.3,
    } as unknown as Config;

    const hits = await search(cfg, db, "self attention", 5);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.method).toBe("embedding");
    expect(hits[0]?.filePath).toBe(pdfPath);
  });
});

describe("searchWithOutcome — embed failure degrades to TF-IDF, loudly", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const p of tmps) rmSync(p, { recursive: true, force: true });
    tmps.length = 0;
  });

  it("labels results tfidf, marks the set degraded, and records the embed error", async () => {
    const vault = mkdtempSync(join(tmpdir(), "vir-deg-"));
    tmps.push(vault);
    mkdirSync(join(vault, "vir", "patterns"), { recursive: true });
    writeFileSync(
      join(vault, "vir", "patterns", "widget-note.md"),
      "---\ntopic: widget\ncategory: pattern\n---\nA durable widget pattern.",
    );
    // A second doc without the term — with a single doc idf = log(1/1) = 0
    // and even a perfect lexical match scores zero.
    writeFileSync(
      join(vault, "vir", "patterns", "other-note.md"),
      "---\ntopic: other\ncategory: pattern\n---\nUnrelated gadget lore.",
    );
    vi.mocked(embed).mockRejectedValueOnce(
      new EmbedderError('Ollama 400: "nomic-embed-text" does not support generate'),
    );
    // embed() throws before any embedding row is read, so the db is never touched.
    const db = {} as unknown as StateDb;
    const cfg = {
      vaultPath: vault,
      outputDir: "vir",
      topicsDir: "topics",
      retrievalDiversity: 0.3,
    } as unknown as Config;

    const out = await searchWithOutcome(cfg, db, "widget", 5);

    expect(out.method).toBe("tfidf");
    expect(out.degraded).toBe(true);
    expect(out.embedError).toContain("400");
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.hits[0]?.method).toBe("tfidf");
  });

  it("a clean embedding miss (no error) falls back WITHOUT the degraded flag", async () => {
    const vault = mkdtempSync(join(tmpdir(), "vir-deg-"));
    tmps.push(vault);
    mkdirSync(join(vault, "vir", "patterns"), { recursive: true });
    writeFileSync(
      join(vault, "vir", "patterns", "widget-note.md"),
      "---\ntopic: widget\ncategory: pattern\n---\nA durable widget pattern.",
    );
    const db = {
      getEmbeddings: () => [],
      getArticleEmbeddings: () => [],
      getTopicEmbeddings: () => [],
      getPdfEmbeddings: () => [],
    } as unknown as StateDb;
    const cfg = {
      vaultPath: vault,
      outputDir: "vir",
      topicsDir: "topics",
      retrievalDiversity: 0.3,
    } as unknown as Config;

    const out = await searchWithOutcome(cfg, db, "widget", 5);

    expect(out.method).toBe("tfidf");
    expect(out.degraded).toBe(false);
    expect(out.embedError).toBeNull();
  });
});

describe("searchWithOutcome — candidates + provider provenance for the query log", () => {
  const tmps: string[] = [];
  afterEach(() => {
    vi.clearAllMocks();
    for (const p of tmps) rmSync(p, { recursive: true, force: true });
    tmps.length = 0;
  });

  it("embedding path reports the provider and how many rows passed the floor before topK", async () => {
    const vault = mkdtempSync(join(tmpdir(), "vir-cand-"));
    const noteHome = mkdtempSync(join(tmpdir(), "vir-cand-notes-"));
    tmps.push(vault, noteHome);
    const mkNote = (name: string): string => {
      const p = join(noteHome, `${name}.md`);
      writeFileSync(p, `---\ntopic: ${name}\n---\nbody of ${name}`);
      return p;
    };
    const row = (id: string, embedding: number[]): EmbeddingRow => ({
      sessionId: id,
      topic: id,
      category: "pattern",
      project: "",
      filePath: mkNote(id),
      embedding,
      embeddingModel: "nomic-embed-text",
      embeddingDim: 768,
    });
    const db = {
      // Query vec is stubbed to [1,0,0]: two rows above the 0.3 floor, one at
      // cosine 0 below it.
      getEmbeddings: () => [row("a", [1, 0, 0]), row("b", [0.8, 0.6, 0]), row("c", [0, 1, 0])],
      getArticleEmbeddings: () => [],
      getTopicEmbeddings: () => [],
      getPdfEmbeddings: () => [],
    } as unknown as StateDb;
    const cfg = {
      vaultPath: vault,
      outputDir: "vir",
      topicsDir: "topics",
      retrievalDiversity: 0.3,
    } as unknown as Config;

    const out = await searchWithOutcome(cfg, db, "anything", 1);

    expect(out.method).toBe("embedding");
    expect(out.hits).toHaveLength(1);
    // 2 passed the floor even though topK kept only 1.
    expect(out.candidates).toBe(2);
    expect(out.provider).toEqual({
      name: "ollama",
      model: "nomic-embed-text",
      dim: 768,
    });
  });

  it("tfidf fallback reports a null provider and its own pre-topK match count", async () => {
    const vault = mkdtempSync(join(tmpdir(), "vir-cand-"));
    tmps.push(vault);
    mkdirSync(join(vault, "vir", "patterns"), { recursive: true });
    writeFileSync(
      join(vault, "vir", "patterns", "widget-one.md"),
      "---\ntopic: w1\n---\nA durable widget pattern.",
    );
    writeFileSync(
      join(vault, "vir", "patterns", "widget-two.md"),
      "---\ntopic: w2\n---\nAnother widget writeup entirely.",
    );
    writeFileSync(
      join(vault, "vir", "patterns", "other.md"),
      "---\ntopic: other\n---\nUnrelated gadget lore.",
    );
    vi.mocked(embed).mockRejectedValueOnce(new EmbedderError("Ollama down"));
    const db = {} as unknown as StateDb;
    const cfg = {
      vaultPath: vault,
      outputDir: "vir",
      topicsDir: "topics",
      retrievalDiversity: 0.3,
    } as unknown as Config;

    const out = await searchWithOutcome(cfg, db, "widget", 1);

    expect(out.method).toBe("tfidf");
    expect(out.provider).toBeNull();
    expect(out.hits).toHaveLength(1);
    // Both widget docs matched lexically; topK kept one.
    expect(out.candidates).toBe(2);
  });
});

describe("loadIndex — rejected and archived notes never enter the TF-IDF index", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const p of tmps) rmSync(p, { recursive: true, force: true });
    tmps.length = 0;
  });

  it("excludes .rejected/ and archived/ from the walk", () => {
    const vault = mkdtempSync(join(tmpdir(), "vir-idx-"));
    tmps.push(vault);
    mkdirSync(join(vault, "vir", "patterns"), { recursive: true });
    mkdirSync(join(vault, "vir", ".rejected"), { recursive: true });
    mkdirSync(join(vault, "vir", "archived"), { recursive: true });
    writeFileSync(
      join(vault, "vir", "patterns", "live-note.md"),
      "---\ntopic: widget\ncategory: pattern\n---\nA live widget pattern.",
    );
    // A human explicitly rejected this knowledge via `vir review` — it must
    // never resurface through the TF-IDF fallback.
    writeFileSync(
      join(vault, "vir", ".rejected", "bad-note.md"),
      "---\ntopic: widget\nrejected_at: 2026-07-01\n---\nA rejected widget claim.",
    );
    // Dedupe archived this note as a duplicate; same rule.
    writeFileSync(
      join(vault, "vir", "archived", "dupe-note.md"),
      "---\ntopic: widget\n---\nAn archived duplicate widget note.",
    );

    const cfg = { vaultPath: vault, outputDir: "vir" } as unknown as Config;
    const rels = loadIndex(cfg).map((d) => d.relPath);

    expect(rels).toContain("patterns/live-note.md");
    expect(rels.some((r) => r.startsWith(".rejected/"))).toBe(false);
    expect(rels.some((r) => r.startsWith("archived/"))).toBe(false);
  });
});

describe("partitionByEmbeddingModel", () => {
  const mk = (model: string, dim: number, path: string): EmbeddingRow => ({
    sessionId: path,
    topic: "t",
    category: "pattern",
    project: "p",
    filePath: path,
    embedding: Array.from({ length: dim }, () => 0.1),
    embeddingModel: model,
    embeddingDim: dim,
  });

  it("refuses to compare vectors from a different model", () => {
    const rows = [
      mk("nomic-embed-text", 768, "/a.md"),
      mk("bge-small-en-v1.5", 384, "/b.md"),
      mk("nomic-embed-text", 768, "/c.md"),
    ];
    const { compatible, excluded } = partitionByEmbeddingModel(
      rows,
      "nomic-embed-text",
    );
    expect(compatible.map((r) => r.filePath)).toEqual(["/a.md", "/c.md"]);
    expect(excluded).toBe(1);
  });

  it("excludes everything when the active model matches nothing", () => {
    const rows = [mk("nomic-embed-text", 768, "/a.md")];
    const { compatible, excluded } = partitionByEmbeddingModel(
      rows,
      "bge-small-en-v1.5",
    );
    expect(compatible).toEqual([]);
    expect(excluded).toBe(1);
  });
});

describe("TF-IDF idf smoothing", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const p of tmps) rmSync(p, { recursive: true, force: true });
    tmps.length = 0;
  });

  it("a single-note vault returns that note for a term it contains", () => {
    const vault = mkdtempSync(join(tmpdir(), "vir-tfidf-"));
    tmps.push(vault);
    mkdirSync(join(vault, "vir", "decisions"), { recursive: true });
    writeFileSync(
      join(vault, "vir", "decisions", "only-note.md"),
      "---\ntopic: thesis-plan\n---\n\n## Summary\n\nDecided the thesis doubles as the launch material.\n",
    );
    const cfg = { vaultPath: vault, outputDir: "vir" } as unknown as Config;

    const docs = loadIndex(cfg);
    const hits = searchTfIdf(docs, "thesis launch");

    expect(docs).toHaveLength(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.relPath).toBe("decisions/only-note.md");
  });
});

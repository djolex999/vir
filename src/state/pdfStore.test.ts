import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_DISTILL_ATTEMPTS, StateDb } from "./db.js";

describe("StateDb — pdfs table", () => {
  let dir: string;
  let db: StateDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-pdfdb-"));
    db = new StateDb(join(dir, "vir.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function recordDistilled(over: Partial<Parameters<StateDb["recordPdf"]>[0]> = {}) {
    db.recordPdf({
      path: "/papers/attention.pdf",
      hash: "h1",
      skipped: false,
      notePath: "/vault/vir/pdfs/attention-abc12345.md",
      content: "distilled pdf body about self-attention",
      category: "paper",
      title: "Attention Is All You Need",
      pages: 11,
      confidence: 0.92,
      distilledAt: "2026-06-26T00:00:00Z",
      ...over,
    });
  }

  it("records and reads back a distilled pdf", () => {
    recordDistilled();
    const rows = db.listPdfs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: "/papers/attention.pdf",
      notePath: "/vault/vir/pdfs/attention-abc12345.md",
      title: "Attention Is All You Need",
      category: "paper",
      pages: 11,
      confidence: 0.92,
      content: "distilled pdf body about self-attention",
    });
  });

  it("isPdfProcessed matches on path + hash for a clean row", () => {
    recordDistilled();
    expect(db.isPdfProcessed("/papers/attention.pdf", "h1")).toBe(true);
    expect(db.isPdfProcessed("/papers/attention.pdf", "h2")).toBe(false);
    expect(db.isPdfProcessed("/papers/other.pdf", "h1")).toBe(false);
  });

  it("an errored row is not processed, so the same bytes are retried", () => {
    db.recordPdf({ path: "/papers/bad.pdf", hash: "hb", skipped: false, error: "parse failed" });
    expect(db.isPdfProcessed("/papers/bad.pdf", "hb")).toBe(false);

    db.recordPdf({ path: "/papers/bad.pdf", hash: "hb", skipped: false, notePath: "/vault/vir/pdfs/bad.md" });
    expect(db.isPdfProcessed("/papers/bad.pdf", "hb")).toBe(true);
  });

  it("a skipped row stays processed (skip is final for those bytes)", () => {
    db.recordPdf({ path: "/papers/empty.pdf", hash: "z", skipped: true });
    expect(db.isPdfProcessed("/papers/empty.pdf", "z")).toBe(true);
  });

  it(`stops retrying the same bytes after ${MAX_DISTILL_ATTEMPTS} consecutive errors; a changed file starts over`, () => {
    for (let i = 1; i < MAX_DISTILL_ATTEMPTS; i++) {
      db.recordPdf({ path: "/papers/bad.pdf", hash: "hb", skipped: false, error: "parse failed" });
      expect(db.isPdfProcessed("/papers/bad.pdf", "hb")).toBe(false);
    }
    db.recordPdf({ path: "/papers/bad.pdf", hash: "hb", skipped: false, error: "parse failed" });
    expect(db.isPdfProcessed("/papers/bad.pdf", "hb")).toBe(true);

    db.recordPdf({ path: "/papers/bad.pdf", hash: "hb2", skipped: false, error: "parse failed" });
    expect(db.isPdfProcessed("/papers/bad.pdf", "hb2")).toBe(false);
  });

  it("excludes skipped pdfs from listPdfs", () => {
    db.recordPdf({ path: "/papers/empty.pdf", hash: "z", skipped: true });
    expect(db.listPdfs()).toEqual([]);
  });

  it("flows a pdf through the embedding target → store → getPdfEmbeddings cycle", () => {
    recordDistilled();
    // Before embedding: it's a target, and getPdfEmbeddings is empty.
    const targets = db.listPdfEmbeddingTargets();
    expect(targets.map((t) => t.path)).toEqual(["/papers/attention.pdf"]);
    expect(db.getPdfEmbeddings()).toEqual([]);

    db.storePdfEmbedding("/papers/attention.pdf", [0.1, 0.2, 0.3], { model: "nomic-embed-text", dim: 768 });

    // After embedding: no longer a target, and it surfaces in getPdfEmbeddings.
    expect(db.listPdfEmbeddingTargets()).toEqual([]);
    const embs = db.getPdfEmbeddings();
    expect(embs).toHaveLength(1);
    expect(embs[0]).toMatchObject({
      topic: "Attention Is All You Need",
      category: "paper",
      project: "",
      filePath: "/vault/vir/pdfs/attention-abc12345.md",
      embedding: [0.1, 0.2, 0.3],
    });
  });

  it("re-recording the same path updates the hash (idempotent overwrite)", () => {
    recordDistilled();
    recordDistilled({ hash: "h2", content: "re-extracted body" });
    expect(db.isPdfProcessed("/papers/attention.pdf", "h2")).toBe(true);
    expect(db.listPdfs()).toHaveLength(1);
    expect(db.listPdfs()[0]!.content).toBe("re-extracted body");
  });
});

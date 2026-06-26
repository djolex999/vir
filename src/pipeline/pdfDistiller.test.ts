import { describe, expect, it } from "vitest";
import type { ParsedPdf } from "./pdfReader.js";
import {
  PDF_CATEGORIES,
  buildPdfFrontmatter,
  parsePdfClassification,
  pdfRelPath,
  pdfSlug,
  type DistilledPdf,
} from "./pdfDistiller.js";

const PDF: ParsedPdf = {
  filePath: "/papers/attention-is-all-you-need.pdf",
  hash: "a".repeat(64),
  title: "Attention Is All You Need",
  text: "The Transformer architecture relies entirely on self-attention.",
  pageCount: 11,
};

const DISTILLED: DistilledPdf = {
  classification: { category: "paper", confidence: 0.92 },
  markdown: "## Summary\n\nTransformers drop recurrence for self-attention.\n",
};

describe("parsePdfClassification", () => {
  it("parses a valid pdf category", () => {
    const r = parsePdfClassification('{"category": "reference", "confidence": 0.7}');
    expect(r.category).toBe("reference");
    expect(r.confidence).toBeCloseTo(0.7);
  });

  it("only ever returns one of the pdf categories", () => {
    for (const cat of PDF_CATEGORIES) {
      expect(parsePdfClassification(`{"category": "${cat}"}`).category).toBe(cat);
    }
    // article/session categories are not valid for pdfs → fall back
    const bad = parsePdfClassification('{"category": "concept"}');
    expect(PDF_CATEGORIES).toContain(bad.category);
  });

  it("falls back to a valid category ('other') on garbage input", () => {
    const r = parsePdfClassification("not json");
    expect(PDF_CATEGORIES).toContain(r.category);
    expect(r.category).toBe("other");
    expect(r.confidence).toBe(0);
  });

  it("clamps confidence to [0,1]", () => {
    expect(parsePdfClassification('{"category":"paper","confidence":9}').confidence).toBe(1);
    expect(parsePdfClassification('{"category":"paper","confidence":-4}').confidence).toBe(0);
  });
});

describe("buildPdfFrontmatter", () => {
  it("includes type, category, source_path, source_title, pages, confidence, hash", () => {
    const fm = buildPdfFrontmatter(PDF, DISTILLED);
    expect(fm).toMatch(/^---\n/);
    expect(fm).toContain("type: pdf");
    expect(fm).toContain("category: paper");
    expect(fm).toContain("source_path: /papers/attention-is-all-you-need.pdf");
    expect(fm).toContain('source_title: "Attention Is All You Need"');
    expect(fm).toContain("pages: 11");
    expect(fm).toContain("confidence: 0.92");
    expect(fm).toContain(`hash: ${"a".repeat(64)}`);
    expect(fm.endsWith("---\n\n") || fm.endsWith("---\n")).toBe(true);
  });

  it("escapes quotes in the title", () => {
    const fm = buildPdfFrontmatter(
      { ...PDF, title: 'A "Quoted" Paper' },
      DISTILLED,
    );
    expect(fm).toContain('source_title: "A \\"Quoted\\" Paper"');
  });
});

describe("pdfSlug / pdfRelPath", () => {
  it("files notes under the pdfs/ subdirectory", () => {
    expect(pdfRelPath(PDF)).toMatch(/^pdfs\//);
    expect(pdfRelPath(PDF).endsWith(".md")).toBe(true);
  });

  it("derives a kebab slug from the title", () => {
    expect(pdfSlug(PDF)).toContain("attention-is-all-you-need");
  });

  it("is stable for the same source path across content edits (not keyed on content hash)", () => {
    const reExtracted: ParsedPdf = { ...PDF, hash: "b".repeat(64), text: "x" };
    expect(pdfSlug(reExtracted)).toBe(pdfSlug(PDF));
  });

  it("differs when the source path differs", () => {
    expect(pdfSlug({ ...PDF, filePath: "/other/attention.pdf" })).not.toBe(
      pdfSlug(PDF),
    );
  });
});

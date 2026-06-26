import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parsePdf, pdfTitle, scanPdfs } from "./pdfReader.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/sample.pdf", import.meta.url));

describe("pdfTitle", () => {
  it("prefers a non-empty metadata title", () => {
    expect(pdfTitle("Attention Is All You Need", "/x/whatever.pdf")).toBe(
      "Attention Is All You Need",
    );
  });

  it("falls back to the filename (no extension) when metadata title is missing", () => {
    expect(pdfTitle(undefined, "/papers/Deep Residual Learning.pdf")).toBe(
      "Deep Residual Learning",
    );
  });

  it("falls back to the filename when metadata title is blank", () => {
    expect(pdfTitle("   ", "/papers/foo.pdf")).toBe("foo");
  });

  it("trims a metadata title", () => {
    expect(pdfTitle("  Spaced Title  ", "/x/y.pdf")).toBe("Spaced Title");
  });
});

describe("parsePdf", () => {
  it("extracts text, title from metadata, page count, and a byte hash", async () => {
    const parsed = await parsePdf(FIXTURE);
    expect(parsed.title).toBe("RAG Grounding Notes");
    expect(parsed.text).toContain("Retrieval augmented generation");
    expect(parsed.pageCount).toBe(1);
    expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.filePath).toBe(FIXTURE);
  });

  it("hashes the raw bytes (matches an independent SHA-256)", async () => {
    const expected = createHash("sha256")
      .update(readFileSync(FIXTURE))
      .digest("hex");
    const parsed = await parsePdf(FIXTURE);
    expect(parsed.hash).toBe(expected);
  });

  it("rejects on corrupt / non-PDF bytes (the run layer records + skips, never crashes)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vir-pdf-bad-"));
    try {
      const bad = join(dir, "broken.pdf");
      writeFileSync(bad, "this is not a pdf at all");
      await expect(parsePdf(bad)).rejects.toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scanPdfs", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const p of tmps) rmSync(p, { recursive: true, force: true });
    tmps.length = 0;
  });

  it("walks .pdf files (cheap: path + byte hash), skipping non-pdfs", () => {
    const dir = mkdtempSync(join(tmpdir(), "vir-pdf-scan-"));
    tmps.push(dir);
    copyFileSync(FIXTURE, join(dir, "paper.pdf"));
    writeFileSync(join(dir, "notes.txt"), "not a pdf");
    writeFileSync(join(dir, "README.md"), "# nope");

    const found = scanPdfs(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.filePath).toBe(join(dir, "paper.pdf"));
    expect(found[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a hash consistent with parsePdf for the same bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vir-pdf-scan2-"));
    tmps.push(dir);
    const p = join(dir, "paper.pdf");
    copyFileSync(FIXTURE, p);
    const scanned = scanPdfs(dir).find((s) => s.filePath === p)!;
    const parsed = await parsePdf(p);
    expect(scanned.hash).toBe(parsed.hash);
  });

  it("returns an empty array for a missing directory", () => {
    expect(scanPdfs(join(dirname(FIXTURE), "does-not-exist-xyz"))).toEqual([]);
  });
});

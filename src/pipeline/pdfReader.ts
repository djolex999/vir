import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";

// The third input source: PDFs / papers. Architecturally identical to articles
// (own reader → copyright-bounded distiller → own SQLite table → same vector
// space). The only structural difference from articleReader is that text
// extraction is *expensive* (pdf.js), so the scan/parse split is inverted:
// scanPdfs returns cheap {path, hash} entries and the run loop only calls the
// heavy parsePdf for files that aren't already processed — instead of parsing
// the whole directory up front like scanArticles does for cheap .md reads.

export interface ParsedPdf {
  filePath: string;
  hash: string; // SHA-256 of raw bytes
  title: string; // from metadata Title, else filename
  text: string; // extracted text, pages merged
  pageCount: number;
}

// Cheap scan result — bytes hashed for idempotency, no text extraction yet.
export interface PdfSource {
  filePath: string;
  hash: string;
}

export async function parsePdf(filePath: string): Promise<ParsedPdf> {
  const bytes = readFileSync(filePath);
  const hash = createHash("sha256").update(bytes).digest("hex");

  // unpdf bundles pdf.js; getDocumentProxy throws on corrupt/non-PDF bytes,
  // which the run layer catches per-file and records (never crashes the run).
  const proxy = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(proxy, { mergePages: true });
  const metaTitle = await readMetadataTitle(proxy);

  return {
    filePath,
    hash,
    title: pdfTitle(metaTitle, filePath),
    text: Array.isArray(text) ? text.join("\n") : text,
    pageCount: totalPages,
  };
}

export function scanPdfs(dir: string): PdfSource[] {
  const files: string[] = [];
  walk(dir, files);
  const out: PdfSource[] = [];
  for (const f of files) {
    try {
      const hash = createHash("sha256").update(readFileSync(f)).digest("hex");
      out.push({ filePath: f, hash });
    } catch {
      // unreadable / mid-write file — skip, never fail the whole scan
    }
  }
  return out;
}

// Pure: metadata Title wins when non-blank; otherwise the filename (sans .pdf).
export function pdfTitle(metaTitle: string | undefined, filePath: string): string {
  const t = (metaTitle ?? "").trim();
  if (t.length > 0) return t;
  return basename(filePath).replace(/\.pdf$/i, "");
}

async function readMetadataTitle(
  proxy: Awaited<ReturnType<typeof getDocumentProxy>>,
): Promise<string | undefined> {
  try {
    const meta = (await proxy.getMetadata()) as {
      info?: { Title?: unknown };
    };
    const title = meta?.info?.Title;
    return typeof title === "string" ? title : undefined;
  } catch {
    return undefined;
  }
}

function walk(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, acc);
    else if (st.isFile() && name.toLowerCase().endsWith(".pdf")) acc.push(full);
  }
}

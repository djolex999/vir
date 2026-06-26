import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Config } from "../config.js";
import {
  callLLM,
  maybeAnthropicClient,
  normalizeModelName,
  withRateLimitRetry,
} from "./distiller.js";
import type { ParsedPdf } from "./pdfReader.js";
import { scrub } from "./scrubber.js";

// PDFs use their own small taxonomy — distinct from the session
// (pattern/gotcha/decision/tool) and article (concept/technique/…) sets.
export type PdfCategory = "paper" | "reference" | "notes" | "other";

export const PDF_CATEGORIES: PdfCategory[] = [
  "paper",
  "reference",
  "notes",
  "other",
];

// Neutral fallback when the model returns an unrecognized category: "other"
// claims the least about the document's intent.
const DEFAULT_PDF_CATEGORY: PdfCategory = "other";

export const PDFS_SUBDIR = "pdfs";

// Papers are long → bound the distill input so a single paper can't blow up
// token cost (hybrid routing would otherwise push it to Sonnet on size).
// Mirrors articleDistiller's 24k-char bound.
const CLASSIFY_EXCERPT_CHARS = 3000;
const MAX_BODY_CHARS = 24_000;

export interface PdfClassification {
  category: PdfCategory;
  confidence: number;
}

export interface DistilledPdf {
  classification: PdfClassification;
  markdown: string;
}

export async function distillPdf(
  parsed: ParsedPdf,
  cfg: Config,
): Promise<DistilledPdf | null> {
  const client = maybeAnthropicClient(cfg);
  const classifyModel = normalizeModelName(cfg.models.classify, cfg.provider);
  const distillModel = normalizeModelName(cfg.models.distill, cfg.provider);

  // Extracted text still flows to a provider — scrub keys/paths/emails.
  const body = scrub(parsed.text).slice(0, MAX_BODY_CHARS);
  if (body.trim().length === 0) return null;

  const clsText = await withRateLimitRetry(() =>
    callLLM(cfg, client, {
      prompt: classifyPrompt(parsed, body),
      model: classifyModel,
      maxTokens: 200,
      cost: { stage: "pdf-classify" },
    }),
  );
  const classification = parsePdfClassification(clsText);

  const markdown = (
    await withRateLimitRetry(() =>
      callLLM(cfg, client, {
        prompt: distillPrompt(parsed, body),
        model: distillModel,
        maxTokens: 1500,
        cost: { stage: "pdf-distill" },
      }),
    )
  ).trim();
  if (markdown.length === 0) return null;

  return { classification, markdown };
}

function classifyPrompt(parsed: ParsedPdf, body: string): string {
  return `Classify this PDF document into exactly one category. Output JSON only:
{ "category": "paper" | "reference" | "notes" | "other",
  "confidence": number (0..1) }

paper     = a research/academic paper (abstract, methods, results, contributions)
reference = documentation, a spec, manual, datasheet, or material to look up later
notes     = lecture notes, slides, a course handout, or personal study notes
other     = anything that doesn't fit the above

Title: ${parsed.title}

${body.slice(0, CLASSIFY_EXCERPT_CHARS)}`;
}

function distillPrompt(parsed: ParsedPdf, body: string): string {
  return `Distill this PDF document into a durable knowledge note. Output markdown
only — no preamble, start with '## Summary'. Use these sections:

- ## Summary (2-3 sentences, in your own words)
- ## Key Points (bullet list: the main claims, findings, methods, or arguments)
- ## Methods & Findings (for a paper: the approach and what it concluded; omit
  this section entirely if the document isn't a study)
- ## Related (plain-English topics this connects to, one per bullet — these get
  turned into wikilinks automatically, so write them as short noun phrases)

COPYRIGHT — strict: this is someone else's IP. Never reproduce more than 15
consecutive words verbatim from the source. Paraphrase everything in your own
words. Do not reproduce figures, tables, equations, or full passages. Summarize
and cite by context, never quote at length.

Title: ${parsed.title}
Source: ${parsed.filePath}
Document:
${body}`;
}

export function parsePdfClassification(text: string): PdfClassification {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { category: DEFAULT_PDF_CATEGORY, confidence: 0 };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return { category: DEFAULT_PDF_CATEGORY, confidence: 0 };
  }
  const rawCat = typeof obj.category === "string" ? obj.category : "";
  const category = (PDF_CATEGORIES as string[]).includes(rawCat)
    ? (rawCat as PdfCategory)
    : DEFAULT_PDF_CATEGORY;
  const confRaw =
    typeof obj.confidence === "number"
      ? obj.confidence
      : Number(obj.confidence ?? 0);
  const confidence = Number.isFinite(confRaw)
    ? Math.max(0, Math.min(1, confRaw))
    : 0;
  return { category, confidence };
}

// Stable across content edits: a re-extracted PDF (new hash/text) keeps the same
// slug as long as its source path is unchanged, so a re-distill overwrites the
// same note instead of orphaning the old one (mirrors articleSlug, keyed off the
// source path rather than the content hash).
export function pdfSlug(parsed: ParsedPdf): string {
  const base = kebab(parsed.title).slice(0, 60);
  const suffix = createHash("sha256")
    .update(parsed.filePath)
    .digest("hex")
    .slice(0, 8);
  return base.length > 0 ? `${base}-${suffix}` : `pdf-${suffix}`;
}

export function pdfRelPath(parsed: ParsedPdf): string {
  return join(PDFS_SUBDIR, `${pdfSlug(parsed)}.md`);
}

export function buildPdfFrontmatter(
  parsed: ParsedPdf,
  distilled: DistilledPdf,
): string {
  const lines = ["---", "type: pdf"];
  lines.push(`category: ${distilled.classification.category}`);
  lines.push(`source_path: ${parsed.filePath}`);
  lines.push(`source_title: "${escapeYaml(parsed.title)}"`);
  lines.push(`pages: ${parsed.pageCount}`);
  lines.push(`distilled_at: ${new Date().toISOString()}`);
  lines.push(`confidence: ${distilled.classification.confidence}`);
  lines.push(`hash: ${parsed.hash}`);
  lines.push("---", "");
  return lines.join("\n");
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"');
}

// Local copy of writer.kebab() — writer.ts depends on this module, so importing
// from it would create a cycle (mirrors articleDistiller.kebab).
function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

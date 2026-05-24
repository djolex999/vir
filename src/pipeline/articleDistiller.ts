import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Config } from "../config.js";
import {
  callLLM,
  maybeAnthropicClient,
  normalizeModelName,
  withRateLimitRetry,
} from "./distiller.js";
import type { ParsedArticle } from "./articleReader.js";
import { scrub } from "./scrubber.js";

// Articles use a different taxonomy from Claude Code sessions
// (pattern/gotcha/decision/tool are dev-session concepts).
export type ArticleCategory = "concept" | "technique" | "reference" | "opinion";

export const ARTICLE_CATEGORIES: ArticleCategory[] = [
  "concept",
  "technique",
  "reference",
  "opinion",
];

// Neutral fallback when the model returns an unrecognized/garbled category:
// "reference" claims the least about the article's intent.
const DEFAULT_ARTICLE_CATEGORY: ArticleCategory = "reference";

export const ARTICLES_SUBDIR = "articles";

// Distillation prompts are bounded: huge articles would otherwise blow up token
// cost. Classification only needs the lead; distillation gets a generous cap.
const CLASSIFY_EXCERPT_CHARS = 3000;
const MAX_BODY_CHARS = 24_000;

export interface ArticleClassification {
  category: ArticleCategory;
  confidence: number;
}

export interface DistilledArticle {
  classification: ArticleClassification;
  markdown: string;
}

export async function distillArticle(
  article: ParsedArticle,
  cfg: Config,
): Promise<DistilledArticle | null> {
  const client = maybeAnthropicClient(cfg);
  const classifyModel = normalizeModelName(cfg.models.classify, cfg.provider);
  const distillModel = normalizeModelName(cfg.models.distill, cfg.provider);

  // Public web content still flows to a provider — scrub keys/paths/emails.
  const body = scrub(article.body).slice(0, MAX_BODY_CHARS);
  if (body.trim().length === 0) return null;

  const clsText = await withRateLimitRetry(() =>
    callLLM(cfg, client, {
      prompt: classifyPrompt(article, body),
      model: classifyModel,
      maxTokens: 200,
    }),
  );
  const classification = parseArticleClassification(clsText);

  const markdown = (
    await withRateLimitRetry(() =>
      callLLM(cfg, client, {
        prompt: distillPrompt(article, body),
        model: distillModel,
        maxTokens: 1500,
      }),
    )
  ).trim();
  if (markdown.length === 0) return null;

  return { classification, markdown };
}

function classifyPrompt(article: ParsedArticle, body: string): string {
  return `Classify this web article into exactly one category. Output JSON only:
{ "category": "concept" | "technique" | "reference" | "opinion",
  "confidence": number (0..1) }

concept   = explains an idea, mental model, or way of thinking
technique = a concrete method, how-to, practice, or workflow
reference = facts, documentation, specs, or data to look up later
opinion   = an argument, take, prediction, or persuasive essay

Title: ${article.title}

${body.slice(0, CLASSIFY_EXCERPT_CHARS)}`;
}

function distillPrompt(article: ParsedArticle, body: string): string {
  const sourceLine = article.url ? `Source: ${article.url}\n` : "";
  return `Distill this web article into a durable knowledge note. Output markdown
only — no preamble, start with '## Summary'. Use these sections:

- ## Summary (2-3 sentences, in your own words)
- ## Key Points (bullet list: the main claims, findings, methods, or arguments)
- ## Notable Quotes (at most one short quote per key point; omit this section
  entirely if nothing is genuinely quote-worthy)
- ## Related (plain-English topics this connects to, one per bullet — these get
  turned into wikilinks automatically, so write them as short noun phrases)

COPYRIGHT — strict: never reproduce more than 15 consecutive words verbatim from
the source. Paraphrase everything else in your own words. Quotes must be short
and attributed by context, never full passages.

Title: ${article.title}
${sourceLine}
Article:
${body}`;
}

export function parseArticleClassification(text: string): ArticleClassification {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { category: DEFAULT_ARTICLE_CATEGORY, confidence: 0 };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return { category: DEFAULT_ARTICLE_CATEGORY, confidence: 0 };
  }
  const rawCat = typeof obj.category === "string" ? obj.category : "";
  const category = (ARTICLE_CATEGORIES as string[]).includes(rawCat)
    ? (rawCat as ArticleCategory)
    : DEFAULT_ARTICLE_CATEGORY;
  const confRaw =
    typeof obj.confidence === "number"
      ? obj.confidence
      : Number(obj.confidence ?? 0);
  const confidence = Number.isFinite(confRaw)
    ? Math.max(0, Math.min(1, confRaw))
    : 0;
  return { category, confidence };
}

// Stable across content edits: a re-clipped article (new hash/body) keeps the
// same slug as long as its source URL (or file path) is unchanged, so a
// re-distill overwrites the same note instead of orphaning the old one.
export function articleSlug(article: ParsedArticle): string {
  const base = kebab(article.title).slice(0, 60);
  const stableId = article.url ?? article.filePath;
  const suffix = createHash("sha256").update(stableId).digest("hex").slice(0, 8);
  return base.length > 0 ? `${base}-${suffix}` : `article-${suffix}`;
}

export function articleRelPath(article: ParsedArticle): string {
  return join(ARTICLES_SUBDIR, `${articleSlug(article)}.md`);
}

export function buildArticleFrontmatter(
  article: ParsedArticle,
  distilled: DistilledArticle,
): string {
  const lines = ["---", "type: article"];
  lines.push(`category: ${distilled.classification.category}`);
  if (article.url) lines.push(`source_url: ${article.url}`);
  lines.push(`source_title: "${escapeYaml(article.title)}"`);
  if (article.author) lines.push(`source_author: "${escapeYaml(article.author)}"`);
  if (article.publishedAt) lines.push(`source_published: ${article.publishedAt}`);
  lines.push(`distilled_at: ${new Date().toISOString()}`);
  lines.push(`confidence: ${distilled.classification.confidence}`);
  lines.push(`hash: ${article.hash}`);
  if (article.tags.length > 0) lines.push(`tags: [${article.tags.join(", ")}]`);
  lines.push("---", "");
  return lines.join("\n");
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"');
}

// Local copy of writer.kebab() — writer.ts depends on this module, so importing
// from it would create a cycle (mirrors db.ts's kebabLite).
function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

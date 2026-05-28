import { basename, join, relative } from "node:path";
import type { Config } from "../config.js";
import type { StateDb } from "../state/db.js";
import { search, vaultRoot } from "../search/retriever.js";
import {
  callLLM,
  maybeAnthropicClient,
  normalizeModelName,
  resolveModelShorthand,
  withRateLimitRetry,
} from "./distiller.js";
// Type-only — erased at compile time, so no runtime import cycle with writer.ts
// (which imports this module's builders at runtime).
import type { VaultWriter } from "./writer.js";

export const TOPICS_SUBDIR = "topics";

// Output cap for the synthesis call. Calibration medians ran ~4500 output
// tokens for distill-class work; topic synthesis is comparable, with headroom.
const COMPOSE_MAX_TOKENS = 6000;

// A vault note selected as raw material for a synthesized topic page. `slug` is
// the note's bare basename (no extension) — Obsidian resolves `[[slug]]` to it
// by filename, which is what backlinks the sources into the topic's graph.
export interface SourceNote {
  slug: string;
  title: string;
  content: string;
  score: number;
}

// A fully synthesized topic page ready to be filed by VaultWriter.writeTopic.
export interface ComposedTopic {
  slug: string;
  title: string;
  topicQuery: string;
  content: string;
  confidence: number;
  model: string;
  sources: SourceNote[];
  createdAt: string;
  updatedAt: string;
}

export interface ComposeResult {
  notePath: string;
  relPath: string;
  slug: string;
  title: string;
  confidence: number;
  sourceCount: number;
}

// ── pure builders (unit-tested in composer.test.ts) ──────────────────────────

// Slug is keyed off the topic text alone (no hash suffix): the topic IS the
// identity, so re-composing the same topic overwrites the same note.
export function composeSlug(topic: string): string {
  const base = kebab(topic).slice(0, 60).replace(/-+$/, "");
  return base.length > 0 ? base : "topic";
}

export function composeRelPath(slug: string, dir: string = TOPICS_SUBDIR): string {
  return join(dir, `${slug}.md`);
}

// Synthesis prompt. The model never writes the Sources section or the page H1 —
// we generate those deterministically from the real source slugs so wikilinks
// always resolve. It emits two parseable markers (TITLE/CONFIDENCE) then the body.
export function buildComposePrompt(topic: string, sources: SourceNote[]): string {
  const blocks = sources
    .map((s, i) => `### Source ${i + 1}: ${s.title}\n${stripFrontmatter(s.content).trim()}`)
    .join("\n\n---\n\n");

  return `You are synthesizing a topic page for a personal knowledge base from the distilled notes below. Weave the notes into one coherent reference on the topic — group related ideas, reconcile overlaps, and surface the durable lessons. Use only what the notes contain; do not invent facts.

Topic: ${topic}

Output format — exactly this, nothing before it:
TITLE: <a concise title for the topic page>
CONFIDENCE: <0..1, how well the notes actually cover this topic>

<the synthesized body in markdown, using ## section headers>

Rules:
- Do NOT write a top-level "# " title — the TITLE line above is the page title.
- Do NOT write a Sources section — sources are appended automatically.
- Be specific and cite concrete techniques/decisions; omit filler.

Notes:
${blocks}`;
}

// Parse the TITLE/CONFIDENCE markers off the top, returning the remaining
// markdown as content. Tolerant: missing markers yield "" / 0, and a redundant
// leading H1 (in case the model ignored the rule) is stripped so the writer's
// own page title isn't duplicated.
export function parseComposeResponse(text: string): {
  title: string;
  content: string;
  confidence: number;
} {
  let title = "";
  let confidence = 0;
  let titleFound = false;
  let confFound = false;
  const rest: string[] = [];

  for (const line of text.split("\n")) {
    if (!titleFound) {
      const m = line.match(/^\s*title:\s*(.+?)\s*$/i);
      if (m) {
        title = stripQuotes(m[1] ?? "");
        titleFound = true;
        continue;
      }
    }
    if (!confFound) {
      const m = line.match(/^\s*confidence:\s*([-+]?[0-9]*\.?[0-9]+)/i);
      if (m) {
        const n = Number(m[1]);
        confidence = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
        confFound = true;
        continue;
      }
    }
    rest.push(line);
  }

  const content = rest.join("\n").trim().replace(/^#\s+.*\n+/, "").trim();
  return { title, content, confidence };
}

export function buildComposeFrontmatter(args: {
  title: string;
  topicQuery: string;
  sources: SourceNote[];
  confidence: number;
  model: string;
  created: string;
  updated: string;
}): string {
  const lines = ["---", "type: topic"];
  lines.push(`title: "${escapeYaml(args.title)}"`);
  lines.push(`topic_query: "${escapeYaml(args.topicQuery)}"`);
  lines.push("sources:");
  for (const s of args.sources) lines.push(`  - "[[${s.slug}]]"`);
  lines.push(`confidence: ${args.confidence}`);
  lines.push(`model: ${args.model}`);
  lines.push(`created: ${args.created}`);
  lines.push(`updated: ${args.updated}`);
  lines.push("---", "");
  return lines.join("\n");
}

function stripFrontmatter(s: string): string {
  return s.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"');
}

// Local copy of writer.kebab() — writer.ts depends on this module's writeTopic
// path, so importing from it would risk a cycle (mirrors articleDistiller.kebab).
function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function looksLikeTopic(content: string, relPath: string, topicsDir: string): boolean {
  const first = relPath.split("/")[0];
  if (first === topicsDir || first === TOPICS_SUBDIR) return true;
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  return m?.[1] ? /(^|\n)\s*type:\s*topic\s*(\r?\n|$)/i.test(m[1]) : false;
}

// ── orchestration (side-effectful: retriever, LLM, fs/db writes) ─────────────

// Search the vault for notes related to the topic and shape them as sources.
// Topic pages are filtered out — a topic must never source itself or another
// topic (avoids recursive, degrading synthesis).
export async function gatherSources(
  cfg: Config,
  db: StateDb,
  topic: string,
  limit: number,
): Promise<SourceNote[]> {
  const hits = await search(cfg, db, topic, limit);
  const root = vaultRoot(cfg);
  const topicsDir = cfg.topicsDir ?? TOPICS_SUBDIR;
  const out: SourceNote[] = [];
  for (const h of hits) {
    const rel = relative(root, h.filePath);
    if (looksLikeTopic(h.content, rel, topicsDir)) continue;
    out.push({
      slug: basename(h.filePath).replace(/\.md$/, ""),
      title: h.title,
      content: h.content,
      score: h.score,
    });
  }
  return out;
}

// Synthesize a topic page from already-gathered sources: prompt → LLM (cost is
// auto-recorded at the callLLM chokepoint, keyed by the topic slug so it groups
// under `vir cost --by-session`) → parse → write + upsert. Re-composing the same
// topic preserves its original created date (read back from the topics table).
export async function composeFromSources(
  cfg: Config,
  db: StateDb,
  topic: string,
  sources: SourceNote[],
  writer: VaultWriter,
  opts: { forceModel?: string } = {},
): Promise<ComposeResult> {
  const client = maybeAnthropicClient(cfg);
  const model = normalizeModelName(
    resolveModelShorthand(opts.forceModel ?? cfg.models.distill),
    cfg.provider,
  );
  const slug = composeSlug(topic);
  const prompt = buildComposePrompt(topic, sources);

  const text = await withRateLimitRetry(() =>
    callLLM(cfg, client, {
      prompt,
      model,
      maxTokens: COMPOSE_MAX_TOKENS,
      cost: { session: slug, project: "topics", stage: "compose" },
    }),
  );

  const parsed = parseComposeResponse(text);
  // Never file a hollow topic page: if synthesis produced no body (model
  // returned nothing usable), fail loudly instead of writing an empty note.
  if (parsed.content.trim().length === 0) {
    throw new Error(
      "topic synthesis returned no content — nothing written (check provider credits / API key)",
    );
  }
  const title = parsed.title.trim().length > 0 ? parsed.title.trim() : topic;
  const now = new Date().toISOString();
  const createdAt = db.getTopic(slug)?.createdAt ?? now;

  const composed: ComposedTopic = {
    slug,
    title,
    topicQuery: topic,
    content: parsed.content,
    confidence: parsed.confidence,
    model,
    sources,
    createdAt,
    updatedAt: now,
  };

  const notePath = await writer.writeTopic(composed);
  db.recordTopic({
    id: slug,
    topicText: topic,
    title,
    content: parsed.content,
    sourceNoteIds: sources.map((s) => s.slug),
    confidence: parsed.confidence,
    model,
    createdAt,
    updatedAt: now,
  });

  return {
    notePath,
    relPath: composeRelPath(slug, cfg.topicsDir ?? TOPICS_SUBDIR),
    slug,
    title,
    confidence: parsed.confidence,
    sourceCount: sources.length,
  };
}

// Token estimate for the dry-run / cost prompt: the real prompt's chars at the
// calibrated ~3 chars/token density (code/markdown tokenizes denser than the
// chars/4 house heuristic), plus the calibrated output median. Reporting only.
export function estimateComposeCostTokens(
  topic: string,
  sources: SourceNote[],
): { inputTokens: number; outputTokens: number } {
  const CHARS_PER_TOKEN = 3;
  const OUTPUT_TOKENS = 4500;
  return {
    inputTokens: Math.ceil(buildComposePrompt(topic, sources).length / CHARS_PER_TOKEN),
    outputTokens: OUTPUT_TOKENS,
  };
}

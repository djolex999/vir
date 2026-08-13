import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "../config.js";
import type { EmbeddingRow, StateDb } from "../state/db.js";
import { cosineSimilarity } from "./embedder.js";
import {
  resolveEmbeddingProvider,
  type EmbeddingProvider,
} from "./provider.js";
import { thresholdsFor } from "./thresholds.js";

const SKIP_FILES = new Set(["index.md", "log.md"]);
// Directories the TF-IDF walk must never index: derived period summaries
// (files-only, never in SQLite), human-rejected notes (`vir review` moves
// them to .rejected/), and dedupe-archived duplicates. The embedding path is
// covered separately — rejected notes' recorded paths no longer exist (the
// content read skips them) and getEmbeddings gates on `archived`.
const SKIP_DIRS = new Set(["summaries", ".rejected", "archived"]);

export interface IndexedDoc {
  relPath: string;
  title: string;
  raw: string;
  text: string;
  tokens: string[];
  tf: Map<string, number>;
}

export interface ScoredDoc {
  relPath: string;
  title: string;
  raw: string;
  score: number;
}

export interface SearchHit {
  filePath: string;
  title: string;
  content: string;
  score: number;
  method: "embedding" | "tfidf";
}

// A relevance-scored candidate carrying enough to both diversify (embedding) and
// reconstruct the eventual SearchHit (docId = filePath, content). `score` already
// includes the verified boost — MMR treats it as the relevance term.
export interface ScoredCandidate {
  docId: string;
  score: number;
  embedding: number[];
  content: string;
}

// Resolved per-model from thresholds.ts — see MODEL_THRESHOLDS.

// Notes a user has approved via `vir review` carry `verified: true` in their
// frontmatter. They get a flat ranking boost so human-verified knowledge floats
// above unverified auto-distillations of comparable relevance. Applied before
// the topK slice in both the embedding and TF-IDF paths.
const VERIFIED_BOOST = 0.2;

// Cheap frontmatter check — true only when the YAML block has `verified: true`.
// Exported so the query log records per-hit verified status without a second
// drift-prone reimplementation (the kebabLite lesson).
export function isVerified(raw: string): boolean {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m?.[1]) return false;
  return /(^|\n)\s*verified:\s*true\s*(\r?\n|$)/i.test(m[1]);
}

export interface SearchOutcome {
  hits: SearchHit[];
  method: "embedding" | "tfidf";
  // True when embeddings were ATTEMPTED but the embedder itself failed —
  // distinct from a clean semantic miss (every cosine below the floor).
  // embedError carries the EmbedderError message (HTTP status + body) so the
  // caller can surface it instead of the old empty-catch discard.
  degraded: boolean;
  embedError: string | null;
  // Rows refused because their stored vector came from a different embedding
  // model than the active one (mid-migration state). Never silent: callers
  // surface this so an unfinished re-embed is visible.
  excludedMismatched: number;
  // True when no embedding provider resolved at all (no Ollama, no local
  // install, or configured "none") — a supported mode, distinct from a
  // provider that failed. Callers label the two differently.
  noProvider: boolean;
  // How many docs survived the relevance floor BEFORE the topK slice —
  // embedding: rows above the cosine floor; tfidf: docs with lexical overlap.
  // Telemetry for the query log, never a ranking input.
  candidates: number;
  // Provenance of the vectors that served the hits; null whenever TF-IDF did
  // (including degraded fallback — the failed provider served nothing).
  provider: { name: string; model: string; dim: number } | null;
}

// Verified notes get +VERIFIED_BOOST, pushing human-approved knowledge to the
// top of results over unverified auto-distillations of similar relevance.
export async function search(
  cfg: Config,
  db: StateDb,
  query: string,
  topK = 8,
): Promise<SearchHit[]> {
  return (await searchWithOutcome(cfg, db, query, topK)).hits;
}

export async function searchWithOutcome(
  cfg: Config,
  db: StateDb,
  query: string,
  topK = 8,
): Promise<SearchOutcome> {
  const provider = await resolveEmbeddingProvider(cfg.embeddingProvider);
  if (provider) {
    const attempt = await searchByEmbedding(cfg, db, query, topK, provider);
    // If embeddings produced at least one match above the floor, take it.
    // Otherwise fall through to TF-IDF: low cosine on every doc means the
    // query is semantically off; lexical overlap might still find a match.
    if (attempt.hits.length > 0) {
      return {
        hits: attempt.hits,
        method: "embedding",
        degraded: false,
        embedError: null,
        excludedMismatched: attempt.excluded,
        noProvider: false,
        candidates: attempt.candidates,
        provider: {
          name: provider.name,
          model: provider.modelName,
          dim: provider.dimensions,
        },
      };
    }
    const fallback = searchByTfIdf(cfg, query, topK);
    return {
      hits: fallback.hits,
      method: "tfidf",
      degraded: attempt.error !== null,
      embedError: attempt.error,
      excludedMismatched: attempt.excluded,
      noProvider: false,
      candidates: fallback.candidates,
      provider: null,
    };
  }
  // TF-IDF is the supported floor, not a degraded state — but the caller must
  // be able to say "no provider" rather than "embeddings failed".
  const floor = searchByTfIdf(cfg, query, topK);
  return {
    hits: floor.hits,
    method: "tfidf",
    degraded: false,
    embedError: null,
    excludedMismatched: 0,
    noProvider: true,
    candidates: floor.candidates,
    provider: null,
  };
}

// Splits an embedding pool into rows comparable with the active model and a
// count of refusals. Cosine between vectors from different models (or different
// dimensionalities) is meaningless, so those rows must never enter the ranking.
export function partitionByEmbeddingModel(
  rows: EmbeddingRow[],
  activeModel: string,
): { compatible: EmbeddingRow[]; excluded: number } {
  const compatible = rows.filter((r) => r.embeddingModel === activeModel);
  return { compatible, excluded: rows.length - compatible.length };
}

async function searchByEmbedding(
  cfg: Config,
  db: StateDb,
  query: string,
  topK: number,
  provider: EmbeddingProvider,
): Promise<{
  hits: SearchHit[];
  error: string | null;
  excluded: number;
  candidates: number;
}> {
  let queryVec: number[];
  try {
    queryVec = await provider.embedQuery(query);
  } catch (err) {
    return { hits: [], error: (err as Error).message, excluded: 0, candidates: 0 };
  }

  const root = vaultRoot(cfg);
  // Sessions, articles, topics, and PDFs are embedded into the same vector
  // space; concat all four so semantic search covers every layer. No layer gets
  // a ranking boost — they compete on cosine like everything else.
  const allRows = [
    ...db.getEmbeddings(root),
    ...db.getArticleEmbeddings(),
    ...db.getTopicEmbeddings(root, cfg.topicsDir),
    ...db.getPdfEmbeddings(),
  ];
  // Vectors from another model are geometric nonsense against this query —
  // refuse to compare them. Excluded rows are counted, never silently dropped;
  // they re-enter search once re-embedded under the active model.
  const { compatible: rows, excluded } = partitionByEmbeddingModel(
    allRows,
    provider.modelName,
  );
  if (rows.length === 0)
    return { hits: [], error: null, excluded, candidates: 0 };

  // Read each candidate's content once, here, so the verified boost can be
  // applied BEFORE the topK slice — a verified note must be able to outrank an
  // unverified one just outside the window. Reads are bounded to docs above the
  // cosine floor (a personal-scale vault), and the content is reused for hits.
  const minScore = thresholdsFor(provider.modelName).minEmbeddingScore;
  const enriched: Array<{ row: (typeof rows)[number]; content: string; score: number }> = [];
  for (const r of rows) {
    const s = cosineSimilarity(queryVec, r.embedding);
    if (s < minScore) continue;
    let content = "";
    try {
      content = existsSync(r.filePath) ? readFileSync(r.filePath, "utf8") : "";
    } catch {
      content = "";
    }
    if (content.length === 0) continue;
    const score = isVerified(content) ? s + VERIFIED_BOOST : s;
    enriched.push({ row: r, content, score });
  }

  // MMR reranks the relevance-sorted pool to balance relevance against diversity
  // so results cover different facets of the query, not 5 near-duplicates. The
  // candidate has the embedding it needs to diversify; docId carries the file
  // path through so the hit can be reconstructed. (TF-IDF stays score-only —
  // too sparse for MMR to help.)
  const candidates: ScoredCandidate[] = enriched.map((e) => ({
    docId: e.row.filePath,
    score: e.score,
    embedding: e.row.embedding,
    content: e.content,
  }));
  // `retrievalDiversity` is user-facing (1.0 = pure diversity) so the config
  // number reads naturally as "how much diversity". mmrRerank uses the standard
  // MMR convention where lambda is the *relevance* weight, so invert here.
  const ranked = mmrRerank(candidates, topK, 1 - cfg.retrievalDiversity);

  const hits = ranked.map((c) => {
    const rel = relative(root, c.docId);
    return {
      filePath: c.docId,
      title: rel.replace(/\.md$/, ""),
      content: c.content,
      score: Math.round(c.score * 10000) / 10000,
      method: "embedding" as const,
    };
  });
  return { hits, error: null, excluded, candidates: enriched.length };
}

// Maximal Marginal Relevance: greedily reranks a candidate pool to trade off
// relevance against diversity. lambda is the relevance weight — 1.0 is pure
// relevance (MMR collapses to a score sort), 0.0 is pure diversity. The first
// pick is always pure top relevance; each subsequent pick maximizes
// `lambda*relevance - (1-lambda)*maxSimToSelected`. O(N*topK) over the pool.
export function mmrRerank(
  candidates: ScoredCandidate[],
  topK: number,
  lambda = 0.7,
): ScoredCandidate[] {
  if (candidates.length === 0 || topK <= 0) return [];

  // Sort a copy so top-1 and the shortcut below are deterministic regardless of
  // input order; the caller's array is left untouched.
  const pool = [...candidates].sort((a, b) => b.score - a.score);

  // Nothing to diversify: fewer candidates than slots, or only one slot.
  if (pool.length <= topK || topK === 1) return pool.slice(0, topK);

  const selected: ScoredCandidate[] = [pool.shift()!];
  while (selected.length < topK && pool.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const c = pool[i]!;
      let maxSim = 0;
      for (const sel of selected) {
        const sim = cosineSimilarity(c.embedding, sel.embedding);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * c.score - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }
    selected.push(pool.splice(bestIdx, 1)[0]!);
  }
  return selected;
}

function searchByTfIdf(
  cfg: Config,
  query: string,
  topK: number,
): { hits: SearchHit[]; candidates: number } {
  const docs = loadIndex(cfg);
  // Score everything, slice here: the full match count is the `candidates`
  // telemetry for the query log. Same sort, same slice — ranking unchanged.
  const scored = searchTfIdf(docs, query, docs.length);
  const root = vaultRoot(cfg);
  const hits = scored.slice(0, topK).map((d) => ({
    filePath: join(root, d.relPath),
    title: d.title,
    content: d.raw,
    score: d.score,
    method: "tfidf" as const,
  }));
  return { hits, candidates: scored.length };
}

export function vaultRoot(cfg: Config): string {
  return join(cfg.vaultPath, cfg.outputDir);
}

export function loadIndex(cfg: Config): IndexedDoc[] {
  const root = vaultRoot(cfg);
  const files: string[] = [];
  walk(root, files);
  const docs: IndexedDoc[] = [];
  for (const full of files) {
    const rel = relative(root, full);
    const base = rel.split("/").pop() ?? rel;
    if (SKIP_FILES.has(base)) continue;
    let raw: string;
    try {
      raw = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const text = stripMarkdown(raw);
    const tokens = tokenize(text);
    const tf = termFrequency(tokens);
    docs.push({
      relPath: rel,
      title: rel.replace(/\.md$/, ""),
      raw,
      text,
      tokens,
      tf,
    });
  }
  return docs;
}

export function searchTfIdf(
  docs: IndexedDoc[],
  query: string,
  topK = 8,
): ScoredDoc[] {
  if (docs.length === 0) return [];
  const queryTokens = uniq(tokenize(query));
  if (queryTokens.length === 0) return [];

  const totalDocs = docs.length;
  const dfMap = new Map<string, number>();
  for (const term of queryTokens) {
    let df = 0;
    for (const d of docs) if (d.tf.has(term)) df += 1;
    dfMap.set(term, df);
  }

  const scored: ScoredDoc[] = [];
  for (const d of docs) {
    let score = 0;
    for (const term of queryTokens) {
      const tf = d.tf.get(term) ?? 0;
      if (tf === 0) continue;
      const df = dfMap.get(term) ?? 0;
      if (df === 0) continue;
      // Smoothed: log(1 + N/df), never zero. Bare log(N/df) is 0 whenever
      // df === N — which is EVERY term in a single-note vault, making the
      // first note a new user creates unfindable. log(1+x) → log(x) for
      // large x, so established-vault rankings are essentially unchanged.
      const idf = Math.log(1 + totalDocs / df);
      // Normalize TF by doc length so long docs don't dominate.
      const tfNorm = tf / Math.max(1, d.tokens.length);
      score += tfNorm * idf;
    }
    if (score > 0) {
      // Boost only docs that already match the query (score > 0) so a verified
      // note can't surface on zero lexical overlap.
      if (isVerified(d.raw)) score += VERIFIED_BOOST;
      scored.push({
        relPath: d.relPath,
        title: d.title,
        raw: d.raw,
        score: Math.round(score * 10000) / 10000,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
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
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, acc);
    } else if (st.isFile() && name.endsWith(".md")) acc.push(full);
  }
}

export function stripMarkdown(md: string): string {
  let out = md;
  // YAML frontmatter
  out = out.replace(/^---\n[\s\S]*?\n---\n?/, "");
  // Fenced code blocks
  out = out.replace(/```[\s\S]*?```/g, " ");
  // Inline code
  out = out.replace(/`[^`]*`/g, " ");
  // Images
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  // Markdown links -> link text
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Wikilinks -> inner
  out = out.replace(/\[\[([^\]]+)\]\]/g, "$1");
  // Headings, blockquotes, list markers
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s*>\s?/gm, "");
  out = out.replace(/^\s*[-*+]\s+/gm, "");
  out = out.replace(/^\s*\d+\.\s+/gm, "");
  // Emphasis markers
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/\*([^*]+)\*/g, "$1");
  out = out.replace(/_([^_]+)_/g, "$1");
  // Horizontal rules
  out = out.replace(/^\s*[-*_]{3,}\s*$/gm, "");
  return out;
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 3);
}

function termFrequency(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

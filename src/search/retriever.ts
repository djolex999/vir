import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "../config.js";
import type { StateDb } from "../state/db.js";
import {
  cosineSimilarity,
  embed,
  isOllamaAvailable,
} from "./embedder.js";

const SKIP_FILES = new Set(["index.md", "log.md"]);

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

const MIN_EMBEDDING_SCORE = 0.3;

// Notes a user has approved via `vir review` carry `verified: true` in their
// frontmatter. They get a flat ranking boost so human-verified knowledge floats
// above unverified auto-distillations of comparable relevance. Applied before
// the topK slice in both the embedding and TF-IDF paths.
const VERIFIED_BOOST = 0.2;

// Cheap frontmatter check — true only when the YAML block has `verified: true`.
function isVerified(raw: string): boolean {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m?.[1]) return false;
  return /(^|\n)\s*verified:\s*true\s*(\r?\n|$)/i.test(m[1]);
}

// Verified notes get +VERIFIED_BOOST, pushing human-approved knowledge to the
// top of results over unverified auto-distillations of similar relevance.
export async function search(
  cfg: Config,
  db: StateDb,
  query: string,
  topK = 8,
): Promise<SearchHit[]> {
  if (await isOllamaAvailable()) {
    const hits = await searchByEmbedding(cfg, db, query, topK);
    // If embeddings produced at least one match above the floor, take it.
    // Otherwise fall through to TF-IDF: low cosine on every doc means the
    // query is semantically off; lexical overlap might still find a match.
    if (hits.length > 0) return hits;
  }
  return searchByTfIdf(cfg, query, topK);
}

async function searchByEmbedding(
  cfg: Config,
  db: StateDb,
  query: string,
  topK: number,
): Promise<SearchHit[]> {
  let queryVec: number[];
  try {
    queryVec = await embed(query);
  } catch {
    return [];
  }

  const root = vaultRoot(cfg);
  // Sessions, articles, and topics are embedded into the same vector space;
  // concat all three so semantic search covers every layer. Topics get no
  // ranking boost — they compete on cosine like everything else.
  const rows = [
    ...db.getEmbeddings(root),
    ...db.getArticleEmbeddings(),
    ...db.getTopicEmbeddings(root, cfg.topicsDir),
  ];
  if (rows.length === 0) return [];

  // Read each candidate's content once, here, so the verified boost can be
  // applied BEFORE the topK slice — a verified note must be able to outrank an
  // unverified one just outside the window. Reads are bounded to docs above the
  // cosine floor (a personal-scale vault), and the content is reused for hits.
  const enriched: Array<{ row: (typeof rows)[number]; content: string; score: number }> = [];
  for (const r of rows) {
    const s = cosineSimilarity(queryVec, r.embedding);
    if (s < MIN_EMBEDDING_SCORE) continue;
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

  return ranked.map((c) => {
    const rel = relative(root, c.docId);
    return {
      filePath: c.docId,
      title: rel.replace(/\.md$/, ""),
      content: c.content,
      score: Math.round(c.score * 10000) / 10000,
      method: "embedding" as const,
    };
  });
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

function searchByTfIdf(cfg: Config, query: string, topK: number): SearchHit[] {
  const docs = loadIndex(cfg);
  const scored = searchTfIdf(docs, query, topK);
  const root = vaultRoot(cfg);
  return scored.map((d) => ({
    filePath: join(root, d.relPath),
    title: d.title,
    content: d.raw,
    score: d.score,
    method: "tfidf" as const,
  }));
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
      const idf = Math.log(totalDocs / df);
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
    if (st.isDirectory()) walk(full, acc);
    else if (st.isFile() && name.endsWith(".md")) acc.push(full);
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

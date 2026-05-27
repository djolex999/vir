import type { Config } from "../config.js";
import type { DistilledRow, StateDb } from "../state/db.js";
import {
  maybeAnthropicClient,
  callLLM,
  normalizeModelName,
  withRateLimitRetry,
} from "../pipeline/distiller.js";
import { kebab } from "../pipeline/writer.js";

const MAX_CANDIDATE_PAIRS = 30;
const MIN_DUP_CONFIDENCE = 0.7;
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "it",
  "this",
  "that",
  "to",
  "of",
  "in",
  "on",
  "and",
  "or",
  "for",
  "with",
  "as",
  "by",
]);

export interface DuplicatePair {
  a: DistilledRow;
  b: DistilledRow;
  isDuplicate: true;
  confidence: number;
  reason: string;
  keepWhich: "A" | "B" | "merge";
}

interface CandidatePair {
  a: DistilledRow;
  b: DistilledRow;
  score: number;
}

export function findCandidatePairs(rows: DistilledRow[]): CandidatePair[] {
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const a = rows[i];
    if (!a) continue;
    for (let j = i + 1; j < rows.length; j += 1) {
      const b = rows[j];
      if (!b) continue;
      const score = scoreCandidate(a, b);
      if (score > 0) pairs.push({ a, b, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs.slice(0, MAX_CANDIDATE_PAIRS);
}

function scoreCandidate(a: DistilledRow, b: DistilledRow): number {
  const aSlug = kebab(a.topic);
  const bSlug = kebab(b.topic);
  const aTokens = aSlug.split("-").filter((t) => t.length >= 3);
  const bTokens = bSlug.split("-").filter((t) => t.length >= 3);
  const bSet = new Set(bTokens);

  const shared = aTokens.filter((t) => bSet.has(t)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  const jaccard = union === 0 ? 0 : shared / union;

  const sameProjCat =
    kebab(a.project) === kebab(b.project) && a.category === b.category;

  const aWords = significantWords(a.content);
  const bWords = significantWords(b.content);
  let sharedSig = 0;
  for (const w of aWords) if (bWords.has(w)) sharedSig += 1;

  let score = 0;
  if (sameProjCat && shared >= 2) score += 5;
  if (jaccard > 0.7) score += 4;
  if (sharedSig >= 3) score += Math.min(3, sharedSig - 2);

  // Tie-breaker: more shared structure ranks higher.
  score += shared * 0.5;
  return score;
}

function significantWords(content: string): Set<string> {
  const head = content.slice(0, 100).toLowerCase();
  const tokens = head.split(/\W+/).filter((t) => t.length >= 3);
  return new Set(tokens.filter((t) => !STOPWORDS.has(t)));
}

export async function detectDuplicates(
  cfg: Config,
  db: StateDb,
): Promise<{ checked: number; duplicates: DuplicatePair[] }> {
  const rows = db.listDistilled();
  const pairs = findCandidatePairs(rows);

  if (pairs.length === 0) return { checked: 0, duplicates: [] };

  const client = maybeAnthropicClient(cfg);
  const model = normalizeModelName(cfg.models.classify, cfg.provider);
  const duplicates: DuplicatePair[] = [];

  for (const pair of pairs) {
    const prompt = `Are these two knowledge notes duplicates or near-duplicates?
They are duplicates if they teach the same lesson or describe the same pattern/gotcha, even if worded differently.

Answer JSON only:
{
  "isDuplicate": boolean,
  "confidence": number (0..1),
  "reason": "string (max 20 words)",
  "keepWhich": "A" | "B" | "merge"
}

keepWhich: "A" if A is more detailed/recent, "B" if B is, "merge" if both have unique value worth combining.

Note A (topic: ${pair.a.topic}, date: ${pair.a.startedAt ?? "?"}, confidence: ${pair.a.confidence}):
${headOf(pair.a.content, 400)}

Note B (topic: ${pair.b.topic}, date: ${pair.b.startedAt ?? "?"}, confidence: ${pair.b.confidence}):
${headOf(pair.b.content, 400)}`;

    try {
      const text = await withRateLimitRetry(() =>
        callLLM(cfg, client, {
          prompt,
          model,
          maxTokens: 250,
          cost: { stage: "dedupe-detect" },
        }),
      );
      const parsed = parseResponse(text);
      if (parsed.isDuplicate && parsed.confidence >= MIN_DUP_CONFIDENCE) {
        duplicates.push({
          a: pair.a,
          b: pair.b,
          isDuplicate: true,
          confidence: parsed.confidence,
          reason: parsed.reason,
          keepWhich: parsed.keepWhich,
        });
      }
    } catch {
      // single failure shouldn't kill the run
    }
  }

  return { checked: pairs.length, duplicates };
}

function headOf(s: string, n: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

function parseResponse(text: string): {
  isDuplicate: boolean;
  confidence: number;
  reason: string;
  keepWhich: "A" | "B" | "merge";
} {
  const match = text.match(/\{[\s\S]*\}/);
  const fallback = {
    isDuplicate: false,
    confidence: 0,
    reason: "",
    keepWhich: "merge" as const,
  };
  if (!match) return fallback;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const rawKeep = obj.keepWhich;
    const keepWhich: "A" | "B" | "merge" =
      rawKeep === "A" || rawKeep === "B" || rawKeep === "merge"
        ? rawKeep
        : "merge";
    return {
      isDuplicate: obj.isDuplicate === true,
      confidence: clamp01(Number(obj.confidence ?? 0)),
      reason: typeof obj.reason === "string" ? obj.reason : "",
      keepWhich,
    };
  } catch {
    return fallback;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

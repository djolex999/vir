import { extractJsonArray } from "./json.js";
import type { DropReason, MinedItem } from "./types.js";

export const MINER_PROMPT_VERSION = "mine-v1";
export const MAX_TRANSCRIPT_CHARS = 60_000;

export interface Candidate {
  path: string;
  project: string;
  sessionId: string;
  startedAt: string | null;
  category: "session" | "workflow" | "sidechain";
  agent: boolean;
}

// A question is only testable if its project already had a note before it.
export function selectCandidates(
  cands: readonly Candidate[],
  noteStarts: ReadonlyMap<string, readonly string[]>,
): Candidate[] {
  return cands.filter((c) => {
    if (c.category !== "session" || c.agent || c.startedAt === null) return false;
    const starts = noteStarts.get(c.project) ?? [];
    const cutoff = c.startedAt;
    return starts.some((s) => s < cutoff);
  });
}

export function buildMinerPrompt(project: string, transcript: string): string {
  return `You are building an evaluation set from one Claude Code session transcript. Find what the developer needed to know or decide in this session, and what the session established.

project: ${project}

Return a JSON array with 0, 1 or 2 items, and nothing else:
[{"question": "…", "facts": ["…", "…"], "evidence": ["…", "…"]}]

- question: one standalone question the developer could later ask a search tool over their notes, like "how does X handle Y?" or "why did we choose X?". It must not contain the answer to any of the facts.
- facts: 2 to 4 things this session actually established, each concrete enough to be wrong: a file, function, constraint, number, or a decision together with what it was chosen over.
- evidence: for each fact, in the same order, one exact excerpt (under 200 characters) copied from the transcript below that supports it.
- If the session was pure execution with nothing to learn, return [].

Transcript:
${transcript}`;
}

// Tokens that carry a fact's specific answer: backticked terms, code-like
// identifiers (dotted, slashed, snake or camel case) and multi-digit numbers.
export function distinctiveTokens(fact: string): string[] {
  const out = new Set<string>();
  for (const m of fact.matchAll(/`([^`]+)`/g)) if (m[1]) out.add(m[1]);
  const code = /\b[A-Za-z_][A-Za-z0-9_]*(?:[./][A-Za-z0-9_]+)+(?:\(\))?|\b[a-z]+[A-Z][A-Za-z0-9]*(?:\(\))?|\b[A-Za-z]+_[A-Za-z0-9_]+\b/g;
  for (const m of fact.matchAll(code)) out.add(m[0]);
  for (const m of fact.matchAll(/\b\d{2,}\b/g)) out.add(m[0]);
  return [...out];
}

// F2: every candidate costs one claude -p call of up to 60k chars, and a
// vault this size can produce 300-450 of them against the spec's "about 200".
// With no cap, behaviour is unchanged; capped, keep the newest by startedAt
// rather than an arbitrary slice, so the sample stays recent.
export function capCandidates(cands: readonly Candidate[], max?: number): Candidate[] {
  if (max === undefined) return [...cands];
  return [...cands]
    .sort((a, b) => {
      const av = a.startedAt ?? "";
      const bv = b.startedAt ?? "";
      return av < bv ? 1 : av > bv ? -1 : 0;
    })
    .slice(0, max);
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

function emptyDrops(): Record<DropReason, number> {
  return { unparsed: 0, "fact-count": 0, "answer-in-question": 0, "bad-evidence": 0 };
}

export function validateMined(reply: string, transcript: string): { items: MinedItem[]; drops: Record<DropReason, number> } {
  const drops = emptyDrops();
  const raw = extractJsonArray(reply);
  if (!Array.isArray(raw)) {
    drops.unparsed += 1;
    return { items: [], drops };
  }
  const text = norm(transcript);
  const items: MinedItem[] = [];
  for (const entry of raw) {
    const e = entry as Partial<MinedItem>;
    const facts = Array.isArray(e.facts) ? e.facts.filter((f): f is string => typeof f === "string") : [];
    const evidence = Array.isArray(e.evidence) ? e.evidence.filter((x): x is string => typeof x === "string") : [];
    const question = typeof e.question === "string" ? e.question.trim() : "";
    if (question === "" || facts.length < 2 || facts.length > 4 || evidence.length !== facts.length) {
      drops["fact-count"] += 1;
      continue;
    }
    // Ruling R2: leaky only if the question already holds ALL of a fact's specifics.
    const q = question.toLowerCase();
    const leaks = facts.some((f) => {
      const toks = distinctiveTokens(f);
      return toks.length > 0 && toks.every((t) => q.includes(t.toLowerCase()));
    });
    if (leaks) {
      drops["answer-in-question"] += 1;
      continue;
    }
    if (!evidence.every((x) => text.includes(norm(x)))) {
      drops["bad-evidence"] += 1;
      continue;
    }
    items.push({ question, facts, evidence });
  }
  return { items, drops };
}

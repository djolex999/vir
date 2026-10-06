import { normalizeLesson } from "./extract.js";
import { qualifies, recurrence } from "./qualify.js";
import type { Lesson } from "./types.js";

export interface LlmVerdict {
  same_lesson: string[];
  rule: string;
  why: string;
  evidence: Array<{ id: string; quote: string }>;
}

export type Scope = "global" | `project:${string}`;

export interface ValidatedRule {
  rule: string;
  why: string;
  members: Lesson[];
  evidence: Array<{ lesson: Lesson; quote: string }>;
  scope: Scope;
  keptOfTotal: [number, number];
}

// Projects that say nothing about where a rule belongs.
export const NO_PROJECT = new Set(["", "codex-scratch", "unknown"]);

export function buildVerifyPrompt(members: Lesson[]): string {
  const lines = members.map(
    (m, i) => `[L${i + 1}] (${m.project || "-"}, ${m.noteDate.slice(0, 10)}) ${m.text}`,
  );
  return `You are reviewing lessons a developer recorded across separate coding sessions.
Decide which of them are the SAME lesson, then state it as one rule.

Lessons:
${lines.join("\n")}

Return JSON only:
{"same_lesson": ["L…"], "rule": "<imperative one-liner>", "why": "<1-2 sentences: the failure it prevents>",
 "evidence": [{"id": "L…", "quote": "<exact substring of that lesson>"}]}

Rules: include a lesson in same_lesson only if it teaches the same thing. Every quote must be copied
verbatim from its lesson. If fewer than three lessons are the same, return {"same_lesson": []}.`;
}

export function parseVerdict(text: string): LlmVerdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.same_lesson) || typeof o.rule !== "string" || typeof o.why !== "string" || !Array.isArray(o.evidence)) {
    return null;
  }
  return {
    same_lesson: o.same_lesson.filter((x): x is string => typeof x === "string"),
    rule: o.rule,
    why: o.why,
    evidence: o.evidence
      .filter((e): e is { id: unknown; quote: unknown } => !!e && typeof e === "object")
      .filter((e): e is { id: string; quote: string } => typeof e.id === "string" && typeof e.quote === "string"),
  };
}

export function computeScope(members: Lesson[]): Scope {
  const slugs = new Set(members.map((m) => m.project).filter((p) => !NO_PROJECT.has(p)));
  const only = [...slugs][0];
  return slugs.size === 1 && only !== undefined ? `project:${only}` : "global";
}

const norm = (s: string): string => normalizeLesson(s).toLowerCase();

// Everything the model claims is checked against the cluster: ids must exist,
// quotes must be real substrings, and the surviving members must still recur.
export function validateVerdict(members: Lesson[], v: LlmVerdict): ValidatedRule | null {
  const rule = v.rule.trim();
  const why = v.why.trim();
  if (rule.length === 0) return null;
  const byId = new Map(members.map((m, i) => [`L${i + 1}`, m]));
  const claimed = new Set(v.same_lesson.filter((id) => byId.has(id)));
  const evidence: Array<{ lesson: Lesson; quote: string }> = [];
  for (const e of v.evidence) {
    const lesson = byId.get(e.id);
    if (!lesson || !claimed.has(e.id)) continue;
    const q = norm(e.quote);
    if (q.length === 0 || !norm(lesson.text).includes(q)) continue;
    evidence.push({ lesson, quote: normalizeLesson(e.quote) });
  }
  const kept = members.filter((m) => evidence.some((e) => e.lesson === m));
  if (!qualifies(recurrence(kept))) return null;
  return { rule, why, members: kept, evidence, scope: computeScope(kept), keptOfTotal: [kept.length, members.length] };
}

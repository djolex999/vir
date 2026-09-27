import type { AnswerScore, FactVerdict } from "./types.js";

export const GRADER_PROMPT_VERSION = "grade-v1";
const VERDICTS: readonly FactVerdict[] = ["stated", "missing", "contradicted"];

export function buildGraderPrompt(question: string, facts: readonly string[], answer: string): string {
  const list = facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
  return `You are grading one answer against known facts. Judge only what the answer asserts.

Question: ${question}

Facts:
${list}

Answer:
${answer}

For each fact, decide:
- stated: the answer asserts this fact or something equivalent.
- missing: the answer does not say it, including when it says the notes do not cover it.
- contradicted: the answer asserts something incompatible with the fact.

Reply with a JSON array only, one object per fact:
[{"fact": 1, "verdict": "stated|missing|contradicted", "why": "one short reason"}]`;
}

export function parseGrade(reply: string, factCount: number): FactVerdict[] | null {
  const match = reply.match(/\[[\s\S]*\]/);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const out: (FactVerdict | undefined)[] = new Array(factCount).fill(undefined);
  for (const e of raw as Array<{ fact?: unknown; verdict?: unknown }>) {
    const n = typeof e.fact === "number" ? e.fact : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > factCount) return null;
    if (!(VERDICTS as readonly unknown[]).includes(e.verdict)) return null;
    if (out[n - 1] !== undefined) return null;
    out[n - 1] = e.verdict as FactVerdict;
  }
  return out.every((v) => v !== undefined) ? (out as FactVerdict[]) : null;
}

export function scoreAnswer(v: readonly FactVerdict[]): AnswerScore {
  const n = v.length;
  return {
    recall: v.filter((x) => x === "stated").length / n,
    contradiction: v.filter((x) => x === "contradicted").length / n,
  };
}

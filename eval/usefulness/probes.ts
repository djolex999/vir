import type { FactVerdict, ProbeSummary } from "./types.js";
import { scoreAnswer } from "./grade.js";

export const NEGATION_PROMPT_VERSION = "negate-v1";
export const NULL_ANSWER = "I don't know; the notes don't cover this.";

const sentence = (s: string): string => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export function oracleAnswer(facts: readonly string[]): string {
  return facts.map(sentence).join(" ");
}

export function buildNegationPrompt(facts: readonly string[]): string {
  return `Rewrite each statement so it asserts the opposite, keeping the same subject. Return a JSON array of strings, one per statement, in order, and nothing else.

${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
}

export function parseNegation(reply: string, factCount: number): string | null {
  const match = reply.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(raw) || raw.length !== factCount || !raw.every((x) => typeof x === "string")) return null;
    return (raw as string[]).map(sentence).join(" ");
  } catch {
    return null;
  }
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const share = <T>(xs: readonly T[], pred: (x: T) => boolean): number => xs.filter(pred).length / xs.length;
const f2 = (x: number): string => x.toFixed(2);

// Spec §6: known-answer probes bound the grader's failure modes before any
// real grade counts. A probe with no samples fails: absence is not evidence.
export function evaluateProbes(input: {
  oracle: FactVerdict[][];
  nulls: FactVerdict[][];
  negation: FactVerdict[][];
  regrade: Array<[FactVerdict[], FactVerdict[]]>;
}): ProbeSummary {
  const failures: string[] = [];
  const need = (name: string, xs: readonly unknown[]): boolean => {
    if (xs.length === 0) failures.push(`${name}: no samples`);
    return xs.length > 0;
  };
  const oracleRecall = need("oracle", input.oracle) ? mean(input.oracle.map((v) => scoreAnswer(v).recall)) : 0;
  const oracleZeroContraShare = input.oracle.length ? share(input.oracle, (v) => !v.includes("contradicted")) : 0;
  const nullCleanShare = need("null", input.nulls) ? share(input.nulls, (v) => v.every((x) => x === "missing")) : 0;
  const negationContra = need("negation", input.negation) ? mean(input.negation.map((v) => scoreAnswer(v).contradiction)) : 0;
  let agree = 0;
  let total = 0;
  for (const [a, b] of input.regrade) {
    a.forEach((x, i) => {
      total += 1;
      if (x === b[i]) agree += 1;
    });
  }
  const regradeAgreement = need("regrade", input.regrade) ? agree / total : 0;

  if (input.oracle.length && oracleRecall < 0.95) failures.push(`oracle recall ${f2(oracleRecall)} < 0.95`);
  if (input.oracle.length && oracleZeroContraShare < 0.95) failures.push(`oracle zero-contradiction share ${f2(oracleZeroContraShare)} < 0.95`);
  if (input.nulls.length && nullCleanShare < 0.95) failures.push(`null clean share ${f2(nullCleanShare)} < 0.95`);
  if (input.negation.length && negationContra < 0.9) failures.push(`negation contradiction ${f2(negationContra)} < 0.90`);
  if (input.regrade.length && regradeAgreement < 0.9) failures.push(`regrade agreement ${f2(regradeAgreement)} < 0.90`);
  return { oracleRecall, oracleZeroContraShare, nullCleanShare, negationContra, regradeAgreement, pass: failures.length === 0, failures };
}

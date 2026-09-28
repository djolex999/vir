import type { FactVerdict, ProbeSummary } from "./types.js";
import { scoreAnswer } from "./grade.js";
import { extractJsonArray } from "./json.js";

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
  const raw = extractJsonArray(reply);
  if (!Array.isArray(raw) || raw.length !== factCount || !raw.every((x) => typeof x === "string")) return null;
  return (raw as string[]).map(sentence).join(" ");
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const share = <T>(xs: readonly T[], pred: (x: T) => boolean): number => xs.filter(pred).length / xs.length;
const f2 = (x: number): string => x.toFixed(2);

// Shared threshold logic for each probe kind, so the pre-answer check (F1:
// oracle/null/negation only, before Phase B spends anything) and the full
// post-grade ProbeSummary (which adds the re-grade) can never drift apart.
function checkOracle(oracle: readonly FactVerdict[][]): { recall: number; zeroContraShare: number; failures: string[] } {
  if (oracle.length === 0) return { recall: 0, zeroContraShare: 0, failures: ["oracle: no samples"] };
  const recall = mean(oracle.map((v) => scoreAnswer(v).recall));
  const zeroContraShare = share(oracle, (v) => !v.includes("contradicted"));
  const failures: string[] = [];
  if (recall < 0.95) failures.push(`oracle recall ${f2(recall)} < 0.95`);
  if (zeroContraShare < 0.95) failures.push(`oracle zero-contradiction share ${f2(zeroContraShare)} < 0.95`);
  return { recall, zeroContraShare, failures };
}

function checkNull(nulls: readonly FactVerdict[][]): { cleanShare: number; failures: string[] } {
  if (nulls.length === 0) return { cleanShare: 0, failures: ["null: no samples"] };
  const cleanShare = share(nulls, (v) => v.every((x) => x === "missing"));
  return { cleanShare, failures: cleanShare < 0.95 ? [`null clean share ${f2(cleanShare)} < 0.95`] : [] };
}

function checkNegation(negation: readonly FactVerdict[][]): { contra: number; failures: string[] } {
  if (negation.length === 0) return { contra: 0, failures: ["negation: no samples"] };
  const contra = mean(negation.map((v) => scoreAnswer(v).contradiction));
  return { contra, failures: contra < 0.9 ? [`negation contradiction ${f2(contra)} < 0.90`] : [] };
}

function checkRegrade(regrade: ReadonlyArray<[FactVerdict[], FactVerdict[]]>): { agreement: number; failures: string[] } {
  if (regrade.length === 0) return { agreement: 0, failures: ["regrade: no samples"] };
  let agree = 0;
  let total = 0;
  for (const [a, b] of regrade) {
    a.forEach((x, i) => {
      total += 1;
      if (x === b[i]) agree += 1;
    });
  }
  const agreement = agree / total;
  return { agreement, failures: agreement < 0.9 ? [`regrade agreement ${f2(agreement)} < 0.90`] : [] };
}

export interface PreAnswerProbeResult {
  oracleRecall: number;
  oracleZeroContraShare: number;
  nullCleanShare: number;
  negationContra: number;
  pass: boolean;
  failures: string[];
}

// F1: the oracle/null/negation probes depend only on each question's facts,
// so they can — and must — run before any answer call. The re-grade probe
// needs real answers and isn't available yet; it is simply not part of this
// check (never treated as a pass or a fail here).
export function evaluatePreAnswerProbes(
  oracle: readonly FactVerdict[][],
  nulls: readonly FactVerdict[][],
  negation: readonly FactVerdict[][],
): PreAnswerProbeResult {
  const o = checkOracle(oracle);
  const n = checkNull(nulls);
  const g = checkNegation(negation);
  const failures = [...o.failures, ...n.failures, ...g.failures];
  return {
    oracleRecall: o.recall, oracleZeroContraShare: o.zeroContraShare, nullCleanShare: n.cleanShare, negationContra: g.contra,
    pass: failures.length === 0, failures,
  };
}

// Spec §6: known-answer probes bound the grader's failure modes before any
// real grade counts. A probe with no samples fails: absence is not evidence.
export function evaluateProbes(input: {
  oracle: FactVerdict[][];
  nulls: FactVerdict[][];
  negation: FactVerdict[][];
  regrade: Array<[FactVerdict[], FactVerdict[]]>;
}): ProbeSummary {
  const o = checkOracle(input.oracle);
  const n = checkNull(input.nulls);
  const g = checkNegation(input.negation);
  const r = checkRegrade(input.regrade);
  const failures = [...o.failures, ...n.failures, ...g.failures, ...r.failures];
  return {
    oracleRecall: o.recall, oracleZeroContraShare: o.zeroContraShare, nullCleanShare: n.cleanShare,
    negationContra: g.contra, regradeAgreement: r.agreement, pass: failures.length === 0, failures,
  };
}

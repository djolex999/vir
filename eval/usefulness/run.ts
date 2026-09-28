import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, STATE_PATH } from "../../src/config.js";
import { synthesize } from "../../src/search/synthesizer.js";
import { StateDb } from "../../src/state/db.js";
import { callJudge, EVAL_MODEL } from "../llm.js";
import { pairedBootstrapCI } from "../metrics/bootstrap.js";
import { USEFULNESS_CACHE_DIR, USEFULNESS_QUESTIONS_PATH, USEFULNESS_RUNS_DIR } from "../paths.js";
import { REPO_ROOT } from "../repo.js";
import { makeRng, sample, shuffle } from "../rng.js";
import { createCache, type ResultCache } from "./cache.js";
import { BOOTSTRAP_ROUNDS, computeVerdict } from "./gate.js";
import { buildGraderPrompt, GRADER_PROMPT_VERSION, parseGrade, scoreAnswer } from "./grade.js";
import { prepareUsefulnessHomes } from "./homes.js";
import { MINER_PROMPT_VERSION } from "./mine.js";
import { buildNegationPrompt, evaluateProbes, NEGATION_PROMPT_VERSION, NULL_ANSWER, oracleAnswer, parseNegation } from "./probes.js";
import { runUsefulnessArm } from "./retrieve.js";
import { exposedTo, filterForCutoff, sampleSets } from "./select.js";
import type {
  AnswerScore, ArmRetrieval, FactVerdict, MinedQuestion, QuestionFile, QuestionOutcome, RetrievalArm,
  RetrievedHit, RunRecord, UsefulnessArm,
} from "./types.js";

export interface RunDeps {
  llm(stage: "eval-usefulness-grade" | "eval-usefulness-probe", prompt: string, session: string): Promise<string>;
  answer(question: string, hits: readonly RetrievedHit[]): Promise<string>;
  retrieve(arm: RetrievalArm, qs: readonly MinedQuestion[]): Promise<ArmRetrieval[]>;
  rejectIds(): string[];
  prepareHomes(rejectIds: readonly string[]): Promise<void>;
  cache: ResultCache;
  now(): string;
  git(): { sha: string; dirty: boolean };
  questionsPath: string;
  runsDir: string;
}

const REGRADE_SHARE = 0.2;
const ANSWER_KEY_VERSION = "answer-v1";
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function defaults(): RunDeps {
  return {
    llm: async (stage, prompt, session) => (await callJudge(stage, prompt, session)).text,
    answer: (question, hits) =>
      synthesize(loadConfig(), question, hits.map((h) => ({ filePath: h.filePath, title: h.title, content: h.content, score: h.score, method: h.method })), "eval-usefulness-answer"),
    retrieve: runUsefulnessArm,
    rejectIds: () => {
      const db = new StateDb(STATE_PATH, { readonly: true });
      try {
        return db.listAudits().filter((a) => a.fresh && a.verdict === "reject").map((a) => a.sessionId).sort();
      } finally {
        db.close();
      }
    },
    prepareHomes: async (ids) => {
      await prepareUsefulnessHomes(ids);
    },
    cache: createCache(USEFULNESS_CACHE_DIR),
    now: () => new Date().toISOString(),
    git: () => {
      const s = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).trim() !== "";
      return { sha: s, dirty };
    },
    questionsPath: USEFULNESS_QUESTIONS_PATH,
    runsDir: USEFULNESS_RUNS_DIR,
  };
}

export async function usefulnessRun(opts: { seed: number; dryRun: boolean; deps?: Partial<RunDeps> }): Promise<RunRecord | null> {
  const d: RunDeps = { ...defaults(), ...opts.deps };
  if (!existsSync(d.questionsPath)) throw new Error(`no questions at ${d.questionsPath} — run \`npm run eval -- usefulness mine\` first`);
  const qfText = readFileSync(d.questionsPath, "utf8");
  const qf = JSON.parse(qfText) as QuestionFile;
  if (qf.questions.length === 0) throw new Error("the questions file is empty — run `npm run eval -- usefulness mine` again");
  const byId = new Map(qf.questions.map((q) => [q.id, q]));
  const rejectIds = [...d.rejectIds()].sort();
  const rejectSet = new Set(rejectIds);
  await d.prepareHomes(rejectIds);

  const fullAll = new Map((await d.retrieve("full", qf.questions)).map((r) => [r.questionId, r]));
  const topOf = (r: ArmRetrieval | undefined, q: MinedQuestion): RetrievedHit[] => (r ? filterForCutoff(r.hits, q).top : []);
  const exposure = new Map(qf.questions.map((q) => [q.id, exposedTo(topOf(fullAll.get(q.id), q), rejectSet)]));
  const exposedIds = qf.questions.filter((q) => (exposure.get(q.id) ?? []).length > 0).map((q) => q.id);
  const otherIds = qf.questions.filter((q) => (exposure.get(q.id) ?? []).length === 0).map((q) => q.id);
  const rng = makeRng(opts.seed);
  const sets = sampleSets(exposedIds, otherIds, rng);
  const sampled = [...sets.exposed, ...sets.control].map((id) => byId.get(id)!);

  if (opts.dryRun) {
    const n = sampled.length;
    process.stdout.write(
      `usefulness run (dry run): ${rejectIds.length} rejects, ${exposedIds.length} exposed available, sampling ${sets.exposed.length} exposed + ${sets.control.length} control\n` +
        `  expected model calls ≈ ${3 * n} answers + ${3 * n} grades + ${n} negations + ${3 * n} probe grades + ${Math.ceil(2 * n * REGRADE_SHARE)} re-grades\n`,
    );
    return null;
  }

  const ablAll = new Map((await d.retrieve("ablated", sampled)).map((r) => [r.questionId, r]));
  const isDegraded = (r: ArmRetrieval | undefined): boolean => !r || r.degraded || r.method === "tfidf";

  const grade = async (stage: "eval-usefulness-grade" | "eval-usefulness-probe", q: MinedQuestion, answer: string, bypass = false): Promise<FactVerdict[] | null> => {
    const prompt = buildGraderPrompt(q.question, q.facts, answer);
    const base = [stage, GRADER_PROMPT_VERSION, EVAL_MODEL, prompt];
    // Re-grades must reach the model again, so they use their own key.
    const k1 = bypass ? ["regrade", opts.seed.toString(), ...base] : base;
    const first = parseGrade((await d.cache.cached(k1, () => d.llm(stage, prompt, q.sessionId))).value, q.facts.length);
    if (first) return first;
    return parseGrade((await d.cache.cached(["retry", ...k1], () => d.llm(stage, prompt, q.sessionId))).value, q.facts.length);
  };

  const outcomes: QuestionOutcome[] = [];
  const jobs: Array<{ q: MinedQuestion; arm: UsefulnessArm; answer: string; out: QuestionOutcome }> = [];
  for (const q of sampled) {
    const set = sets.exposed.includes(q.id) ? "exposed" : "control";
    const out: QuestionOutcome = { questionId: q.id, set, exposedTo: exposure.get(q.id) ?? [], excluded: null, answers: {}, scores: {} };
    outcomes.push(out);
    if (isDegraded(fullAll.get(q.id)) || isDegraded(ablAll.get(q.id))) {
      out.excluded = "degraded";
      continue;
    }
    for (const arm of ["full", "ablated", "none"] as const) {
      const hits = arm === "none" ? [] : topOf((arm === "full" ? fullAll : ablAll).get(q.id), q);
      const key = ["answer", ANSWER_KEY_VERSION, q.question, ...hits.map((h) => `${h.filePath}\u0001${h.content}`)];
      const { value } = await d.cache.cached(key, () => d.answer(q.question, hits));
      out.answers[arm] = value;
      jobs.push({ q, arm, answer: value, out });
    }
  }

  const graded = new Map<string, FactVerdict[] | null>();
  for (const j of shuffle(jobs, rng)) {
    const v = await grade("eval-usefulness-grade", j.q, j.answer);
    graded.set(`${j.q.id}|${j.arm}`, v);
    if (v) j.out.scores[j.arm] = scoreAnswer(v);
    else if (j.arm !== "none" && j.out.excluded === null) j.out.excluded = "ungraded";
  }

  const live = outcomes.filter((o) => o.excluded === null).map((o) => byId.get(o.questionId)!);
  const oracle: FactVerdict[][] = [];
  const nulls: FactVerdict[][] = [];
  const negation: FactVerdict[][] = [];
  for (const q of live) {
    const o = await grade("eval-usefulness-probe", q, oracleAnswer(q.facts));
    if (o) oracle.push(o);
    const n = await grade("eval-usefulness-probe", q, NULL_ANSWER);
    if (n) nulls.push(n);
    const negPrompt = buildNegationPrompt(q.facts);
    const neg = parseNegation(
      (await d.cache.cached(["negate", NEGATION_PROMPT_VERSION, EVAL_MODEL, negPrompt], () => d.llm("eval-usefulness-probe", negPrompt, q.sessionId))).value,
      q.facts.length,
    );
    if (neg) {
      const g = await grade("eval-usefulness-probe", q, neg);
      if (g) negation.push(g);
    }
  }
  const realJobs = jobs.filter((j) => j.arm !== "none" && graded.get(`${j.q.id}|${j.arm}`));
  const regrade: Array<[FactVerdict[], FactVerdict[]]> = [];
  for (const j of sample(realJobs, Math.ceil(realJobs.length * REGRADE_SHARE), rng)) {
    const again = await grade("eval-usefulness-grade", j.q, j.answer, true);
    const first = graded.get(`${j.q.id}|${j.arm}`);
    if (again && first) regrade.push([first, again]);
  }
  const probes = evaluateProbes({ oracle, nulls, negation, regrade });

  const complete = (o: QuestionOutcome): o is QuestionOutcome & { scores: { full: AnswerScore; ablated: AnswerScore } } =>
    o.excluded === null && o.scores.full !== undefined && o.scores.ablated !== undefined;
  const exposedLive = outcomes.filter((o) => o.set === "exposed" && complete(o)) as Array<QuestionOutcome & { scores: { full: AnswerScore; ablated: AnswerScore } }>;
  const gate = computeVerdict({
    rejectCount: rejectIds.length,
    probesPass: probes.pass,
    probeFailures: probes.failures,
    sampledExposed: sets.exposed.length,
    excludedDegraded: outcomes.filter((o) => o.set === "exposed" && o.excluded === "degraded").length,
    pairs: exposedLive.map((o) => ({ full: o.scores.full, ablated: o.scores.ablated })),
    rng: makeRng(opts.seed + 1),
  });

  const ci = (xs: number[]) => pairedBootstrapCI(xs, BOOTSTRAP_ROUNDS, makeRng(opts.seed + 2));
  const withNone = outcomes.filter((o) => complete(o) && o.scores.none !== undefined);
  const controlLive = outcomes.filter((o) => o.set === "control" && complete(o)) as typeof exposedLive;
  const perRejectExposure: Record<string, number> = Object.fromEntries(rejectIds.map((id) => [id, 0]));
  for (const o of outcomes) for (const id of o.exposedTo) perRejectExposure[id] = (perRejectExposure[id] ?? 0) + 1;
  const worse = exposedLive
    .filter((o) => o.scores.ablated.recall < o.scores.full.recall || o.scores.ablated.contradiction > o.scores.full.contradiction)
    .map((o) => o.questionId);

  const record: RunRecord = {
    createdAt: d.now(),
    git: d.git(),
    seed: opts.seed,
    rejectSet: { sessionIds: rejectIds, sha256: sha(rejectIds.join("\n")) },
    questionsSha256: sha(qfText),
    prompts: { miner: MINER_PROMPT_VERSION, grader: GRADER_PROMPT_VERSION, negation: NEGATION_PROMPT_VERSION },
    model: EVAL_MODEL,
    sampled: { exposed: sets.exposed.length, control: sets.control.length, minedTotal: qf.questions.length, exposedAvailable: exposedIds.length },
    excluded: {
      degraded: outcomes.filter((o) => o.excluded === "degraded").length,
      ungraded: outcomes.filter((o) => o.excluded === "ungraded").length,
    },
    probes,
    gate,
    report: {
      fullVsNoneRecall: ci(withNone.map((o) => o.scores.full!.recall - o.scores.none!.recall)),
      controlRecall: ci(controlLive.map((o) => o.scores.ablated.recall - o.scores.full.recall)),
      controlContradiction: ci(controlLive.map((o) => o.scores.ablated.contradiction - o.scores.full.contradiction)),
      perRejectExposure,
      worse,
    },
    questions: outcomes,
  };
  mkdirSync(d.runsDir, { recursive: true });
  writeFileSync(join(d.runsDir, `${record.createdAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(record, null, 1));
  process.stdout.write(`${formatSummary(record)}\n`);
  return record;
}

export function formatSummary(r: RunRecord): string {
  const g = r.gate;
  return [
    `usefulness gate: ${g.verdict} — ${g.reason}`,
    `  rejects ${r.rejectSet.sessionIds.length} · exposed ${g.n}/${r.sampled.exposed} (available ${r.sampled.exposedAvailable}) · control ${r.sampled.control} · excluded degraded ${r.excluded.degraded}, ungraded ${r.excluded.ungraded}`,
    `  Δrecall (ablated − full) ${g.recall.meanDiff.toFixed(3)} CI [${g.recall.lo.toFixed(3)}, ${g.recall.hi.toFixed(3)}] · Δcontradiction ${g.contradiction.meanDiff.toFixed(3)} CI [${g.contradiction.lo.toFixed(3)}, ${g.contradiction.hi.toFixed(3)}]`,
    `  probes ${r.probes.pass ? "pass" : `FAIL (${r.probes.failures.join("; ")})`} · full − none recall ${r.report.fullVsNoneRecall.meanDiff.toFixed(3)} · ablated scored worse on ${r.report.worse.length} exposed questions`,
  ].join("\n");
}

export function showLatestRun(runsDir: string = USEFULNESS_RUNS_DIR): string {
  if (!existsSync(runsDir)) return "no usefulness runs yet — run `npm run eval -- usefulness run`";
  const files = readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort();
  const last = files.at(-1);
  if (!last) return "no usefulness runs yet — run `npm run eval -- usefulness run`";
  return formatSummary(JSON.parse(readFileSync(join(runsDir, last), "utf8")) as RunRecord);
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, STATE_PATH } from "../../src/config.js";
import { normalizeModelName } from "../../src/pipeline/distiller.js";
import type { SearchHit } from "../../src/search/retriever.js";
import { buildSynthesisPrompt, synthesize } from "../../src/search/synthesizer.js";
import { StateDb } from "../../src/state/db.js";
import { callJudge, EVAL_MODEL, mapLimit } from "../llm.js";
import type { BootstrapCI } from "../metrics/bootstrap.js";
import { pairedBootstrapCI } from "../metrics/bootstrap.js";
import { USEFULNESS_CACHE_DIR, USEFULNESS_QUESTIONS_PATH, USEFULNESS_RUNS_DIR } from "../paths.js";
import { REPO_ROOT } from "../repo.js";
import { makeRng, sample, shuffle } from "../rng.js";
import { createCache, type ResultCache } from "./cache.js";
import { BOOTSTRAP_ROUNDS, computeVerdict, degradedReason, MAX_DEGRADED_SHARE } from "./gate.js";
import { buildGraderPrompt, GRADER_PROMPT_VERSION, parseGrade, scoreAnswer } from "./grade.js";
import { prepareUsefulnessHomes, USEFULNESS_ARM_SPECS } from "./homes.js";
import { MINER_PROMPT_VERSION } from "./mine.js";
import {
  buildNegationPrompt, evaluatePreAnswerProbes, evaluateProbes, NEGATION_PROMPT_VERSION, NULL_ANSWER, oracleAnswer, parseNegation,
} from "./probes.js";
import { runUsefulnessArm } from "./retrieve.js";
import { exposedTo, filterForCutoff, sampleSets } from "./select.js";
import type {
  AnswerScore, ArmRetrieval, FactVerdict, GateResult, MinedQuestion, ProbeSummary, QuestionFile, QuestionOutcome,
  RetrievalArm, RetrievedHit, RunRecord, UsefulnessArm,
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
  // The model synthesize() will actually call — pinned once per run so the
  // answer cache key can invalidate on a model change (I2). Tests supply a
  // fixed string; production resolves it the same way synthesize() does.
  answerModel: string;
  // Injectable so tests never print progress/summary lines to stdout (M1).
  log(line: string): void;
  questionsPath: string;
  runsDir: string;
}

interface Job {
  q: MinedQuestion;
  arm: UsefulnessArm;
  answer: string;
  out: QuestionOutcome;
}

const REGRADE_SHARE = 0.2;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function toSearchHits(hits: readonly RetrievedHit[]): SearchHit[] {
  return hits.map((h) => ({ filePath: h.filePath, title: h.title, content: h.content, score: h.score, method: h.method }));
}

// A "not run" probe summary for a short-circuit (I1, I4): every numeric field
// is 0 (there is nothing to average), and pass is false so nothing downstream
// mistakes this for a grader that was checked and found reliable.
function notRunProbes(reason: string): ProbeSummary {
  return { oracleRecall: 0, oracleZeroContraShare: 0, nullCleanShare: 0, negationContra: 0, regradeAgreement: 0, pass: false, failures: [`not run: ${reason}`] };
}

function computeDefaultAnswerModel(): string {
  const cfg = loadConfig();
  return normalizeModelName(cfg.models.distill, cfg.provider);
}

function defaults(answerModel: string): RunDeps {
  return {
    llm: async (stage, prompt, session) => (await callJudge(stage, prompt, session)).text,
    answer: (question, hits) => synthesize(loadConfig(), question, toSearchHits(hits), "eval-usefulness-answer"),
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
    answerModel,
    log: (line) => process.stdout.write(line),
    questionsPath: USEFULNESS_QUESTIONS_PATH,
    runsDir: USEFULNESS_RUNS_DIR,
  };
}

export async function usefulnessRun(opts: { seed: number; dryRun: boolean; deps?: Partial<RunDeps> }): Promise<RunRecord | null> {
  // Lazy: only touches the real config (loadConfig) when the caller didn't
  // already pin a model — every test does, so this never runs there.
  const answerModel = opts.deps?.answerModel ?? computeDefaultAnswerModel();
  const d: RunDeps = { ...defaults(answerModel), ...opts.deps };
  if (!existsSync(d.questionsPath)) throw new Error(`no questions at ${d.questionsPath} — run \`npm run eval -- usefulness mine\` first`);
  const qfText = readFileSync(d.questionsPath, "utf8");
  const qf = JSON.parse(qfText) as QuestionFile;
  if (qf.questions.length === 0) throw new Error("the questions file is empty — run `npm run eval -- usefulness mine` again");
  // M4: mineRun.ts ids a question `${sessionId}#${i}`, so the same session id
  // appearing in two transcript files would collide silently — byId would
  // just keep the last one written. Fail loudly instead.
  const seenIds = new Set<string>();
  for (const q of qf.questions) {
    if (seenIds.has(q.id)) throw new Error(`duplicate question id ${q.id} — re-run \`usefulness mine\``);
    seenIds.add(q.id);
  }
  const byId = new Map(qf.questions.map((q) => [q.id, q]));
  const ci = (xs: number[]): BootstrapCI => pairedBootstrapCI(xs, BOOTSTRAP_ROUNDS, makeRng(opts.seed + 2));

  const writeRecord = (record: RunRecord): RunRecord => {
    mkdirSync(d.runsDir, { recursive: true });
    writeFileSync(join(d.runsDir, `${record.createdAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(record, null, 1));
    d.log(`${formatSummary(record)}\n`);
    return record;
  };

  const rejectIds = [...d.rejectIds()].sort();

  // I4: nothing to test — never touch prepareHomes, retrieval or the model.
  if (rejectIds.length === 0) {
    const gate = computeVerdict({
      rejectCount: 0, probesPass: false, probeFailures: [], sampledExposed: 0, excludedDegraded: 0, pairs: [], rng: makeRng(opts.seed + 1),
    });
    return writeRecord({
      createdAt: d.now(), git: d.git(), seed: opts.seed,
      rejectSet: { sessionIds: [], sha256: sha("") },
      questionsSha256: sha(qfText),
      prompts: { miner: MINER_PROMPT_VERSION, grader: GRADER_PROMPT_VERSION, negation: NEGATION_PROMPT_VERSION },
      model: EVAL_MODEL, answerModel: d.answerModel, arms: USEFULNESS_ARM_SPECS,
      sampled: { exposed: 0, control: 0, minedTotal: qf.questions.length, exposedAvailable: 0 },
      excluded: { degraded: 0, ungraded: 0 },
      probes: notRunProbes("no fresh rejects"),
      gate,
      report: { fullVsNoneRecall: ci([]), controlRecall: ci([]), controlContradiction: ci([]), perRejectExposure: {}, worse: [] },
      questions: [],
    });
  }

  const rejectSet = new Set(rejectIds);
  await d.prepareHomes(rejectIds);

  const fullAll = new Map((await d.retrieve("full", qf.questions)).map((r) => [r.questionId, r]));
  const filterFor = (r: ArmRetrieval | undefined, q: MinedQuestion): { top: RetrievedHit[]; droppedNonSession: number; droppedLeak: number } =>
    r ? filterForCutoff(r.hits, q) : { top: [], droppedNonSession: 0, droppedLeak: 0 };
  const topOf = (r: ArmRetrieval | undefined, q: MinedQuestion): RetrievedHit[] => filterFor(r, q).top;
  const exposure = new Map(qf.questions.map((q) => [q.id, exposedTo(topOf(fullAll.get(q.id), q), rejectSet)]));
  const exposedIds = qf.questions.filter((q) => (exposure.get(q.id) ?? []).length > 0).map((q) => q.id);
  const otherIds = qf.questions.filter((q) => (exposure.get(q.id) ?? []).length === 0).map((q) => q.id);
  const rng = makeRng(opts.seed);
  const sets = sampleSets(exposedIds, otherIds, rng);
  const sampled = [...sets.exposed, ...sets.control].map((id) => byId.get(id)!);

  if (opts.dryRun) {
    const n = sampled.length;
    d.log(
      `usefulness run (dry run): ${rejectIds.length} rejects, ${exposedIds.length} exposed available, sampling ${sets.exposed.length} exposed + ${sets.control.length} control\n` +
        `  expected model calls ≈ ${3 * n} answers + ${3 * n} grades + ${n} negations + ${3 * n} probe grades + ${Math.ceil(2 * n * REGRADE_SHARE)} re-grades\n`,
    );
    return null;
  }

  const ablAll = new Map((await d.retrieve("ablated", sampled)).map((r) => [r.questionId, r]));
  const isDegraded = (r: ArmRetrieval | undefined): boolean => !r || r.degraded || r.method === "tfidf";

  // Phase A: retrieval-only trace + degraded exclusion. No model call yet, so
  // I1's short-circuit below can fire before a single answer or grade is spent.
  const outcomes: QuestionOutcome[] = [];
  for (const q of sampled) {
    const set = sets.exposed.includes(q.id) ? "exposed" : "control";
    const out: QuestionOutcome = { questionId: q.id, set, exposedTo: exposure.get(q.id) ?? [], excluded: null, retrieved: {}, answers: {}, verdicts: {}, scores: {} };
    for (const arm of ["full", "ablated"] as const) {
      const r = (arm === "full" ? fullAll : ablAll).get(q.id);
      if (r) {
        const meta = filterFor(r, q);
        out.retrieved[arm] = {
          sessionIds: meta.top.flatMap((h) => (h.sessionId !== null ? [h.sessionId] : [])),
          method: r.method, degraded: r.degraded,
          droppedNonSession: meta.droppedNonSession, droppedLeak: meta.droppedLeak,
        };
      }
    }
    if (isDegraded(fullAll.get(q.id)) || isDegraded(ablAll.get(q.id))) out.excluded = "degraded";
    outcomes.push(out);
  }

  // I1: Ollama down (or partially down past the tolerance) means the answers
  // we'd grade are meaningless — say so directly instead of letting an empty
  // probe set masquerade as "grader unreliable", or an under-15 sample
  // masquerade as "insufficient sample".
  const sampledExposedCount = sets.exposed.length;
  const excludedDegradedCount = outcomes.filter((o) => o.set === "exposed" && o.excluded === "degraded").length;
  if (sampledExposedCount > 0 && excludedDegradedCount / sampledExposedCount > MAX_DEGRADED_SHARE) {
    const reason = degradedReason(excludedDegradedCount, sampledExposedCount);
    const gate: GateResult = {
      verdict: "NO VERDICT", reason, n: 0,
      recall: pairedBootstrapCI([], BOOTSTRAP_ROUNDS, makeRng(opts.seed + 1)),
      contradiction: pairedBootstrapCI([], BOOTSTRAP_ROUNDS, makeRng(opts.seed + 1)),
    };
    return writeRecord({
      createdAt: d.now(), git: d.git(), seed: opts.seed,
      rejectSet: { sessionIds: rejectIds, sha256: sha(rejectIds.join("\n")) },
      questionsSha256: sha(qfText),
      prompts: { miner: MINER_PROMPT_VERSION, grader: GRADER_PROMPT_VERSION, negation: NEGATION_PROMPT_VERSION },
      model: EVAL_MODEL, answerModel: d.answerModel, arms: USEFULNESS_ARM_SPECS,
      sampled: { exposed: sets.exposed.length, control: sets.control.length, minedTotal: qf.questions.length, exposedAvailable: exposedIds.length },
      excluded: { degraded: outcomes.filter((o) => o.excluded === "degraded").length, ungraded: 0 },
      probes: notRunProbes("retrieval degraded"),
      gate,
      report: { fullVsNoneRecall: ci([]), controlRecall: ci([]), controlContradiction: ci([]), perRejectExposure: Object.fromEntries(rejectIds.map((id) => [id, 0])), worse: [] },
      questions: outcomes,
    });
  }

  const grade = async (stage: "eval-usefulness-grade" | "eval-usefulness-probe", q: MinedQuestion, answer: string, bypass = false): Promise<FactVerdict[] | null> => {
    const prompt = buildGraderPrompt(q.question, q.facts, answer);
    const base = [stage, GRADER_PROMPT_VERSION, EVAL_MODEL, prompt];
    // Re-grades must reach the model again, so they use their own key.
    const k1 = bypass ? ["regrade", opts.seed.toString(), ...base] : base;
    const first = parseGrade((await d.cache.cached(k1, () => d.llm(stage, prompt, q.sessionId))).value, q.facts.length);
    if (first) return first;
    return parseGrade((await d.cache.cached(["retry", ...k1], () => d.llm(stage, prompt, q.sessionId))).value, q.facts.length);
  };

  // F3(c): oracle/null/negation for one question, with bounded concurrency
  // (mapLimit(items, 2, fn), same helper mine.ts uses). No rng draw happens in
  // here, so running it concurrently cannot disturb draw order, and the mean/
  // share statistics evaluateProbes computes from the result don't care about
  // array order either.
  const runProbeSet = async (
    qs: readonly MinedQuestion[],
  ): Promise<{ oracle: FactVerdict[][]; nulls: FactVerdict[][]; negation: FactVerdict[][] }> => {
    const results = await mapLimit(qs, 2, async (q) => {
      const o = await grade("eval-usefulness-probe", q, oracleAnswer(q.facts));
      const n = await grade("eval-usefulness-probe", q, NULL_ANSWER);
      const negPrompt = buildNegationPrompt(q.facts);
      const neg = parseNegation(
        (await d.cache.cached(["negate", NEGATION_PROMPT_VERSION, EVAL_MODEL, negPrompt], () => d.llm("eval-usefulness-probe", negPrompt, q.sessionId))).value,
        q.facts.length,
      );
      const g = neg ? await grade("eval-usefulness-probe", q, neg) : null;
      return { o, n, g };
    });
    return {
      oracle: results.flatMap((r) => (r.o ? [r.o] : [])),
      nulls: results.flatMap((r) => (r.n ? [r.n] : [])),
      negation: results.flatMap((r) => (r.g ? [r.g] : [])),
    };
  };

  // F1: run the answer-independent probes on every sampled, non-degraded
  // question BEFORE any answer call — a broken grader is caught after ~320
  // calls instead of after Phase B's ~750. The probe set here is "sampled,
  // non-degraded" rather than "sampled, non-degraded, graded": the "ungraded"
  // exclusion only exists once Phase B has graded a real answer, and it is
  // rare. The re-grade probe isn't available yet (it needs real answers), so
  // it is simply left out of this check rather than counted as a pass or fail.
  const preAnswerQs = outcomes.filter((o) => o.excluded === null).map((o) => byId.get(o.questionId)!);
  const { oracle: earlyOracle, nulls: earlyNulls, negation: earlyNegation } = await runProbeSet(preAnswerQs);
  const preAnswer = evaluatePreAnswerProbes(earlyOracle, earlyNulls, earlyNegation);
  if (!preAnswer.pass) {
    const gate = computeVerdict({
      rejectCount: rejectIds.length, probesPass: false, probeFailures: preAnswer.failures,
      sampledExposed: sets.exposed.length, excludedDegraded: excludedDegradedCount, pairs: [], rng: makeRng(opts.seed + 1),
    });
    return writeRecord({
      createdAt: d.now(), git: d.git(), seed: opts.seed,
      rejectSet: { sessionIds: rejectIds, sha256: sha(rejectIds.join("\n")) },
      questionsSha256: sha(qfText),
      prompts: { miner: MINER_PROMPT_VERSION, grader: GRADER_PROMPT_VERSION, negation: NEGATION_PROMPT_VERSION },
      model: EVAL_MODEL, answerModel: d.answerModel, arms: USEFULNESS_ARM_SPECS,
      sampled: { exposed: sets.exposed.length, control: sets.control.length, minedTotal: qf.questions.length, exposedAvailable: exposedIds.length },
      excluded: { degraded: outcomes.filter((o) => o.excluded === "degraded").length, ungraded: 0 },
      probes: { ...preAnswer, regradeAgreement: 0 },
      gate,
      report: { fullVsNoneRecall: ci([]), controlRecall: ci([]), controlContradiction: ci([]), perRejectExposure: Object.fromEntries(rejectIds.map((id) => [id, 0])), worse: [] },
      questions: outcomes,
    });
  }

  // Phase B: answer + grade, only for outcomes that survived Phase A and the
  // pre-answer probe check above.
  interface AnswerTask {
    q: MinedQuestion;
    arm: UsefulnessArm;
    out: QuestionOutcome;
    hits: RetrievedHit[];
  }
  const answerTasks: AnswerTask[] = [];
  for (const out of outcomes) {
    if (out.excluded !== null) continue;
    const q = byId.get(out.questionId)!;
    for (const arm of ["full", "ablated", "none"] as const) {
      const hits = arm === "none" ? [] : topOf((arm === "full" ? fullAll : ablAll).get(q.id), q);
      answerTasks.push({ q, arm, out, hits });
    }
  }
  // F3(a): answer calls run with bounded concurrency. answerTasks is built
  // sequentially above with no rng draw, and mapLimit assembles `jobs` by
  // task index (not completion order), so the result is deterministic.
  const jobs: Job[] = await mapLimit(answerTasks, 2, async (t) => {
    // I2 (spec §8): key by stage, model and the exact rendered prompt, so a
    // model or prompt change can never mix answerers inside one pair.
    const prompt = buildSynthesisPrompt(t.q.question, toSearchHits(t.hits));
    const key = ["eval-usefulness-answer", d.answerModel, prompt];
    const { value } = await d.cache.cached(key, () => d.answer(t.q.question, t.hits));
    t.out.answers[t.arm] = value;
    return { q: t.q, arm: t.arm, answer: value, out: t.out };
  });

  // The shuffle is one rng draw, done synchronously before any concurrent
  // grading starts — the shuffled array fixes the submission order mapLimit
  // uses below, so a re-run with the same seed always submits in the same
  // order regardless of how the concurrent calls actually complete.
  const shuffledJobs = shuffle(jobs, rng);
  const graded = new Map<string, FactVerdict[] | null>();
  // F3(b): grade calls run with bounded concurrency, in the shuffled order.
  await mapLimit(shuffledJobs, 2, async (j) => {
    const v = await grade("eval-usefulness-grade", j.q, j.answer);
    graded.set(`${j.q.id}|${j.arm}`, v);
    if (v) {
      j.out.scores[j.arm] = scoreAnswer(v);
      j.out.verdicts[j.arm] = v;
    } else if (j.arm !== "none" && j.out.excluded === null) j.out.excluded = "ungraded";
  });

  // After real grades: re-run the probe set on the questions still live (a
  // subset of preAnswerQs, since Phase B's "ungraded" exclusion can only
  // shrink it) to compute the full ProbeSummary, exactly as before F1's
  // reorder. Every call here is a cache hit from the pre-answer check above,
  // so this costs nothing extra.
  const live = outcomes.filter((o) => o.excluded === null).map((o) => byId.get(o.questionId)!);
  const { oracle, nulls, negation } = await runProbeSet(live);
  const realJobs = jobs.filter((j) => j.arm !== "none" && graded.get(`${j.q.id}|${j.arm}`));
  // M4: when full and ablated answers land on the identical text (and so the
  // identical grader prompt), they share one cache entry and one grade — a
  // re-grade sample of each would agree by construction with no evidence
  // about the grader. Dedupe by grader prompt before sampling the 20%.
  const uniqueByPrompt = new Map<string, Job>();
  for (const j of realJobs) {
    const key = buildGraderPrompt(j.q.question, j.q.facts, j.answer);
    if (!uniqueByPrompt.has(key)) uniqueByPrompt.set(key, j);
  }
  const regradeCandidates = [...uniqueByPrompt.values()];
  const regrade: Array<[FactVerdict[], FactVerdict[]]> = [];
  for (const j of sample(regradeCandidates, Math.ceil(regradeCandidates.length * REGRADE_SHARE), rng)) {
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

  const withNone = outcomes.filter((o) => complete(o) && o.scores.none !== undefined);
  const controlLive = outcomes.filter((o) => o.set === "control" && complete(o)) as typeof exposedLive;
  const perRejectExposure: Record<string, number> = Object.fromEntries(rejectIds.map((id) => [id, 0]));
  for (const o of outcomes) for (const id of o.exposedTo) perRejectExposure[id] = (perRejectExposure[id] ?? 0) + 1;
  const worse = exposedLive
    .filter((o) => o.scores.ablated.recall < o.scores.full.recall || o.scores.ablated.contradiction > o.scores.full.contradiction)
    .map((o) => o.questionId);

  return writeRecord({
    createdAt: d.now(),
    git: d.git(),
    seed: opts.seed,
    rejectSet: { sessionIds: rejectIds, sha256: sha(rejectIds.join("\n")) },
    questionsSha256: sha(qfText),
    prompts: { miner: MINER_PROMPT_VERSION, grader: GRADER_PROMPT_VERSION, negation: NEGATION_PROMPT_VERSION },
    model: EVAL_MODEL,
    answerModel: d.answerModel,
    arms: USEFULNESS_ARM_SPECS,
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
  });
}

const meanOrNA = (ci: BootstrapCI): string => (ci.n === 0 ? "n/a" : ci.meanDiff.toFixed(3));
const ciOrNA = (ci: BootstrapCI): string => (ci.n === 0 ? "n/a" : `${ci.meanDiff.toFixed(3)} CI [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]`);

export function formatSummary(r: RunRecord): string {
  const g = r.gate;
  return [
    `usefulness gate: ${g.verdict} — ${g.reason}`,
    `  rejects ${r.rejectSet.sessionIds.length} · exposed ${g.n}/${r.sampled.exposed} (available ${r.sampled.exposedAvailable}) · control ${r.sampled.control} · excluded degraded ${r.excluded.degraded}, ungraded ${r.excluded.ungraded}`,
    `  Δrecall (ablated − full) ${ciOrNA(g.recall)} · Δcontradiction ${ciOrNA(g.contradiction)}`,
    `  probes ${r.probes.pass ? "pass" : `FAIL (${r.probes.failures.join("; ")})`} · full − none recall ${meanOrNA(r.report.fullVsNoneRecall)} · ablated scored worse on ${r.report.worse.length} exposed questions`,
  ].join("\n");
}

export function showLatestRun(runsDir: string = USEFULNESS_RUNS_DIR): string {
  if (!existsSync(runsDir)) return "no usefulness runs yet — run `npm run eval -- usefulness run`";
  const files = readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort();
  const last = files.at(-1);
  if (!last) return "no usefulness runs yet — run `npm run eval -- usefulness run`";
  return formatSummary(JSON.parse(readFileSync(join(runsDir, last), "utf8")) as RunRecord);
}

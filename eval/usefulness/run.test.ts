import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCache } from "./cache.js";
import { usefulnessRun, type RunDeps } from "./run.js";
import type { ArmRetrieval, MinedQuestion, QuestionFile, RetrievedHit } from "./types.js";

// 20 exposed questions, each with one fact. Note "good" carries the fact,
// note "rej" is the reject. The stub grader says "stated" iff the answer
// contains the fact text, "contradicted" iff it contains "NOT <fact>".
const Q = (i: number): MinedQuestion => ({
  id: `q${i}`, question: `question ${i}?`, facts: [`fact-${i}`, `other-${i}`], evidence: ["e", "e"],
  project: "app", sessionId: `qs${i}`, transcriptPath: `/t/${i}.jsonl`, cutoff: "2026-09-10T00:00:00.000Z",
});
const H = (sessionId: string, content: string): RetrievedHit => ({
  filePath: `/v/${sessionId}.md`, title: sessionId, content, score: 1, method: "embedding", sessionId, startedAt: "2026-09-01T00:00:00.000Z",
});

function deps(dir: string, over: Partial<RunDeps> & { ablatedLosesFact?: boolean; degradedFor?: Set<string> } = {}): Partial<RunDeps> {
  const questions = Array.from({ length: 20 }, (_, i) => Q(i));
  const qf: QuestionFile = {
    createdAt: "x", minerPromptVersion: "mine-v1", model: "m", transcriptsSeen: 20, candidates: 20,
    drops: { unparsed: 0, "fact-count": 0, "answer-in-question": 0, "bad-evidence": 0 }, questions,
  };
  const questionsPath = join(dir, "questions.json");
  writeFileSync(questionsPath, JSON.stringify(qf));
  const retrieve = async (arm: "full" | "ablated", qs: readonly MinedQuestion[]): Promise<ArmRetrieval[]> =>
    qs.map((q) => ({
      questionId: q.id,
      method: over.degradedFor?.has(q.id) ? "tfidf" : "embedding",
      degraded: over.degradedFor?.has(q.id) ?? false,
      hits: arm === "full" ? [H("good", `good ${q.facts.join(" ")}`), H("rej", "noise")] : [H("good", `good ${q.facts.join(" ")}`)],
    }));
  return {
    questionsPath, runsDir: join(dir, "runs"), cache: createCache(join(dir, "cache")),
    rejectIds: () => ["rej"], prepareHomes: async () => {}, retrieve,
    answerModel: "test-model",
    // Keep test output quiet (M1) — no summary/progress lines on stdout.
    log: () => {},
    answer: async (question, hits) => {
      const i = question.replace(/\D/g, "");
      const hasGood = hits.some((h) => h.sessionId === "good");
      const fromRej = hits.some((h) => h.sessionId === "rej");
      if (!hasGood) return "I don't know";
      if (over.ablatedLosesFact && !fromRej) return `answer other-${i}`;
      return `answer fact-${i} other-${i}`;
    },
    llm: async (_stage, prompt) => {
      if (prompt.startsWith("Rewrite each statement")) {
        const facts = [...prompt.matchAll(/^\d+\. (.+)$/gm)].map((m) => `NOT ${m[1]}`);
        return JSON.stringify(facts);
      }
      const facts = [...prompt.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => m[2]!);
      const answer = prompt.split("Answer:\n")[1]?.split("\n\nFor each fact")[0] ?? "";
      return JSON.stringify(facts.map((f, i) => ({
        fact: i + 1,
        verdict: answer.includes(`NOT ${f}`) ? "contradicted" : answer.includes(f) ? "stated" : "missing",
      })));
    },
    now: () => "2026-09-26T00:00:00.000Z", git: () => ({ sha: "abc", dirty: false }),
    ...over,
  };
}

describe("usefulnessRun", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-urun-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes when the rejects contribute nothing, and writes a traceable record", async () => {
    const rec = await usefulnessRun({ seed: 1, dryRun: false, deps: deps(dir) });
    expect(rec?.gate.verdict).toBe("PASS");
    expect(rec?.probes.pass).toBe(true);
    expect(rec?.rejectSet.sessionIds).toEqual(["rej"]);
    expect(rec?.rejectSet.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(join(dir, "runs"))).toHaveLength(1);

    // I3: the record must explain itself without re-running anything —
    // which sessions each arm surfaced and what each arm was graded as.
    expect(rec?.answerModel).toBe("test-model");
    expect(rec?.arms.full.id).toBe("usefulness-full");
    expect(rec?.arms.ablated.id).toBe("usefulness-ablated");
    const q0 = rec?.questions.find((o) => o.questionId === "q0");
    expect(q0?.retrieved.full).toEqual({ sessionIds: ["good", "rej"], method: "embedding", degraded: false, droppedNonSession: 0, droppedLeak: 0 });
    expect(q0?.retrieved.ablated).toEqual({ sessionIds: ["good"], method: "embedding", degraded: false, droppedNonSession: 0, droppedLeak: 0 });
    expect(q0?.verdicts.full).toEqual(["stated", "stated"]);
    expect(q0?.verdicts.none).toEqual(["missing", "missing"]);
  });

  it("fails when answers get worse without the rejects", async () => {
    const rec = await usefulnessRun({ seed: 1, dryRun: false, deps: deps(dir, { ablatedLosesFact: true }) });
    expect(rec?.gate.verdict).toBe("FAIL");
    expect(rec?.report.worse.length).toBeGreaterThan(0);
  });

  // Review Focus 2 / I1: too much retrieval degradation must be reported as
  // exactly that, never as "grader unreliable" or "insufficient sample" —
  // and it must cost nothing (no answer or grade call at all).
  it("excludes degraded questions and gives no verdict when too many degrade, spending nothing on grading", async () => {
    const degradedFor = new Set(Array.from({ length: 8 }, (_, i) => `q${i}`));
    let answerCalls = 0;
    let llmCalls = 0;
    const base = deps(dir, { degradedFor });
    const counting: Partial<RunDeps> = {
      ...base,
      answer: async (...args) => {
        answerCalls += 1;
        return base.answer!(...args);
      },
      llm: async (...args) => {
        llmCalls += 1;
        return base.llm!(...args);
      },
    };
    const rec = await usefulnessRun({ seed: 1, dryRun: false, deps: counting });
    expect(rec?.excluded.degraded).toBe(8);
    expect(rec?.gate.verdict).toBe("NO VERDICT");
    expect(rec?.gate.reason).toMatch(/retrieval degraded/);
    expect(rec?.probes.pass).toBe(false);
    expect(rec?.probes.failures).toEqual(["not run: retrieval degraded"]);
    expect(answerCalls).toBe(0);
    expect(llmCalls).toBe(0);
  });

  // Review Focus 1 / I4: an empty reject set must short-circuit before
  // prepareHomes, retrieval or any model call — there is nothing to test.
  it("gives no verdict when there are no fresh rejects, without spending anything", async () => {
    let prepareHomesCalls = 0;
    let retrieveCalls = 0;
    let answerCalls = 0;
    let llmCalls = 0;
    const rec = await usefulnessRun({
      seed: 1, dryRun: false,
      deps: deps(dir, {
        rejectIds: () => [],
        prepareHomes: async () => {
          prepareHomesCalls += 1;
        },
        retrieve: async () => {
          retrieveCalls += 1;
          return [];
        },
        answer: async () => {
          answerCalls += 1;
          return "";
        },
        llm: async () => {
          llmCalls += 1;
          return "[]";
        },
      }),
    });
    expect(rec?.gate.reason).toBe("no fresh reject verdicts to test");
    expect(rec?.probes.pass).toBe(false);
    expect(rec?.probes.failures).toEqual(["not run: no fresh rejects"]);
    expect(rec?.questions).toEqual([]);
    expect(prepareHomesCalls).toBe(0);
    expect(retrieveCalls).toBe(0);
    expect(answerCalls).toBe(0);
    expect(llmCalls).toBe(0);
  });

  // Review Focus 3.
  it("says to run `usefulness mine` first when there is no questions file", async () => {
    await expect(
      usefulnessRun({ seed: 1, dryRun: false, deps: { ...deps(dir), questionsPath: join(dir, "missing.json") } }),
    ).rejects.toThrow(/usefulness mine/);
  });

  // M4: mineRun.ts ids a question `${sessionId}#${i}` — the same session id in
  // two transcript files would otherwise let byId silently keep the last one.
  it("throws a clear error when the questions file has duplicate ids", async () => {
    const base = deps(dir);
    const dup = Q(0);
    const qf: QuestionFile = {
      createdAt: "x", minerPromptVersion: "mine-v1", model: "m", transcriptsSeen: 1, candidates: 1,
      drops: { unparsed: 0, "fact-count": 0, "answer-in-question": 0, "bad-evidence": 0 },
      questions: [dup, { ...dup }],
    };
    writeFileSync(base.questionsPath!, JSON.stringify(qf));
    await expect(usefulnessRun({ seed: 1, dryRun: false, deps: base })).rejects.toThrow(/duplicate question id/);
  });

  // F1: the oracle/null/negation probes must run before any answer call, so a
  // broken grader is caught for the cost of ~320 calls, not ~750. Here the
  // negation-generator returns the facts unchanged (no actual negation), so
  // the grader calls every fact "stated" instead of "contradicted" and the
  // negation probe's contradiction rate stays near zero.
  it("fails the negation probe before any answer call, giving no verdict", async () => {
    const base = deps(dir);
    let answerCalls = 0;
    const brokenNegation: Partial<RunDeps> = {
      ...base,
      llm: async (stage, prompt, session) => {
        if (prompt.startsWith("Rewrite each statement")) {
          const facts = [...prompt.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]!);
          return JSON.stringify(facts);
        }
        return base.llm!(stage, prompt, session);
      },
      answer: async (...args) => {
        answerCalls += 1;
        return base.answer!(...args);
      },
    };
    const rec = await usefulnessRun({ seed: 1, dryRun: false, deps: brokenNegation });
    expect(rec?.gate.verdict).toBe("NO VERDICT");
    expect(rec?.gate.reason).toMatch(/^grader unreliable: /);
    expect(rec?.probes.pass).toBe(false);
    expect(rec?.probes.failures.some((f) => f.includes("negation"))).toBe(true);
    expect(answerCalls).toBe(0);
  });

  // Review Focus 4 / M3: a re-run pays for nothing already computed. Every
  // real cache key (including re-grades, which are cached under their own
  // seeded key) is already warm, so a second run makes zero new calls.
  it("makes no new model calls on a re-run with the same inputs", async () => {
    let calls = 0;
    const d = deps(dir);
    const counting: Partial<RunDeps> = {
      ...d,
      llm: async (s, p, x) => {
        calls += 1;
        return d.llm!(s, p, x);
      },
    };
    await usefulnessRun({ seed: 1, dryRun: false, deps: counting });
    const first = calls;
    await usefulnessRun({ seed: 1, dryRun: false, deps: counting });
    expect(calls).toBe(first);
  });

  // I2: the answer cache key includes the model, so a model change must
  // invalidate every cached answer and pay for fresh ones.
  it("a changed answerModel invalidates the answer cache and pays for new answers", async () => {
    let calls = 0;
    const d = deps(dir);
    const countingAnswer: Partial<RunDeps>["answer"] = async (...args) => {
      calls += 1;
      return d.answer!(...args);
    };
    await usefulnessRun({ seed: 1, dryRun: false, deps: { ...d, answerModel: "model-a", answer: countingAnswer } });
    const first = calls;
    expect(first).toBeGreaterThan(0);
    await usefulnessRun({ seed: 1, dryRun: false, deps: { ...d, answerModel: "model-b", answer: countingAnswer } });
    expect(calls).toBeGreaterThan(first);
  });

  // M3: the ungraded path was untested. A grader reply that never parses, even
  // after the one retry, must exclude the question (never crash or silently
  // drop it), and the retry must actually reach the model a second time under
  // its own cache key.
  it("marks a question ungraded when the grader returns garbage twice, using the retry key", async () => {
    const base = deps(dir, { ablatedLosesFact: true });
    let gradeCallsForTarget = 0;
    const badGrader: Partial<RunDeps> = {
      ...base,
      llm: async (stage, prompt, session) => {
        if (stage === "eval-usefulness-grade" && prompt.includes("Answer:\nanswer fact-0 other-0\n")) {
          gradeCallsForTarget += 1;
          return "not json";
        }
        return base.llm!(stage, prompt, session);
      },
    };
    const rec = await usefulnessRun({ seed: 1, dryRun: false, deps: badGrader });
    expect(gradeCallsForTarget).toBe(2);
    expect(rec?.excluded.ungraded).toBe(1);
    const q0 = rec?.questions.find((o) => o.questionId === "q0");
    expect(q0?.excluded).toBe("ungraded");
  });

  // Review defect: the answer phase used to queue one task per (question,
  // arm) and run mapLimit(answerTasks, 2, …), so a control question's full
  // and ablated tasks (identical rendered prompt, since the full top-8 holds
  // no reject) landed on the two workers at the same time. cache.cached has
  // no in-flight dedupe (it only checks existsSync), so both missed the
  // cache and both paid for a real answer call — and the two independent
  // samples then differ. The fix makes the QUESTION the unit of concurrency:
  // mapLimit runs per question, and within a question the arms are awaited
  // in sequence, so the second identical prompt hits the cache.
  it("shares one answer call between full and ablated when their rendered prompts are identical (control question)", async () => {
    const base = deps(dir);
    let totalCalls = 0;
    let q0Calls = 0;
    // Slow and unique per call: slow enough to open a real concurrency
    // window for the bug (without a delay, synchronous-ish scheduling could
    // accidentally mask it), and a fresh string per call so a double-pay
    // shows up as answers.full !== answers.ablated.
    const answerStub = async (question: string): Promise<string> => {
      totalCalls += 1;
      if (question === "question 0?") q0Calls += 1;
      const mine = totalCalls;
      await new Promise((r) => setTimeout(r, 5));
      return `unique-answer-${mine}`;
    };
    // q0's full and ablated retrieval are made identical (both just "good",
    // no "rej") so q0 has no reject in its top and becomes a control
    // question, with full and ablated rendering the same synthesis prompt.
    // Every other question keeps the default full=[good,rej] vs
    // ablated=[good] shape, so it stays exposed and its two arms keep
    // distinct prompts (unaffected by this bug).
    const retrieve = async (arm: "full" | "ablated", qs: readonly MinedQuestion[]): Promise<ArmRetrieval[]> =>
      qs.map((q) =>
        q.id === "q0"
          ? { questionId: q.id, method: "embedding", degraded: false, hits: [H("good", `good ${q.facts.join(" ")}`)] }
          : {
              questionId: q.id,
              method: "embedding",
              degraded: false,
              hits: arm === "full" ? [H("good", `good ${q.facts.join(" ")}`), H("rej", "noise")] : [H("good", `good ${q.facts.join(" ")}`)],
            },
      );
    const rec = await usefulnessRun({ seed: 1, dryRun: false, deps: { ...base, retrieve, answer: answerStub } });
    const q0 = rec?.questions.find((o) => o.questionId === "q0");
    expect(q0?.set).toBe("control");
    expect(q0?.excluded).toBeNull();
    // One shared call for full+ablated (identical prompt) plus one for
    // none's distinct (no-hits) prompt — not three.
    expect(q0Calls).toBe(2);
    expect(q0?.answers.full).toBe(q0?.answers.ablated);
  });

  it("dry-run makes no model calls and writes no record", async () => {
    let calls = 0;
    const d = deps(dir);
    const rec = await usefulnessRun({
      seed: 1, dryRun: true,
      deps: { ...d, llm: async () => { calls += 1; return "[]"; }, answer: async () => { calls += 1; return ""; } },
    });
    expect(rec).toBeNull();
    expect(calls).toBe(0);
  });
});

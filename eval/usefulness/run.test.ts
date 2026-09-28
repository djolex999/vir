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
  });

  it("fails when answers get worse without the rejects", async () => {
    const rec = await usefulnessRun({ seed: 1, dryRun: false, deps: deps(dir, { ablatedLosesFact: true }) });
    expect(rec?.gate.verdict).toBe("FAIL");
    expect(rec?.report.worse.length).toBeGreaterThan(0);
  });

  // Review Focus 2.
  it("excludes degraded questions and gives no verdict when too many degrade", async () => {
    const degradedFor = new Set(Array.from({ length: 8 }, (_, i) => `q${i}`));
    const rec = await usefulnessRun({ seed: 1, dryRun: false, deps: deps(dir, { degradedFor }) });
    expect(rec?.excluded.degraded).toBe(8);
    expect(rec?.gate.verdict).toBe("NO VERDICT");
  });

  // Review Focus 1.
  it("gives no verdict when there are no fresh rejects", async () => {
    const rec = await usefulnessRun({ seed: 1, dryRun: false, deps: deps(dir, { rejectIds: () => [] }) });
    expect(rec?.gate.reason).toBe("no fresh reject verdicts to test");
  });

  // Review Focus 3.
  it("says to run `usefulness mine` first when there is no questions file", async () => {
    await expect(
      usefulnessRun({ seed: 1, dryRun: false, deps: { ...deps(dir), questionsPath: join(dir, "missing.json") } }),
    ).rejects.toThrow(/usefulness mine/);
  });

  // Review Focus 4: a re-run pays for nothing already computed.
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
    // Only the seeded re-grades bypass the cache by design.
    expect(calls - first).toBeLessThanOrEqual(Math.ceil(first * 0.2));
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

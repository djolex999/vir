# Note-Usefulness Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run eval -- usefulness mine|run|show` measures whether removing `vir audit`'s current reject set makes Claude's answers to real later-session questions worse, and returns PASS / FAIL / NO VERDICT under rules fixed in the spec.

**Architecture:**
- Pure modules in `eval/usefulness/`: selection, mining validation, grading, probes and the gate.
- A content-hash result cache that every model call goes through.
- A child-process retrieval worker that runs production `searchWithOutcome` under an isolated arm `HOME`.
- Two orchestrators, mine and run, with every side effect injected, so the whole pipeline is testable with stubs.

**Tech Stack:** Node 20, TypeScript strict, vitest, better-sqlite3, and the existing `eval/` harness (`rng.ts`, `metrics/bootstrap.ts`, `prepareHomes.ts`, `runArm.ts`, `llm.ts`).

**Spec:** `docs/superpowers/specs/2026-09-26-note-usefulness-eval-design.md`. Read §2 (decisions) and §6–§7 (the frozen probe and gate rules) before any task.

## Global Constraints

- **Location:** everything lives under `eval/`, and nothing ships. The `package.json` `files` whitelist is `dist/` only. It is not a `vir` command.
- **Data:** every data file lives under `~/.vir/eval/usefulness/`. New path constants go in `eval/paths.ts`, where `eval/noLeak.test.ts` checks every exported constant.
- **Real state is read-only:** the real `~/.vir/vir.db` and the vault are only read. The ablation touches only the `usefulness-ablated` home's DB copy.
- **Model calls** run in the parent process through `callJudge` (`eval/llm.ts`, model `EVAL_MODEL` = `claude-sonnet-5`) or production `synthesize()`, and always through the result cache. Cost stages: `eval-usefulness-mine`, `eval-usefulness-answer`, `eval-usefulness-grade`, `eval-usefulness-probe`.
- **Retrieval** runs only in the child worker, with `HOME` set to the arm home. Its path constants must resolve inside that home (isolation is checked).
- **Frozen numbers (spec §3, §4, §6, §7):**
  - retrieval: fetch 30, keep 8;
  - sampling: up to 60 exposed and 20 control, default seed 20260926, transcript text capped at 60,000 chars;
  - Δrecall CI lower bound > −0.05; Δcontradiction CI upper bound ≤ +0.02;
  - at least 15 exposed questions remaining; at most 25% of sampled exposed questions excluded as degraded;
  - probes: oracle recall ≥ 0.95, oracle zero-contradiction share ≥ 0.95, null-clean share ≥ 0.95, negation contradiction ≥ 0.90, re-grade agreement ≥ 0.90, re-grade share 20%;
  - bootstrap: 2000 rounds.
- **Style:** TypeScript strict (`noUncheckedIndexedAccess`), comment WHY not WHAT, vitest `*.test.ts` colocated with `.js` imports, and tests never call a real model.
- **Test baseline:** 887 passing (`npx vitest run`).

## Review Focus

1. **The user already ran `vir audit --apply-rejects`.** Those rows are now `rejected_at`, `listAudits()` drops them, and the frozen reject set is empty. Expected: NO VERDICT, "no fresh reject verdicts to test", not a vacuous PASS. Task 5 (gate) and Task 7 (run) test this.
2. **Ollama is down or the embedder fails.** Every question falls back to TF-IDF. Expected: NO VERDICT (retrieval degraded) with a hint to start Ollama. Tasks 5 and 7.
3. **`usefulness run` before `usefulness mine`, or with an empty questions file.** Expected: a clear error naming the command to run first, never a crash inside the pipeline. Task 7.
4. **A subscription limit mid-run.** Expected: the command stops, and a re-run resumes without paying again. The cache must never hold a partial entry. Tasks 1 and 7.
5. **A transcript with no timestamps (`startedAt` null), or a hit whose note has no `session_id` (topic, article, PDF).** Expected: never used as a question, and never allowed into a top 8, since its cutoff can't be proven. Tasks 2 and 3.

## Rulings made while planning (they deviate from the spec text)

- **R1. Path constants go in `eval/paths.ts`,** not a new `eval/usefulness/paths.ts`. `noLeak.test.ts` only scans `eval/paths.ts`'s exports, and a separate file would escape the leak guard.
- **R2. Answer-in-question check.** An item is dropped only if a fact has at least one distinctive token and **all** of them appear in the question. The spec said "any". But real questions name their subject: "how does `vir audit` store verdicts?" has a fact about `vir audit`. The "any" rule would drop nearly every valid question. "All" still catches a question that states the answer.
- **R3. Miner and grader model:** they use `callJudge`'s `EVAL_MODEL` (`claude-sonnet-5`), the harness convention. It equals this vault's `models.distill`.
- **R4. `synthesize()` gets an optional `stage` parameter,** defaulting to `"query-synthesis"`, so answer calls are logged as `eval-usefulness-answer` as the spec requires. Production behaviour is unchanged.
- **R5. An empty frozen reject set gives NO VERDICT** ("no fresh reject verdicts to test"). The spec did not list this reason; it is added as step 0 of the verdict order.

---

### Task 1: Paths, types, cost stages, result cache

**Files:**
- Modify: `eval/paths.ts`, `eval/llm.ts:9`
- Create: `eval/usefulness/types.ts`, `eval/usefulness/cache.ts`
- Test: `eval/usefulness/cache.test.ts`

**Interfaces:**
- Produces:
  - `USEFULNESS_DIR`, `USEFULNESS_QUESTIONS_PATH`, `USEFULNESS_CACHE_DIR`, `USEFULNESS_RUNS_DIR`
  - every type in `types.ts` (below)
  - `cacheKey(parts: readonly string[]): string`
  - `createCache(dir: string): ResultCache`, with `ResultCache.cached<T>(parts, compute): Promise<{ value: T; hit: boolean }>` and `ResultCache.has(parts): boolean`
  - `callJudge` accepts the three new stages

- [ ] **Step 1: Write the failing cache test** — `eval/usefulness/cache.test.ts`

```ts
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheKey, createCache } from "./cache.js";

describe("result cache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-ucache-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("computes once, then returns the stored value", async () => {
    const cache = createCache(dir);
    let calls = 0;
    const compute = async (): Promise<string> => {
      calls += 1;
      return "answer";
    };
    expect(await cache.cached(["grade", "m", "p"], compute)).toEqual({ value: "answer", hit: false });
    expect(await cache.cached(["grade", "m", "p"], compute)).toEqual({ value: "answer", hit: true });
    expect(calls).toBe(1);
  });

  // A prompt edit must invalidate exactly the affected results.
  it("misses when any key part changes", async () => {
    const cache = createCache(dir);
    await cache.cached(["grade", "m", "p1"], async () => "a");
    expect(cache.has(["grade", "m", "p1"])).toBe(true);
    expect(cache.has(["grade", "m", "p2"])).toBe(false);
  });

  // A subscription limit mid-call must leave nothing half-written behind.
  it("stores nothing when compute throws", async () => {
    const cache = createCache(dir);
    await expect(
      cache.cached(["mine", "m", "p"], async () => {
        throw new Error("limit");
      }),
    ).rejects.toThrow("limit");
    expect(cache.has(["mine", "m", "p"])).toBe(false);
  });

  it("keys differ for ['ab','c'] and ['a','bc']", () => {
    expect(cacheKey(["ab", "c"])).not.toBe(cacheKey(["a", "bc"]));
  });

  it("creates its directory on first write", async () => {
    const nested = join(dir, "x", "y");
    const cache = createCache(nested);
    await cache.cached(["k"], async () => 1);
    expect(existsSync(nested)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run eval/usefulness/cache.test.ts`
Expected: FAIL, "Cannot find module './cache.js'".

- [ ] **Step 3: Implement**

Append to `eval/paths.ts`:

```ts
// Note-usefulness eval (docs/superpowers/specs/2026-09-26-note-usefulness-eval-design.md).
// Mined questions, answers and grades quote session content, so they live here too.
export const USEFULNESS_DIR = join(EVAL_DIR, "usefulness");
export const USEFULNESS_QUESTIONS_PATH = join(USEFULNESS_DIR, "questions.json");
export const USEFULNESS_CACHE_DIR = join(USEFULNESS_DIR, "cache");
export const USEFULNESS_RUNS_DIR = join(USEFULNESS_DIR, "runs");
```

In `eval/llm.ts`, widen the `stage` parameter of `callJudge` to:

```ts
  stage:
    | "eval-label"
    | "eval-query-gen"
    | "eval-distill-judge"
    | "eval-usefulness-mine"
    | "eval-usefulness-grade"
    | "eval-usefulness-probe",
```

Create `eval/usefulness/types.ts`:

```ts
import type { BootstrapCI } from "../metrics/bootstrap.js";

export type UsefulnessArm = "full" | "ablated" | "none";
export type RetrievalArm = Exclude<UsefulnessArm, "none">;

export interface MinedItem {
  question: string;
  facts: string[];
  evidence: string[];
}

export interface MinedQuestion extends MinedItem {
  id: string;
  project: string;
  sessionId: string;
  transcriptPath: string;
  // The question's session start (ISO). Only notes from sessions that started
  // strictly before it may be shown to the answerer.
  cutoff: string;
}

export type DropReason = "unparsed" | "fact-count" | "answer-in-question" | "bad-evidence";

export interface QuestionFile {
  createdAt: string;
  minerPromptVersion: string;
  model: string;
  transcriptsSeen: number;
  candidates: number;
  drops: Record<DropReason, number>;
  questions: MinedQuestion[];
}

export interface RetrievedHit {
  filePath: string;
  title: string;
  content: string;
  score: number;
  method: "embedding" | "tfidf";
  // null for topic / article / PDF notes: they carry no session_id.
  sessionId: string | null;
  startedAt: string | null;
}

export interface ArmRetrieval {
  questionId: string;
  method: "embedding" | "tfidf";
  degraded: boolean;
  hits: RetrievedHit[];
}

export interface UsefulnessArmOutput {
  armId: string;
  home: string;
  dbPath: string;
  configPath: string;
  embedderDir: string;
  results: ArmRetrieval[];
}

export type FactVerdict = "stated" | "missing" | "contradicted";

export interface AnswerScore {
  recall: number;
  contradiction: number;
}

export type Verdict = "PASS" | "FAIL" | "NO VERDICT";

export interface ProbeSummary {
  oracleRecall: number;
  oracleZeroContraShare: number;
  nullCleanShare: number;
  negationContra: number;
  regradeAgreement: number;
  pass: boolean;
  failures: string[];
}

export interface GateResult {
  verdict: Verdict;
  reason: string;
  n: number;
  recall: BootstrapCI;
  contradiction: BootstrapCI;
}

export interface QuestionOutcome {
  questionId: string;
  set: "exposed" | "control";
  exposedTo: string[];
  excluded: null | "degraded" | "ungraded";
  answers: Partial<Record<UsefulnessArm, string>>;
  scores: Partial<Record<UsefulnessArm, AnswerScore>>;
}

export interface RunRecord {
  createdAt: string;
  git: { sha: string; dirty: boolean };
  seed: number;
  rejectSet: { sessionIds: string[]; sha256: string };
  questionsSha256: string;
  prompts: { miner: string; grader: string; negation: string };
  model: string;
  sampled: { exposed: number; control: number; minedTotal: number; exposedAvailable: number };
  excluded: { degraded: number; ungraded: number };
  probes: ProbeSummary;
  gate: GateResult;
  report: {
    fullVsNoneRecall: BootstrapCI;
    controlRecall: BootstrapCI;
    controlContradiction: BootstrapCI;
    perRejectExposure: Record<string, number>;
    worse: string[];
  };
  questions: QuestionOutcome[];
}
```

Create `eval/usefulness/cache.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ResultCache {
  cached<T>(parts: readonly string[], compute: () => Promise<T>): Promise<{ value: T; hit: boolean }>;
  has(parts: readonly string[]): boolean;
}

// NUL-joined so ["ab","c"] and ["a","bc"] never collide.
export function cacheKey(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

// Every eval model call goes through here: a subscription limit mid-run is
// expected, and a re-run must pay only for what is missing.
export function createCache(dir: string): ResultCache {
  const fileFor = (parts: readonly string[]): string => {
    const k = cacheKey(parts);
    return join(dir, k.slice(0, 2), `${k}.json`);
  };
  return {
    has: (parts) => existsSync(fileFor(parts)),
    async cached<T>(parts: readonly string[], compute: () => Promise<T>) {
      const f = fileFor(parts);
      if (existsSync(f)) {
        return { value: (JSON.parse(readFileSync(f, "utf8")) as { value: T }).value, hit: true };
      }
      const value = await compute();
      mkdirSync(dirname(f), { recursive: true });
      // Write-then-rename: an interrupted write never leaves a readable half entry.
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ value }));
      renameSync(tmp, f);
      return { value, hit: false };
    },
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run eval/usefulness/cache.test.ts eval/noLeak.test.ts && npx tsc --noEmit -p eval/tsconfig.json`
Expected: PASS (5 new). noLeak still passes with the 4 new constants under `~/.vir/eval`.

- [ ] **Step 5: Commit**

```bash
git add eval/paths.ts eval/llm.ts eval/usefulness/types.ts eval/usefulness/cache.ts eval/usefulness/cache.test.ts
git commit -m "feat(eval): usefulness paths, types and a content-hash result cache"
```

---

### Task 2: Selection — cutoff filter, exposure, sampling, note→session mapping

**Files:**
- Create: `eval/usefulness/select.ts`
- Test: `eval/usefulness/select.test.ts`

**Interfaces:**
- Consumes: `RetrievedHit` (Task 1), and `Rng` / `sample` from `eval/rng.ts`.
- Produces:
  - `FETCH_K = 30`, `TOP_K = 8`, `MAX_EXPOSED = 60`, `MAX_CONTROL = 20`
  - `filterForCutoff(hits: readonly RetrievedHit[], q: { sessionId: string; cutoff: string }, k?: number): { top: RetrievedHit[]; droppedNonSession: number; droppedLeak: number }`
  - `exposedTo(top: readonly RetrievedHit[], rejectIds: ReadonlySet<string>): string[]`
  - `sampleSets(exposedIds: readonly string[], otherIds: readonly string[], rng: Rng, maxExposed?: number, maxControl?: number): { exposed: string[]; control: string[] }`
  - `sessionIdFromNote(content: string): string | null`

- [ ] **Step 1: Write the failing test** — `eval/usefulness/select.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { makeRng } from "../rng.js";
import type { RetrievedHit } from "./types.js";
import { exposedTo, filterForCutoff, sampleSets, sessionIdFromNote } from "./select.js";

const hit = (sessionId: string | null, startedAt: string | null, title = sessionId ?? "topic"): RetrievedHit => ({
  filePath: `/v/${title}.md`, title, content: "c", score: 1, method: "embedding", sessionId, startedAt,
});
const Q = { sessionId: "q", cutoff: "2026-09-10T00:00:00.000Z" };

describe("filterForCutoff", () => {
  it("keeps earlier session notes in rank order, up to k", () => {
    const hits = [hit("a", "2026-09-01T00:00:00.000Z"), hit("b", "2026-09-02T00:00:00.000Z"), hit("c", "2026-09-03T00:00:00.000Z")];
    expect(filterForCutoff(hits, Q, 2).top.map((h) => h.sessionId)).toEqual(["a", "b"]);
  });

  // D5: the answer must not be sitting in a note written after the question.
  it("drops notes from the question's own session and from later or same-time sessions", () => {
    const hits = [
      hit("q", "2026-09-01T00:00:00.000Z"),
      hit("later", "2026-09-11T00:00:00.000Z"),
      hit("same", "2026-09-10T00:00:00.000Z"),
      hit("ok", "2026-09-09T00:00:00.000Z"),
    ];
    const r = filterForCutoff(hits, Q);
    expect(r.top.map((h) => h.sessionId)).toEqual(["ok"]);
    expect(r.droppedLeak).toBe(3);
  });

  // A topic page can summarize later sessions; articles/PDFs have no start time.
  it("drops non-session hits and hits with no start time", () => {
    const r = filterForCutoff([hit(null, null), hit("nodate", null), hit("ok", "2026-09-01T00:00:00.000Z")], Q);
    expect(r.top.map((h) => h.sessionId)).toEqual(["ok"]);
    expect(r.droppedNonSession).toBe(1);
    expect(r.droppedLeak).toBe(1);
  });
});

describe("exposedTo", () => {
  it("lists the rejects present in the top k", () => {
    const top = [hit("a", "x"), hit("r1", "x"), hit(null, null), hit("r2", "x")];
    expect(exposedTo(top, new Set(["r1", "r2", "r3"]))).toEqual(["r1", "r2"]);
  });
});

describe("sampleSets", () => {
  it("is stable for a seed", () => {
    const ex = Array.from({ length: 80 }, (_, i) => `e${i}`);
    const other = Array.from({ length: 50 }, (_, i) => `o${i}`);
    const a = sampleSets(ex, other, makeRng(7));
    const b = sampleSets(ex, other, makeRng(7));
    expect(a).toEqual(b);
    expect(a.exposed).toHaveLength(60);
    expect(a.control).toHaveLength(20);
  });

  // Never pad with synthetic questions: fewer than the cap means use them all.
  it("uses every exposed question when there are fewer than the cap", () => {
    expect(sampleSets(["e1", "e2"], ["o1"], makeRng(1)).exposed.sort()).toEqual(["e1", "e2"]);
  });
});

describe("sessionIdFromNote", () => {
  it("reads session_id from the frontmatter", () => {
    expect(sessionIdFromNote("---\ntopic: \"x\"\nsession_id: abc-123\n---\nbody")).toBe("abc-123");
  });
  it("returns null for notes without one (topics, articles, PDFs)", () => {
    expect(sessionIdFromNote("---\ntype: topic\n---\nbody\nsession_id: not-in-frontmatter")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run eval/usefulness/select.test.ts`
Expected: FAIL, "Cannot find module './select.js'".

- [ ] **Step 3: Implement** `eval/usefulness/select.ts`:

```ts
import { sample, type Rng } from "../rng.js";
import type { RetrievedHit } from "./types.js";

export const FETCH_K = 30;
export const TOP_K = 8;
export const MAX_EXPOSED = 60;
export const MAX_CONTROL = 20;

// Post-filter production's top-30 down to 8 the question may legitimately see
// (spec D5). ISO timestamps compare correctly as strings.
export function filterForCutoff(
  hits: readonly RetrievedHit[],
  q: { sessionId: string; cutoff: string },
  k: number = TOP_K,
): { top: RetrievedHit[]; droppedNonSession: number; droppedLeak: number } {
  const top: RetrievedHit[] = [];
  let droppedNonSession = 0;
  let droppedLeak = 0;
  for (const h of hits) {
    if (top.length >= k) break;
    if (h.sessionId === null) {
      droppedNonSession += 1;
      continue;
    }
    // A note with no start time cannot be shown to predate the question.
    if (h.sessionId === q.sessionId || h.startedAt === null || h.startedAt >= q.cutoff) {
      droppedLeak += 1;
      continue;
    }
    top.push(h);
  }
  return { top, droppedNonSession, droppedLeak };
}

export function exposedTo(top: readonly RetrievedHit[], rejectIds: ReadonlySet<string>): string[] {
  return top.flatMap((h) => (h.sessionId !== null && rejectIds.has(h.sessionId) ? [h.sessionId] : []));
}

export function sampleSets(
  exposedIds: readonly string[],
  otherIds: readonly string[],
  rng: Rng,
  maxExposed: number = MAX_EXPOSED,
  maxControl: number = MAX_CONTROL,
): { exposed: string[]; control: string[] } {
  const exposed = exposedIds.length <= maxExposed ? [...exposedIds] : sample(exposedIds, maxExposed, rng);
  return { exposed, control: sample(otherIds, maxControl, rng) };
}

// The full session id in frontmatter is the authority; the 8-hex filename
// suffix can collide (writer.ts belongsToSession).
export function sessionIdFromNote(content: string): string | null {
  const block = /^---\n([\s\S]*?)\n---/.exec(content)?.[1];
  if (block === undefined) return null;
  const m = /^session_id:\s*(\S+)\s*$/m.exec(block);
  return m?.[1] ?? null;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run eval/usefulness/select.test.ts`
Expected: PASS (9 new).

- [ ] **Step 5: Commit**

```bash
git add eval/usefulness/select.ts eval/usefulness/select.test.ts
git commit -m "feat(eval): usefulness selection — cutoff filter, exposure, seeded sampling"
```

---

### Task 3: Question mining — candidate filter, miner prompt, validation

**Files:**
- Create: `eval/usefulness/mine.ts`
- Test: `eval/usefulness/mine.test.ts`

**Interfaces:**
- Consumes: `MinedItem`, `DropReason` (Task 1).
- Produces:
  - `interface Candidate { path: string; project: string; sessionId: string; startedAt: string | null; category: "session" | "workflow" | "sidechain"; agent: boolean }`
  - `selectCandidates(cands: readonly Candidate[], noteStarts: ReadonlyMap<string, readonly string[]>): Candidate[]`
  - `MINER_PROMPT_VERSION = "mine-v1"`, `MAX_TRANSCRIPT_CHARS = 60_000`
  - `buildMinerPrompt(project: string, transcript: string): string`
  - `distinctiveTokens(fact: string): string[]`
  - `validateMined(reply: string, transcript: string): { items: MinedItem[]; drops: Record<DropReason, number> }`

- [ ] **Step 1: Write the failing test** — `eval/usefulness/mine.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { buildMinerPrompt, distinctiveTokens, selectCandidates, validateMined, type Candidate } from "./mine.js";

const cand = (over: Partial<Candidate>): Candidate => ({
  path: "/p/a.jsonl", project: "vir", sessionId: "s1", startedAt: "2026-09-10T00:00:00.000Z",
  category: "session", agent: false, ...over,
});

describe("selectCandidates", () => {
  const notes = new Map([["vir", ["2026-09-01T00:00:00.000Z"]], ["late", ["2026-09-20T00:00:00.000Z"]]]);

  it("keeps a human session in a project with an earlier note", () => {
    expect(selectCandidates([cand({})], notes)).toHaveLength(1);
  });
  it("drops sidechain, workflow and SDK-agent transcripts", () => {
    expect(selectCandidates([cand({ category: "sidechain" }), cand({ category: "workflow" }), cand({ agent: true })], notes)).toEqual([]);
  });
  it("drops sessions with no earlier note in their project, and sessions with no start time", () => {
    expect(selectCandidates([cand({ project: "late" }), cand({ project: "none" }), cand({ startedAt: null })], notes)).toEqual([]);
  });
});

describe("distinctiveTokens", () => {
  it("picks backticked terms, code-like identifiers and multi-digit numbers", () => {
    const t = distinctiveTokens("`servingGate()` in db.ts filters rows; listAudits caps at 40000 chars");
    expect(t).toEqual(expect.arrayContaining(["servingGate()", "db.ts", "listAudits", "40000"]));
  });
});

describe("validateMined", () => {
  const transcript = "we decided listAudits must use servingGate so rejected rows never serve. chose Paddle over Stripe for Kosovo.";

  it("keeps a well-formed item whose evidence is in the transcript", () => {
    const reply = JSON.stringify([{
      question: "How are rejected rows kept out of the audit list?",
      facts: ["listAudits uses servingGate", "rejected rows never serve"],
      evidence: ["listAudits must use servingGate", "rejected rows never serve"],
    }]);
    const r = validateMined(reply, transcript);
    expect(r.items).toHaveLength(1);
    expect(r.drops).toEqual({ unparsed: 0, "fact-count": 0, "answer-in-question": 0, "bad-evidence": 0 });
  });

  it("drops an item with fewer than 2 or more than 4 facts", () => {
    const one = { question: "q?", facts: ["a"], evidence: ["servingGate"] };
    const five = { question: "q?", facts: ["a", "b", "c", "d", "e"], evidence: ["x", "x", "x", "x", "x"] };
    expect(validateMined(JSON.stringify([one, five]), transcript).drops["fact-count"]).toBe(2);
  });

  // Ruling R2: a question may name its subject; it may not already contain every distinctive token of a fact.
  it("drops an item whose question already carries a fact's distinctive tokens", () => {
    const leaky = { question: "Does listAudits use servingGate?", facts: ["listAudits uses servingGate", "rejected rows never serve"], evidence: ["servingGate", "never serve"] };
    const fine = { question: "How does listAudits keep rejected rows out?", facts: ["listAudits uses servingGate", "rejected rows never serve"], evidence: ["servingGate", "never serve"] };
    const r = validateMined(JSON.stringify([leaky, fine]), transcript);
    expect(r.items.map((i) => i.question)).toEqual(["How does listAudits keep rejected rows out?"]);
    expect(r.drops["answer-in-question"]).toBe(1);
  });

  it("drops an item whose evidence is not in the transcript (whitespace/case-insensitive)", () => {
    const bad = { question: "Which billing provider?", facts: ["Paddle", "because Kosovo"], evidence: ["chose  PADDLE over stripe", "invented quote"] };
    expect(validateMined(JSON.stringify([bad]), transcript).drops["bad-evidence"]).toBe(1);
  });

  it("counts an unparseable reply once and returns no items", () => {
    const r = validateMined("I cannot help", transcript);
    expect(r.items).toEqual([]);
    expect(r.drops.unparsed).toBe(1);
  });

  it("accepts an empty array (nothing to learn) with no drops", () => {
    expect(validateMined("[]", transcript)).toEqual({
      items: [], drops: { unparsed: 0, "fact-count": 0, "answer-in-question": 0, "bad-evidence": 0 },
    });
  });
});

describe("buildMinerPrompt", () => {
  it("carries the project, the transcript and the no-answer rule", () => {
    const p = buildMinerPrompt("vir", "TRANSCRIPT-BODY");
    expect(p).toContain("project: vir");
    expect(p).toContain("TRANSCRIPT-BODY");
    expect(p).toContain("must not contain the answer");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run eval/usefulness/mine.test.ts`
Expected: FAIL, "Cannot find module './mine.js'".

- [ ] **Step 3: Implement** `eval/usefulness/mine.ts`:

```ts
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

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

function emptyDrops(): Record<DropReason, number> {
  return { unparsed: 0, "fact-count": 0, "answer-in-question": 0, "bad-evidence": 0 };
}

export function validateMined(reply: string, transcript: string): { items: MinedItem[]; drops: Record<DropReason, number> } {
  const drops = emptyDrops();
  const match = reply.match(/\[[\s\S]*\]/);
  let raw: unknown;
  try {
    raw = match ? JSON.parse(match[0]) : undefined;
  } catch {
    raw = undefined;
  }
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run eval/usefulness/mine.test.ts`
Expected: PASS (10 new). If `distinctiveTokens` misses an expected token, fix the regex, not the test: each listed token is a real code-like term.

- [ ] **Step 5: Commit**

```bash
git add eval/usefulness/mine.ts eval/usefulness/mine.test.ts
git commit -m "feat(eval): usefulness mining — candidate filter, miner prompt, reply validation"
```

---

### Task 4: Grading and grader probes

**Files:**
- Create: `eval/usefulness/grade.ts`, `eval/usefulness/probes.ts`
- Test: `eval/usefulness/grade.test.ts`, `eval/usefulness/probes.test.ts`

**Interfaces:**
- Consumes: `FactVerdict`, `AnswerScore`, `ProbeSummary` (Task 1).
- Produces:
  - `GRADER_PROMPT_VERSION = "grade-v1"`
  - `buildGraderPrompt(question: string, facts: readonly string[], answer: string): string`
  - `parseGrade(reply: string, factCount: number): FactVerdict[] | null`
  - `scoreAnswer(v: readonly FactVerdict[]): AnswerScore`
  - `NEGATION_PROMPT_VERSION = "negate-v1"`, `NULL_ANSWER`
  - `oracleAnswer(facts: readonly string[]): string`
  - `buildNegationPrompt(facts: readonly string[]): string`
  - `parseNegation(reply: string, factCount: number): string | null`
  - `evaluateProbes(input: { oracle: FactVerdict[][]; nulls: FactVerdict[][]; negation: FactVerdict[][]; regrade: Array<[FactVerdict[], FactVerdict[]]> }): ProbeSummary`

- [ ] **Step 1: Write the failing tests**

`eval/usefulness/grade.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildGraderPrompt, parseGrade, scoreAnswer } from "./grade.js";

describe("parseGrade", () => {
  it("parses one verdict per fact, in fact order", () => {
    const reply = '```json\n[{"fact":2,"verdict":"missing","why":"x"},{"fact":1,"verdict":"stated","why":"y"}]\n```';
    expect(parseGrade(reply, 2)).toEqual(["stated", "missing"]);
  });
  it("rejects a reply that skips or repeats a fact", () => {
    expect(parseGrade('[{"fact":1,"verdict":"stated"}]', 2)).toBeNull();
    expect(parseGrade('[{"fact":1,"verdict":"stated"},{"fact":1,"verdict":"missing"}]', 2)).toBeNull();
  });
  it("rejects an unknown verdict or non-JSON", () => {
    expect(parseGrade('[{"fact":1,"verdict":"maybe"}]', 1)).toBeNull();
    expect(parseGrade("no json here", 1)).toBeNull();
  });
});

describe("scoreAnswer", () => {
  it("computes recall and contradiction as shares of the facts", () => {
    expect(scoreAnswer(["stated", "missing", "contradicted", "stated"])).toEqual({ recall: 0.5, contradiction: 0.25 });
  });
});

describe("buildGraderPrompt", () => {
  it("numbers the facts and includes exactly one answer", () => {
    const p = buildGraderPrompt("Q?", ["f one", "f two"], "THE-ANSWER");
    expect(p).toContain("1. f one");
    expect(p).toContain("2. f two");
    expect(p).toContain("THE-ANSWER");
  });
});
```

`eval/usefulness/probes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { FactVerdict } from "./types.js";
import { evaluateProbes, oracleAnswer, parseNegation } from "./probes.js";

const S: FactVerdict = "stated";
const M: FactVerdict = "missing";
const C: FactVerdict = "contradicted";
const good = {
  oracle: Array.from({ length: 20 }, () => [S, S]),
  nulls: Array.from({ length: 20 }, () => [M, M]),
  negation: Array.from({ length: 20 }, () => [C, C]),
  regrade: Array.from({ length: 10 }, (): [FactVerdict[], FactVerdict[]] => [[S, M], [S, M]]),
};

describe("evaluateProbes", () => {
  it("passes when every probe meets its threshold", () => {
    const r = evaluateProbes(good);
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("fails the oracle probe below 0.95 mean recall", () => {
    const oracle = [...good.oracle.slice(0, 18), [S, M], [M, M]];
    expect(evaluateProbes({ ...good, oracle }).failures).toContain("oracle recall 0.93 < 0.95");
  });

  it("fails the null probe when a grader credits an empty answer", () => {
    const nulls = [...good.nulls.slice(0, 18), [S, M], [S, M]];
    expect(evaluateProbes({ ...good, nulls }).pass).toBe(false);
  });

  it("fails the negation probe below 0.90 mean contradiction", () => {
    const negation = [...good.negation.slice(0, 16), [M, M], [M, M], [C, M], [C, M]];
    expect(evaluateProbes({ ...good, negation }).pass).toBe(false);
  });

  it("fails re-grade agreement below 0.90", () => {
    const regrade = Array.from({ length: 10 }, (_, i): [FactVerdict[], FactVerdict[]] => (i < 3 ? [[S, S], [M, M]] : [[S, S], [S, S]]));
    expect(evaluateProbes({ ...good, regrade }).failures).toContain("regrade agreement 0.70 < 0.90");
  });

  // An empty probe is not evidence the grader works.
  it("fails when a probe has no samples", () => {
    expect(evaluateProbes({ ...good, regrade: [] }).failures).toContain("regrade: no samples");
  });
});

describe("oracleAnswer / parseNegation", () => {
  it("restates every fact", () => {
    expect(oracleAnswer(["a", "b."])).toBe("a. b.");
  });
  it("parses exactly one negation per fact", () => {
    expect(parseNegation('["not a", "not b"]', 2)).toBe("not a. not b.");
    expect(parseNegation('["not a"]', 2)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run eval/usefulness/grade.test.ts eval/usefulness/probes.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`eval/usefulness/grade.ts`:

```ts
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
```

`eval/usefulness/probes.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run eval/usefulness/grade.test.ts eval/usefulness/probes.test.ts`
Expected: PASS (13 new).

- [ ] **Step 5: Commit**

```bash
git add eval/usefulness/grade.ts eval/usefulness/probes.ts eval/usefulness/grade.test.ts eval/usefulness/probes.test.ts
git commit -m "feat(eval): usefulness grading and known-answer grader probes"
```

---

### Task 5: The gate

**Files:**
- Create: `eval/usefulness/gate.ts`
- Test: `eval/usefulness/gate.test.ts`

**Interfaces:**
- Consumes: `pairedBootstrapCI` (`eval/metrics/bootstrap.ts`), `Rng`, `AnswerScore`, `GateResult` (Task 1).
- Produces:
  - `NONINFERIORITY_RECALL = -0.05`, `MAX_CONTRA_RISE = 0.02`, `MIN_EXPOSED = 15`, `MAX_DEGRADED_SHARE = 0.25`, `BOOTSTRAP_ROUNDS = 2000`
  - `interface GateInput { rejectCount: number; probesPass: boolean; probeFailures: string[]; sampledExposed: number; excludedDegraded: number; pairs: ReadonlyArray<{ full: AnswerScore; ablated: AnswerScore }>; rng: Rng }`
  - `computeVerdict(i: GateInput): GateResult`

- [ ] **Step 1: Write the failing test** — `eval/usefulness/gate.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { makeRng } from "../rng.js";
import { computeVerdict, type GateInput } from "./gate.js";

const pair = (fr: number, ar: number, fc = 0, ac = 0) => ({ full: { recall: fr, contradiction: fc }, ablated: { recall: ar, contradiction: ac } });
const base = (over: Partial<GateInput> = {}): GateInput => ({
  rejectCount: 21, probesPass: true, probeFailures: [], sampledExposed: 20, excludedDegraded: 0,
  pairs: Array.from({ length: 20 }, () => pair(0.5, 0.5)), rng: makeRng(1), ...over,
});

describe("computeVerdict", () => {
  it("passes when removing rejects changes nothing", () => {
    expect(computeVerdict(base()).verdict).toBe("PASS");
  });

  // Review Focus 1: a vacuous PASS would wave --apply-rejects through.
  it("gives no verdict when there are no rejects to test", () => {
    const r = computeVerdict(base({ rejectCount: 0 }));
    expect(r).toMatchObject({ verdict: "NO VERDICT", reason: "no fresh reject verdicts to test" });
  });

  it("gives no verdict when the grader probes failed, before anything else", () => {
    const r = computeVerdict(base({ probesPass: false, probeFailures: ["oracle recall 0.80 < 0.95"], pairs: [] }));
    expect(r.verdict).toBe("NO VERDICT");
    expect(r.reason).toContain("grader unreliable");
  });

  it("gives no verdict below 15 exposed questions", () => {
    expect(computeVerdict(base({ pairs: Array.from({ length: 14 }, () => pair(0.5, 0.5)) })).reason).toContain("insufficient sample");
  });

  // Review Focus 2: Ollama down → everything degraded.
  it("gives no verdict when more than 25% of sampled exposed questions degraded", () => {
    expect(computeVerdict(base({ sampledExposed: 30, excludedDegraded: 8, pairs: Array.from({ length: 22 }, () => pair(0.5, 0.5)) })).reason).toContain("retrieval degraded");
  });

  it("fails when recall drops by 10 points everywhere", () => {
    expect(computeVerdict(base({ pairs: Array.from({ length: 20 }, () => pair(0.6, 0.5)) })).verdict).toBe("FAIL");
  });

  it("fails at exactly −0.05 (the bound is strict)", () => {
    expect(computeVerdict(base({ pairs: Array.from({ length: 20 }, () => pair(0.55, 0.5)) })).verdict).toBe("FAIL");
  });

  it("fails when contradictions rise by more than 2 points", () => {
    expect(computeVerdict(base({ pairs: Array.from({ length: 20 }, () => pair(0.5, 0.5, 0, 0.05)) })).verdict).toBe("FAIL");
  });

  it("passes at exactly +0.02 contradiction (the bound is ≤)", () => {
    expect(computeVerdict(base({ pairs: Array.from({ length: 20 }, () => pair(0.5, 0.5, 0, 0.02)) })).verdict).toBe("PASS");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run eval/usefulness/gate.test.ts`
Expected: FAIL, "Cannot find module './gate.js'".

- [ ] **Step 3: Implement** `eval/usefulness/gate.ts`:

```ts
import { pairedBootstrapCI } from "../metrics/bootstrap.js";
import type { Rng } from "../rng.js";
import type { AnswerScore, GateResult } from "./types.js";

// Frozen in the spec (§7) before any run. Changing one is a spec change.
export const NONINFERIORITY_RECALL = -0.05;
export const MAX_CONTRA_RISE = 0.02;
export const MIN_EXPOSED = 15;
export const MAX_DEGRADED_SHARE = 0.25;
export const BOOTSTRAP_ROUNDS = 2000;

export interface GateInput {
  rejectCount: number;
  probesPass: boolean;
  probeFailures: string[];
  sampledExposed: number;
  excludedDegraded: number;
  pairs: ReadonlyArray<{ full: AnswerScore; ablated: AnswerScore }>;
  rng: Rng;
}

export function computeVerdict(i: GateInput): GateResult {
  const recall = pairedBootstrapCI(i.pairs.map((p) => p.ablated.recall - p.full.recall), BOOTSTRAP_ROUNDS, i.rng);
  const contradiction = pairedBootstrapCI(
    i.pairs.map((p) => p.ablated.contradiction - p.full.contradiction),
    BOOTSTRAP_ROUNDS,
    i.rng,
  );
  const result = (verdict: GateResult["verdict"], reason: string): GateResult => ({
    verdict, reason, n: i.pairs.length, recall, contradiction,
  });
  // Ruling R5: nothing to remove means nothing was tested.
  if (i.rejectCount === 0) return result("NO VERDICT", "no fresh reject verdicts to test");
  if (!i.probesPass) return result("NO VERDICT", `grader unreliable: ${i.probeFailures.join("; ")}`);
  if (i.pairs.length < MIN_EXPOSED) return result("NO VERDICT", `insufficient sample: ${i.pairs.length} < ${MIN_EXPOSED} exposed questions`);
  if (i.sampledExposed > 0 && i.excludedDegraded / i.sampledExposed > MAX_DEGRADED_SHARE) {
    return result("NO VERDICT", `retrieval degraded: ${i.excludedDegraded}/${i.sampledExposed} exposed questions fell back to TF-IDF — is Ollama running?`);
  }
  if (recall.lo <= NONINFERIORITY_RECALL) return result("FAIL", `recall CI lower bound ${recall.lo.toFixed(3)} ≤ ${NONINFERIORITY_RECALL}`);
  if (contradiction.hi > MAX_CONTRA_RISE) return result("FAIL", `contradiction CI upper bound ${contradiction.hi.toFixed(3)} > +${MAX_CONTRA_RISE}`);
  return result("PASS", `recall CI [${recall.lo.toFixed(3)}, ${recall.hi.toFixed(3)}], contradiction CI [${contradiction.lo.toFixed(3)}, ${contradiction.hi.toFixed(3)}]`);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run eval/usefulness/gate.test.ts`
Expected: PASS (9 new).

- [ ] **Step 5: Commit**

```bash
git add eval/usefulness/gate.ts eval/usefulness/gate.test.ts
git commit -m "feat(eval): usefulness gate — frozen non-inferiority verdict"
```

---

### Task 6: Arm homes, ablation, retrieval worker

**Files:**
- Create: `eval/usefulness/homes.ts`, `eval/usefulness/worker.ts`, `eval/usefulness/retrieve.ts`
- Modify:
  - `eval/runArm.ts`: extract `assertArmIsolation`, used by `runArm`
  - `eval/repo.ts`: add `USEFULNESS_WORKER_JS`
- Test: `eval/usefulness/homes.test.ts`, `eval/runArm.test.ts` (new)

**Interfaces:**
- Consumes:
  - `prepareHomes({ arms, refresh })` and `armHome(arm)` (existing)
  - `StateDb.markRejected`, `StateDb.listDistilled`, `searchWithOutcome`
  - `sessionIdFromNote`, `FETCH_K` (Task 2)
  - `ArmRetrieval`, `RetrievedHit`, `UsefulnessArmOutput`, `MinedQuestion`, `RetrievalArm` (Task 1)
- Produces:
  - `USEFULNESS_ARM_SPECS: Record<RetrievalArm, ArmSpec>`
  - `applyAblation(dbPath: string, sessionIds: readonly string[]): number`
  - `prepareUsefulnessHomes(rejectIds: readonly string[]): Promise<{ ablatedMarked: number }>`
  - `assertArmIsolation(out: { home: string; dbPath: string; configPath: string; embedderDir: string }, home: string, armId: string): void`
  - `runUsefulnessArm(arm: RetrievalArm, questions: readonly MinedQuestion[]): Promise<ArmRetrieval[]>`

- [ ] **Step 1: Write the failing tests**

`eval/usefulness/homes.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateDb } from "../../src/state/db.js";
import { applyAblation } from "./homes.js";

const sid = (n: number): string => `abc1234${n}-0000-4000-8000-000000000001`;

describe("applyAblation", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-uhome-"));
    dbPath = join(dir, "vir.db");
    const db = new StateDb(dbPath);
    for (const n of [1, 2]) {
      db.record({
        path: `/p/-home-u-app/${sid(n)}.jsonl`, hash: `h${n}`, skipped: false, notePaths: [], content: `b${n}`,
        category: "gotcha", topic: `t${n}`, project: "app", confidence: 0.9, startedAt: "2026-05-01T00:00:00.000Z",
      });
    }
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The ablated arm must hide rejects through the production serving gate.
  it("marks the listed sessions rejected in that DB copy only", () => {
    expect(applyAblation(dbPath, [sid(1)])).toBe(1);
    const db = new StateDb(dbPath, { readonly: true });
    try {
      expect(db.listDistilled().map((r) => r.sessionId)).toEqual([sid(2)]);
    } finally {
      db.close();
    }
  });
});
```

`eval/runArm.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertArmIsolation } from "./runArm.js";

describe("assertArmIsolation", () => {
  const ok = { home: "/h", dbPath: "/h/.vir/vir.db", configPath: "/h/.vir/config.json", embedderDir: "/h/.vir/embedder" };
  it("accepts paths inside the arm home", () => {
    expect(() => assertArmIsolation(ok, "/h", "a")).not.toThrow();
  });
  it("rejects a path outside the arm home", () => {
    expect(() => assertArmIsolation({ ...ok, dbPath: "/real/.vir/vir.db" }, "/h", "a")).toThrow(/isolation violated/);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run eval/usefulness/homes.test.ts eval/runArm.test.ts`
Expected: FAIL, modules or exports not found.

- [ ] **Step 3: Implement**

In `eval/runArm.ts`, replace the inline `for (const [k, v] of [...]) { … }` isolation loop at the end of `runArm` with a call to `assertArmIsolation(out, home, arm.id);`, and add:

```ts
// Shared by every arm worker: the isolation claim is checked on every run.
export function assertArmIsolation(
  out: { home: string; dbPath: string; configPath: string; embedderDir: string },
  home: string,
  armId: string,
): void {
  for (const [k, v] of [
    ["home", out.home],
    ["dbPath", out.dbPath],
    ["configPath", out.configPath],
    ["embedderDir", out.embedderDir],
  ] as const) {
    if (!v.startsWith(home + "/") && v !== home) {
      throw new Error(`isolation violated: arm ${armId} resolved ${k}=${v}, expected under ${home}`);
    }
  }
}
```

In `eval/repo.ts` add:

```ts
export const USEFULNESS_WORKER_JS = join(REPO_ROOT, "eval", "dist", "eval", "usefulness", "worker.js");
```

`eval/usefulness/homes.ts`:

```ts
import { join } from "node:path";
import { StateDb } from "../../src/state/db.js";
import type { ArmSpec } from "../arms.js";
import { prepareHomes } from "../prepareHomes.js";
import { armHome } from "../runArm.js";
import type { RetrievalArm } from "./types.js";

// Both arms are the harness's production baseline (nomic, MMR on); they differ
// only in the DB copy.
export const USEFULNESS_ARM_SPECS: Record<RetrievalArm, ArmSpec> = {
  full: { id: "usefulness-full", provider: "ollama", mmr: true, label: "usefulness: full vault" },
  ablated: { id: "usefulness-ablated", provider: "ollama", mmr: true, label: "usefulness: audit rejects removed" },
};

// Uses the production reject gate, so the ablation hides exactly what
// `vir audit --apply-rejects` would. Only ever called on an arm's DB copy.
export function applyAblation(dbPath: string, sessionIds: readonly string[]): number {
  const db = new StateDb(dbPath);
  try {
    return sessionIds.reduce((n, id) => n + db.markRejected(id), 0);
  } finally {
    db.close();
  }
}

// Fresh copies every run: a stale ablated copy from an earlier reject set
// would silently test the wrong thing.
export async function prepareUsefulnessHomes(rejectIds: readonly string[]): Promise<{ ablatedMarked: number }> {
  await prepareHomes({ arms: [USEFULNESS_ARM_SPECS.full, USEFULNESS_ARM_SPECS.ablated], refresh: true });
  return { ablatedMarked: applyAblation(join(armHome(USEFULNESS_ARM_SPECS.ablated), ".vir", "vir.db"), rejectIds) };
}
```

`eval/usefulness/worker.ts` (child entry; `HOME` is the arm home):

```ts
// Child-process entry for one usefulness arm. HOME is the arm home, so every
// production path constant resolves inside it. Read-only DB, production
// retriever, one JSON file out.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { CONFIG_PATH, STATE_PATH, loadConfig } from "../../src/config.js";
import { LOCAL_PROVIDER_DIR } from "../../src/search/localProvider.js";
import { searchWithOutcome } from "../../src/search/retriever.js";
import { StateDb } from "../../src/state/db.js";
import { sessionIdFromNote } from "./select.js";
import type { ArmRetrieval, UsefulnessArmOutput } from "./types.js";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`usefulness worker: missing --${name}`);
  return v;
}

async function main(): Promise<void> {
  const armId = arg("arm");
  const limit = Number.parseInt(arg("limit"), 10);
  const questions = JSON.parse(readFileSync(arg("questions"), "utf8")) as Array<{ id: string; question: string }>;
  const cfg = loadConfig();
  const db = new StateDb(STATE_PATH, { readonly: true });
  const results: ArmRetrieval[] = [];
  try {
    const starts = new Map(db.listDistilled().map((r) => [r.sessionId, r.startedAt]));
    for (const q of questions) {
      const o = await searchWithOutcome(cfg, db, q.question, limit);
      results.push({
        questionId: q.id,
        method: o.method,
        degraded: o.degraded,
        hits: o.hits.map((h) => {
          const sessionId = existsSync(h.filePath) ? sessionIdFromNote(readFileSync(h.filePath, "utf8")) : null;
          return {
            filePath: h.filePath, title: h.title, content: h.content, score: h.score, method: h.method,
            sessionId, startedAt: sessionId === null ? null : (starts.get(sessionId) ?? null),
          };
        }),
      });
    }
  } finally {
    db.close();
  }
  const out: UsefulnessArmOutput = {
    armId, home: homedir(), dbPath: STATE_PATH, configPath: CONFIG_PATH, embedderDir: LOCAL_PROVIDER_DIR, results,
  };
  writeFileSync(arg("out"), JSON.stringify(out), "utf8");
}

main().catch((err: unknown) => {
  process.stderr.write(`usefulness worker failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
```

`eval/usefulness/retrieve.ts`:

```ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USEFULNESS_WORKER_JS } from "../repo.js";
import { armHome, assertArmIsolation } from "../runArm.js";
import { USEFULNESS_ARM_SPECS } from "./homes.js";
import { FETCH_K } from "./select.js";
import type { ArmRetrieval, MinedQuestion, RetrievalArm, UsefulnessArmOutput } from "./types.js";

export async function runUsefulnessArm(arm: RetrievalArm, questions: readonly MinedQuestion[]): Promise<ArmRetrieval[]> {
  const spec = USEFULNESS_ARM_SPECS[arm];
  const home = armHome(spec);
  if (!existsSync(join(home, ".vir", "config.json"))) throw new Error(`arm home not prepared: ${home}`);
  if (!existsSync(USEFULNESS_WORKER_JS)) throw new Error(`worker not built: ${USEFULNESS_WORKER_JS} (run \`npm run eval:build\`)`);
  const tmp = join(home, "tmp");
  mkdirSync(tmp, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}`;
  const inPath = join(tmp, `uq-${stamp}.json`);
  const outPath = join(tmp, `uout-${stamp}.json`);
  writeFileSync(inPath, JSON.stringify(questions.map((q) => ({ id: q.id, question: q.question }))));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [USEFULNESS_WORKER_JS, "--arm", spec.id, "--questions", inPath, "--limit", String(FETCH_K), "--out", outPath],
        { env: { ...process.env, HOME: home }, stdio: ["ignore", "inherit", "inherit"] },
      );
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`usefulness arm ${spec.id} worker exited ${code}`))));
    });
    const out = JSON.parse(readFileSync(outPath, "utf8")) as UsefulnessArmOutput;
    assertArmIsolation(out, home, spec.id);
    return out.results;
  } finally {
    for (const p of [inPath, outPath]) if (existsSync(p)) unlinkSync(p);
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run eval/usefulness/homes.test.ts eval/runArm.test.ts && npx tsc --noEmit -p eval/tsconfig.json && npm run eval:build`
Expected: PASS (3 new). `eval/dist/eval/usefulness/worker.js` exists.

- [ ] **Step 5: Commit**

```bash
git add eval/runArm.ts eval/runArm.test.ts eval/repo.ts eval/usefulness/homes.ts eval/usefulness/homes.test.ts eval/usefulness/worker.ts eval/usefulness/retrieve.ts
git commit -m "feat(eval): usefulness arm homes, ablation via the production reject gate, retrieval worker"
```

---

### Task 7: Orchestration — mine, run, show — and the CLI entry

**Files:**
- Modify: `src/search/synthesizer.ts` (optional `stage` parameter, Ruling R4), `eval/main.ts`
- Create: `eval/usefulness/mineRun.ts`, `eval/usefulness/run.ts`
- Test: `eval/usefulness/run.test.ts`

**Interfaces:**
- Consumes: everything above. Also `callJudge` / `mapLimit` / `EVAL_MODEL` (`eval/llm.ts`), `makeRng` / `shuffle` / `sample` (`eval/rng.ts`), `pairedBootstrapCI`, `synthesize`, and production `scanSessions`, `parseSession`, `classifyTranscript`, `projectNameFor`, `filterToolCalls`, `scrub`, `loadConfig`, `StateDb`.
- Produces:
  - `synthesize(cfg, query, hits, stage?: string)`
  - `mineQuestions(opts: { dryRun: boolean; deps?: Partial<MineDeps> }): Promise<QuestionFile | null>`
  - `interface RunDeps { llm(stage: "eval-usefulness-grade" | "eval-usefulness-probe", prompt: string, session: string): Promise<string>; answer(question: string, hits: readonly RetrievedHit[]): Promise<string>; retrieve(arm: RetrievalArm, qs: readonly MinedQuestion[]): Promise<ArmRetrieval[]>; rejectIds(): string[]; prepareHomes(rejectIds: readonly string[]): Promise<void>; cache: ResultCache; now(): string; git(): { sha: string; dirty: boolean }; questionsPath: string; runsDir: string }`
  - `usefulnessRun(opts: { seed: number; dryRun: boolean; deps?: Partial<RunDeps> }): Promise<RunRecord | null>`
  - `showLatestRun(runsDir?: string): string`

- [ ] **Step 1: Write the failing integration test** — `eval/usefulness/run.test.ts`

```ts
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run eval/usefulness/run.test.ts`
Expected: FAIL, "Cannot find module './run.js'".

- [ ] **Step 3: Implement**

In `src/search/synthesizer.ts`, change the signature to `export async function synthesize(cfg: Config, query: string, hits: SearchHit[], stage: string = "query-synthesis"): Promise<string>`, and the cost context to `cost: { stage },`. Nothing else changes.

`eval/usefulness/mineRun.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, STATE_PATH } from "../../src/config.js";
import { parseSession } from "../../src/pipeline/parser.js";
import { classifyTranscript, projectNameFor } from "../../src/pipeline/projects.js";
import { scanSessions } from "../../src/pipeline/scanner.js";
import { scrub } from "../../src/pipeline/scrubber.js";
import { filterToolCalls } from "../../src/pipeline/toolCallFilter.js";
import { StateDb } from "../../src/state/db.js";
import { callJudge, EVAL_MODEL, mapLimit } from "../llm.js";
import { USEFULNESS_CACHE_DIR, USEFULNESS_QUESTIONS_PATH } from "../paths.js";
import { createCache, type ResultCache } from "./cache.js";
import { buildMinerPrompt, MAX_TRANSCRIPT_CHARS, MINER_PROMPT_VERSION, selectCandidates, validateMined, type Candidate } from "./mine.js";
import type { DropReason, MinedQuestion, QuestionFile } from "./types.js";

export interface MineDeps {
  llm(prompt: string, session: string): Promise<string>;
  cache: ResultCache;
  now(): string;
  out: string;
}

export async function mineQuestions(opts: { dryRun: boolean; deps?: Partial<MineDeps> }): Promise<QuestionFile | null> {
  const d: MineDeps = {
    llm: async (prompt, session) => (await callJudge("eval-usefulness-mine", prompt, session)).text,
    cache: createCache(USEFULNESS_CACHE_DIR),
    now: () => new Date().toISOString(),
    out: USEFULNESS_QUESTIONS_PATH,
    ...opts.deps,
  };
  const cfg = loadConfig();
  const dir = cfg.claudeProjectsDir;
  const db = new StateDb(STATE_PATH, { readonly: true });
  const noteStarts = new Map<string, string[]>();
  try {
    for (const r of db.listDistilled()) {
      if (r.startedAt === null) continue;
      const p = projectNameFor(r.path, dir);
      noteStarts.set(p, [...(noteStarts.get(p) ?? []), r.startedAt]);
    }
  } finally {
    db.close();
  }
  const scanned = scanSessions(dir);
  const parsedBy = new Map<string, ReturnType<typeof parseSession>>();
  const cands: Candidate[] = [];
  for (const s of scanned) {
    const category = classifyTranscript(s.path, dir);
    if (category !== "session") continue;
    const project = projectNameFor(s.path, dir);
    const parsed = parseSession(s.path, s.hash, project);
    parsedBy.set(s.path, parsed);
    cands.push({
      path: s.path, project, sessionId: parsed.sessionId, startedAt: parsed.startedAt, category,
      agent: parsed.isSidechain || (parsed.entrypoint?.startsWith("sdk") ?? false),
    });
  }
  const chosen = selectCandidates(cands, noteStarts);
  const prompts = chosen.map((c) => {
    const p = parsedBy.get(c.path)!;
    const text = `${scrub(p.rawSummary)}\n\n${scrub(filterToolCalls(p.transcriptText, "moderate").filtered)}`.slice(0, MAX_TRANSCRIPT_CHARS);
    return { c, text, prompt: buildMinerPrompt(c.project, text) };
  });
  const key = (prompt: string): string[] => ["mine", MINER_PROMPT_VERSION, EVAL_MODEL, prompt];
  if (opts.dryRun) {
    const cached = prompts.filter((x) => d.cache.has(key(x.prompt))).length;
    process.stdout.write(`usefulness mine (dry run): ${scanned.length} transcripts, ${chosen.length} candidates, ${prompts.length - cached} model calls needed (${cached} cached)\n`);
    return null;
  }
  const drops: Record<DropReason, number> = { unparsed: 0, "fact-count": 0, "answer-in-question": 0, "bad-evidence": 0 };
  const questions: MinedQuestion[] = [];
  const results = await mapLimit(prompts, 2, async (x) => {
    const { value } = await d.cache.cached(key(x.prompt), () => d.llm(x.prompt, x.c.sessionId));
    return { x, v: validateMined(value, x.text) };
  });
  for (const { x, v } of results) {
    for (const k of Object.keys(drops) as DropReason[]) drops[k] += v.drops[k];
    v.items.forEach((item, i) => questions.push({
      ...item, id: `${x.c.sessionId}#${i}`, project: x.c.project, sessionId: x.c.sessionId,
      transcriptPath: x.c.path, cutoff: x.c.startedAt!,
    }));
  }
  const file: QuestionFile = {
    createdAt: d.now(), minerPromptVersion: MINER_PROMPT_VERSION, model: EVAL_MODEL,
    transcriptsSeen: scanned.length, candidates: chosen.length, drops, questions,
  };
  mkdirSync(dirname(d.out), { recursive: true });
  writeFileSync(d.out, JSON.stringify(file, null, 1));
  process.stdout.write(`usefulness mine: ${questions.length} questions from ${chosen.length} candidates; drops ${JSON.stringify(drops)}\n`);
  return file;
}
```

`eval/usefulness/run.ts`:

```ts
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
```

In `eval/main.ts`:
1. Import `mineQuestions` from `./usefulness/mineRun.js`, and `usefulnessRun` / `showLatestRun` from `./usefulness/run.js`.
2. Add a `case "usefulness":` that reads `process.argv[3]`:
   - `mine`: `await mineQuestions({ dryRun });`
   - `run`: `await usefulnessRun({ seed: opt("seed") ? seed : 20260926, dryRun });`
   - `show`: `process.stdout.write(\`${showLatestRun()}\n\`);`
   - anything else: print the usage and `process.exit(2)`.
3. Add these three lines to `USAGE`:
   ```
     usefulness mine   mine questions + facts from recent transcripts (--dry-run)
     usefulness run    full vs ablated vs none → PASS/FAIL/NO VERDICT for the audit's rejects (--seed, --dry-run)
     usefulness show   summary of the latest usefulness run
   ```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run eval/usefulness && npx tsc --noEmit -p . && npx tsc --noEmit -p eval/tsconfig.json && npx vitest run`
Expected: PASS (7 new in `run.test.ts`). Full suite: 887 + 56 new = 943. Report the real count.

- [ ] **Step 5: Commit**

```bash
git add src/search/synthesizer.ts eval/main.ts eval/usefulness/mineRun.ts eval/usefulness/run.ts eval/usefulness/run.test.ts
git commit -m "feat(eval): usefulness mine/run/show — full vs ablated vs none, gated verdict, resumable"
```

---

### Task 8: First real run (manual, on the reference vault)

- [ ] **Step 1:** `ollama list` must show `nomic-embed-text`, the production baseline arm. Then `npm run build` (arm homes need `dist/cli.js`) and `npm run eval:build`.
- [ ] **Step 2:** `npm run eval -- usefulness mine --dry-run`, then `npm run eval -- usefulness mine`. Record the transcripts, candidates, questions and drops by reason.
- [ ] **Step 3:** `npm run eval -- usefulness run --dry-run`. Record the rejects, the exposed questions available, and the expected calls.
- [ ] **Step 4:** `npm run eval -- usefulness run`. If a subscription limit stops it, re-run the same command after the reset; the cache resumes it.
- [ ] **Step 5:** `npm run eval -- usefulness show`. Put the verdict, both CIs, the probe results and exposed n in `CHANGELOG.md` under `## Unreleased`, as one bullet stating what was measured and the outcome. Add a line to `eval/README.md` "Commands" for the three `usefulness` subcommands.
- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md eval/README.md
git commit -m "docs: note-usefulness eval commands and first verdict"
```

---

## Self-review

- **Spec coverage:**
  - §3 mining: Tasks 3 and 7.
  - §3 selection: Tasks 2 and 7.
  - §4 arms, reject set, homes, fetch 30 / keep 8, frontmatter mapping, non-session drop, degraded exclusion: Tasks 2, 6 and 7.
  - §5 answering through production `synthesize`: Task 7, Ruling R4.
  - §6 grading, retry, ungraded, probes, 20% re-grade: Tasks 4 and 7.
  - §7 CIs, the verdict order, report extras, run record, show: Tasks 5 and 7.
  - §8 dry-run, cache, limit resume, read-only, data location: Tasks 1, 6 and 7.
  - §10 tests: covered per task.
- **Placeholders:** none. Every code step has its code.
- **Types:** `RetrievedHit` includes `method`, used by `synthesize`'s `SearchHit` mapping in Task 7. `GateResult` and `ProbeSummary` are defined once in Task 1. `computeVerdict`'s `GateInput` in Task 5 matches the call in Task 7. `FETCH_K` and `sessionIdFromNote` come from Task 2 and are used in Task 6.
- **Review Focus:** items 1–5 each have a test: gate and run (1); gate and run (2); run (3); cache and run (4); select and mine (5).
- **Test count:** 5 + 9 + 10 + 13 + 9 + 3 + 7 = 56 new, so 887 → 943.

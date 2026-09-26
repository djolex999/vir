# Note-usefulness eval — design

**Status:** approved in conversation, 2026-09-26. Awaiting written-spec review.
**Lives in:** `eval/usefulness/`, part of the existing retrieval eval harness. Never shipped: the `files` whitelist is `dist/` only.

## 1. Purpose

vir notes are read by Claude, not by a person, so a note's worth is whether it helps Claude answer real questions in its project. Model *opinions* of notes proved unstable:
- `vir audit` agreed with an Opus audit on 45–52% of verdicts, and one prompt change moved 61 notes.
- The 2026-09-25 human check was agreed by deference, so it confirmed nothing.

This eval replaces opinion with **measurement**: answers to real later-session questions, graded fact by fact against what that session actually established.

**v1 drives one decision:** whether `vir audit --apply-rejects` is safe on this vault. It removes the audit's current reject set in a DB copy and measures whether Claude's answers get worse.

**Success:** a PASS / FAIL / NO VERDICT for the frozen reject set, produced by rules fixed in this document before any run, with every number traceable to the question, facts and answers behind it.

## 2. Decisions (fixed)

| # | Decision | Choice |
|---|---|---|
| D1 | What v1 decides | Gate `--apply-rejects` with a vault-level ablation: full vault vs vault without the audit's rejects. |
| D2 | Scoring | A key-fact checklist from the later session. Each fact is `stated` / `missing` / `contradicted`. |
| D3 | Pass rule | Non-inferiority. The 95% CI lower bound of Δrecall (ablated − full) must be **> −0.05**, and the 95% CI upper bound of Δcontradiction must be **≤ +0.02**. |
| D4 | Answer path | Approach A: production `searchWithOutcome` (top-8, in the production retrieval config) in arm homes, then production `synthesize()`. |
| D5 | Leakage | A question only sees notes from sessions that started before it, and never its own session's note. |
| D6 | Where the gate is judged | Only on **exposed** questions: those whose `full` top 8 contains at least one reject. |

## 3. Question mining (`usefulness mine`)

### Candidate transcripts
Files on disk under `claudeProjectsDir` that pass all of these:
- **Not a sidechain, workflow or SDK-agent transcript.** Use production `classifyTranscript` (`src/pipeline/projects.ts`) and the first-user-line entrypoint check (`sniffAgentEntrypoint`).
- **In a project with at least one served note** whose session `startedAt` is earlier than this transcript's start.
- **Parsed with production `parseSession`.** The miner sees `rawSummary` plus the tool-filtered, scrubbed `transcriptText` (production `filterToolCalls`, moderate, then `scrub`), capped at 60,000 characters.

### Extraction
One `claude -p` call per transcript, using the configured `models.distill`, cost stage `eval-usefulness-mine`. It returns JSON with 0–2 items:
```json
[{ "question": "…", "facts": ["…", "…"], "evidence": ["…", "…"] }]
```
- **`question`:** what the user needed to know or decide, phrased as a standalone `vir_query`-style question. It must not contain any fact's specific answer.
- **`facts`:** 2–4 things the session **established**, each concrete enough to be wrong (a file, function, constraint, number, or a decision plus what it was chosen over).
- **`evidence`:** one short excerpt (≤ 200 chars) per fact, from the transcript text.
- Sessions with nothing to learn (pure execution) return `[]`.

**Validation (code, no model):**
- An item is dropped if it has fewer than 2 or more than 4 facts.
- An item is dropped if any fact's distinctive token (an identifier, number or backticked term) appears in the question.
- An item is dropped if any evidence excerpt is not a substring of the transcript text given to the miner.
- Drops are counted by reason.

**Stored:** `~/.vir/eval/usefulness/questions.json`. Each item carries its transcript path, project, `sessionId`, `cutoff = startedAt`, the prompt hash and the model.

### Selection (`usefulness run`, before any answer call)
1. For every mined question, run `full`-arm retrieval (no model call) and record the top 8 after the cutoff filter (§4).
2. **Exposed** = questions whose `full` top 8 contains at least one note in the frozen reject set.
3. Seeded sample (default seed 20260926): up to **60 exposed**, plus **20 control** drawn from non-exposed questions.
4. If fewer than 60 exposed questions exist, use all of them and report the real number. Never pad with synthetic questions.

## 4. Arms and retrieval

| Arm | Home DB | Role |
|---|---|---|
| `full` | backup-API copy of `~/.vir/vir.db` | baseline |
| `ablated` | same copy, then `markRejected(sessionId)` for every note in the frozen reject set | the gate compares it to `full` |
| `none` | none; the answerer receives zero notes | report-only floor |

- **Frozen reject set:** every row with a **fresh** `audit_verdict = 'reject'` in the real DB at run start (`listAudits()`, `fresh === true`). Its sorted session ids and their SHA-256 go into the run record.
- **Home setup** reuses `eval/homes.ts` / `eval/prepareHomes.ts`: a config copy with secrets stripped, absolute paths, the query log off, and the production retrieval configuration (the harness's `nomic-mmr` baseline). The two homes are `~/.vir/eval/homes/usefulness-full/` and `…/usefulness-ablated/`.
- **Retrieval** happens in the arm child process, via `runArm.ts` / `armWorker.ts`:
  - Call production `searchWithOutcome` with limit **30**.
  - Drop hits whose session `startedAt >= cutoff`, and the question's own session.
  - Keep the first **8**.
  - This post-filter is the only deviation from production's top-8, and it is required by D5.
- **Mapping hits to sessions.** A `SearchHit` carries only `filePath`, so each hit is mapped to its session row through the note file's frontmatter `session_id`. The full id is the authority; the 8-hex filename suffix is only an index hint, since suffixes can collide.
- **Non-session hits are dropped.** Topic pages (`vir compose`), articles and PDFs are removed from the top 8, and the number dropped is counted per question (`droppedNonSession`).
  - A topic page can summarize notes from sessions after the cutoff, which would leak the answer.
  - Articles and PDFs have no session start time to compare with the cutoff.
  - v1 therefore measures session notes only, which is what `vir audit` judges.
- **The TF-IDF fallback is excluded.** If either main arm's outcome reports a degraded or TF-IDF method for a question, drop that question from the gate and count it (`excludedDegraded`). The fallback walks note files on disk, which the DB ablation does not remove, so a degraded comparison would be unfair.

## 5. Answering

The answer runs in the **parent** process, with the real `HOME` and `claude -p` auth, following the harness rule:
- **Call:** production `synthesize(cfg, question, hits)` from `src/search/synthesizer.ts`, the configured model, and the same config for all arms.
- **Arm `none`:** `hits = []`.
- **Cost stage:** `eval-usefulness-answer`.

## 6. Grading

**Grader:** `claude -p`, the configured `models.distill`, cost stage `eval-usefulness-grade`.

**Input:** the question, the numbered facts, and **one** answer. The grader never sees the arm, the notes, or any other answer.

**Order:** all grading calls are shuffled with a seed across arms and questions.

**Output:** JSON, one object per fact:
```json
[{ "fact": 1, "verdict": "stated" | "missing" | "contradicted", "why": "…" }]
```
- `missing` includes "the notes don't cover this".
- `contradicted` means the answer asserts something incompatible with the fact.

**Parsing:** a reply that does not parse, or lacks a verdict for every fact, is retried once. If it fails again, the answer is marked `ungraded` and its question is excluded from the gate (`excludedUngraded`).

**Per-answer metrics:**
- `recall = stated / facts`
- `contradiction = contradicted / facts`

### Grader validation (no human)
Run on every question in the sample, before real grades count:

| Probe | Answer text | Must score |
|---|---|---|
| Oracle | the facts, restated as a plain answer | recall ≥ 0.95 averaged over probes, and contradiction = 0 on ≥ 95% of probes |
| Null | "I don't know; the notes don't cover this." | stated = 0 and contradicted = 0 on ≥ 95% of probes |
| Negation | each fact negated (generated by one `claude -p` call per question, stage `eval-usefulness-probe`) | contradiction ≥ 0.90 averaged over probes |
| Re-grade | 20% of real answers (seeded), graded again in a new position | per-fact verdict agreement ≥ 0.90 |

If any probe fails, the run's gate is **NO VERDICT (grader unreliable)**. The failing probe and its examples are recorded.

## 7. Metrics and the gate

On the exposed set, after exclusions:
- per question, `Δrecall = recall(ablated) − recall(full)` and `Δcontradiction = contradiction(ablated) − contradiction(full)`;
- 95% CIs via `pairedBootstrapCI` (`eval/metrics/bootstrap.ts`), 2000 rounds, seeded.

**Verdict** (the order of checks is fixed):
1. **NO VERDICT (grader unreliable)** if any probe failed.
2. **NO VERDICT (insufficient sample)** if fewer than **15** exposed questions remain after exclusions.
3. **NO VERDICT (retrieval degraded)** if `excludedDegraded` is more than **25%** of the sampled exposed questions.
4. **FAIL** if the Δrecall CI lower bound is ≤ −0.05, or the Δcontradiction CI upper bound is > +0.02.
5. **PASS** otherwise.

**Reported, never gating:**
- `full − none` Δrecall, with its CI;
- the control set's Δrecall and Δcontradiction, with CIs. A non-zero control Δ signals noise or leakage in the setup;
- per-reject exposure: for each reject, how many sampled questions retrieved it;
- every exposed question where `ablated` scored lower or contradicted more: the question, facts, both answers, and which rejects were in `full`'s top 8.

**Run record:** `~/.vir/eval/usefulness/runs/<ts>.json`. It holds the git SHA and dirty flag, seeds, the reject-set hash, the question-file hash, the miner / grader / probe prompt hashes, models, arm configs, every retrieval result, answer and grade, the probe results, exclusion counts, metrics, CIs and the verdict. `usefulness show` prints a short summary from it.

## 8. Cost, resumability, safety

- **Budget:** about 200 mining calls + 3 × ≤ 80 answers + ≤ 240 grades + about 50 re-grades + ≤ 80 negation generations + ≤ 240 probe grades. That is about 850 `claude -p` calls on subscription quota. `estimated_cost_usd: null` in `cost.log`.
- **`--dry-run`:** prints the candidate transcript count, expected calls per stage, and cache hits, then exits before any model call.
- **Result cache:** a new `eval/usefulness/cache.ts`. It is keyed by SHA-256 of (stage, model, prompt text), stored at `~/.vir/eval/usefulness/cache/`. Every model call goes through it, so a re-run after an interruption pays only for missing results. A prompt edit changes the key and invalidates exactly the affected entries.
- **Subscription limit:** a `ClaudeCliLimitError` stops the command with the reset time and a non-zero exit. Re-running resumes from the cache.
- **Read-only:** the real `vir.db` and vault are never written. The ablation exists only in the `usefulness-ablated` home's DB copy.
- **Data location:** every mined question, answer and grade lives under `~/.vir/eval/usefulness/`. `eval/noLeak.test.ts` is extended to the new path constants.

## 9. Components

| File | Responsibility |
|---|---|
| `eval/usefulness/types.ts` | `MinedQuestion`, `ArmId`, `FactVerdict`, `GradedAnswer`, `ProbeResult`, `UsefulnessVerdict`, `RunRecord` |
| `eval/usefulness/paths.ts` | path constants under `~/.vir/eval/usefulness/` |
| `eval/usefulness/cache.ts` | content-hash result cache |
| `eval/usefulness/mine.ts` | candidate selection (pure) + miner prompt + JSON validation |
| `eval/usefulness/select.ts` | cutoff filter, exposure, seeded exposed/control sampling (pure) |
| `eval/usefulness/grade.ts` | grader prompt, reply parsing, per-answer metrics (pure) |
| `eval/usefulness/probes.ts` | oracle / null / negation answer builders, probe evaluation (pure except negation generation) |
| `eval/usefulness/gate.ts` | Δs, bootstrap CIs, the verdict function (pure) |
| `eval/usefulness/run.ts` | orchestration: homes → retrieval → answers → grades → probes → gate → record |
| `eval/main.ts` (modify) | `usefulness mine` / `run` / `show` subcommands |
| `eval/prepareHomes.ts` (modify) | build the two usefulness homes; apply the ablation in the copy |

## 10. Testing

TDD, vitest, fixtures only, no real model calls. The model call is an injected function.
- **`select`:** a newer-note or own-session hit never reaches the top 8; exposure detection; seeded sampling is stable; fewer-than-60 exposed returns all of them.
- **`mine`:** candidate filtering (sidechain, SDK agent, and no-earlier-note excluded); validation drops the answer-in-question, the bad-evidence and the wrong-fact-count cases, counted by reason.
- **`grade`:** parses valid replies; one retry, then `ungraded`; recall and contradiction arithmetic.
- **`probes`:** each probe's pass/fail thresholds at the boundaries.
- **`gate`:** hand-computed fixtures for PASS, FAIL on recall, FAIL on contradiction, and each NO VERDICT reason, in the fixed order.
- **`cache`:** a hit on the same input, a miss after a prompt change, and a limit error leaves no partial entry.
- **Integration:** a tiny fake vault with 3 notes, one of them a reject, and a stubbed model. `ablated` retrieval never returns the reject; a degraded outcome is excluded; the record contains the reject-set hash.
- **`noLeak.test.ts`:** covers the new paths.

## 11. Out of scope (v1)

Per-note usefulness scores; comparing distill or audit prompts; an agent answering through the MCP server; wiring the verdict into the `vir` CLI. Question mining (§3) and grading plus probes (§6) are built to be reused by all four.

## 12. Known limits

- **Grader:** it is a model. The probes (§6) bound its failure modes, but it still shares the answerer's model family.
- **Sample:** transcripts expire after about 30 days, so questions come from recent work only, and the exposed set may be small. NO VERDICT (insufficient sample) is the honest outcome then.
- **Freshness of facts:** a fact the later session established can itself go stale. The eval measures agreement with that session's outcome, not with today's code.

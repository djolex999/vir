# vir — Application Atlas

**Generated** 2026-10-05 · **Commit** `4f3eba6` (code identical to `23c0652`, release v0.24.2) · **Branch** `main`

**Scope.** All of `src/` (85 non-test files, about 20,700 lines) was covered deeply: every flow below was traced through the implementation, and the inventory was cross-checked by reading code, not by grep alone. `eval/` (the offline evaluation harness) and `site/` (the marketing and docs website) were inventoried only. The Obsidian plugin lives in a separate repository (`vir-obsidian`) and is out of scope; only its contract with this CLI is covered. The test suite was run on this commit: 119 test files, 1,073 tests, all passing.

---

## Start here

**What the product does.** vir reads the transcripts Claude Code leaves on your disk and turns the useful sessions into short, typed notes in an Obsidian vault. It then feeds that knowledge back into Claude Code two ways: a block it writes into your `CLAUDE.md` files, and an MCP server Claude Code can query mid-session. Web articles and PDFs you clip go through the same pipeline.

**Suggested reading order.** The **15-minute tour**: this section, section 1, section 2, the plain-language summary at the top of each flow in section 4, the three tables in section 8, and the top five items in section 9. The **full read** goes from section 1 to 13 in order; treat sections 3, 5 and 6 as lookups. Section 12 is interview preparation.

**How to read the citations.** `path/file.ts:symbol` means open that file and find that function or constant; `path/file.ts:42` means that line; `UNVERIFIED` means the code was not read and the note says what to read.

---

## 1. What this product is

**TL;DR:** A local, single-user command-line tool and background job that turns AI coding sessions into a searchable knowledge vault and feeds it back to the AI.

vir has one kind of user: a developer who uses Claude Code and keeps an Obsidian vault. There are no accounts and no server. Everything runs on that developer's machine: a command-line tool (`vir`), a scheduled background run (the *daemon*, launchd on macOS), a SQLite database in `~/.vir/vir.db`, and Markdown notes in the vault. The problem it solves is forgetting: every Claude Code session ends with decisions, fixes and gotchas that the next session does not know about. vir distills those sessions into four kinds of note (`pattern`, `gotcha`, `decision`, `tool`; `src/pipeline/types.ts:Category`) and makes them retrievable.

The product behaves the same for everyone; what varies is configuration. The user picks a *provider* that does the AI work: the Anthropic API (pay per token), Kie.ai (a cheaper reseller of the same models), or `claude-cli`, which runs the Claude Code CLI itself and spends the user's Claude subscription quota instead of dollars (`src/config.ts:ConfigSchema`, `provider`). The user also decides, per project, whether its sessions are distilled at all. A companion Obsidian plugin reads the vault and drives review through the CLI's `--json` mode; that plugin is a separate repository.

---

## 2. System map

**TL;DR:** One Node process type (the `vir` CLI, run by hand, by the daemon, or by Claude Code as an MCP server) around one SQLite file and one folder of Markdown.

```mermaid
flowchart LR
  CC[Claude Code] -- writes .jsonl transcripts --> TR[(~/.claude/projects)]
  CC -- MCP over stdio --> MCP[vir mcp]
  LD[launchd / systemd / cron] -- vir run --daemon --> CLI[vir CLI]
  OBS[Obsidian plugin] -- vir review/query --json --> CLI
  CLI -- reads --> TR
  CLI -- HTTPS / spawn claude -p --> LLM[LLM provider: Anthropic, Kie, claude CLI]
  CLI -- HTTP localhost --> EMB[Embedder: Ollama or local fastembed]
  CLI -- read/write --> DB[(SQLite ~/.vir/vir.db)]
  CLI -- read/write --> V[(Obsidian vault, Markdown)]
  CLI -- VIR block --> CM[(CLAUDE.md files)]
  MCP -- read-only --> DB
  MCP -- reads --> V
  MCP -- synthesis --> LLM
  MCP -- query vector --> EMB
```

| Component | Where it runs | What breaks if it is down | Fallback |
|---|---|---|---|
| `vir` CLI | User's machine (Node ≥ 20) | Everything | None |
| Daemon | launchd (macOS), systemd user timer or cron (Linux) | No automatic distills; manual `vir run` still works | Manual runs |
| SQLite `~/.vir/vir.db` | Local file, WAL mode | All state: what was processed, vectors, review overlays | None; it is the source of truth |
| Obsidian vault | Local folder | The product output | Plain files; recoverable by re-rendering (`vir run --rewrite-only`) |
| LLM provider | Anthropic API, Kie.ai API, or local `claude` CLI | No new notes; MCP answers fail | One preflight probe stops the run cleanly; sessions retry next run |
| Embedder | Ollama on `localhost:11434`, or fastembed installed into `~/.vir/embedder` | Semantic search degrades | TF-IDF keyword search over the vault files; a sweep back-fills vectors later |
| MCP server | Child process of Claude Code | Agent cannot query the vault | None needed; CLI still works |

---

## 3. Directory guide

**TL;DR:** `src/pipeline/` is the engine, `src/cli/` holds the commands, `src/state/db.ts` is all SQL; everything else is a satellite.

| Directory | What it does for vir | Size (non-test) |
|---|---|---|
| `src/pipeline/` | The ingest engine: scan transcripts, parse, filter, scrub secrets, classify and distill via the LLM, write notes, embed. `run.ts` orchestrates; `distillSession.ts` is the per-session core shared with reconcile. Also holds compose, summarize, the pidfile lock and project triage, which are not pipeline stages. | 23 files, 6,690 lines |
| `src/cli/` | One module per large command (`init`, `lint`, `embed`, `summarize`, `audit`, `compose`, `dedupe`, `review`, `reconcile`…), plus `runAction.ts` (error-to-exit-code wrapper) and `guards.ts` (lock and paid-step prompt). `review.ts` doubles as a library: its frontmatter helpers and `rejectNote` are used by audit, prune and output. | 20 files, 3,475 lines |
| `src/cli.ts` | The commander wiring for all 29 actions, plus the inline bodies of `run`, `cost`, `queries`, `calibrate`, `schedule`, `sync-claude`, `query`, `projects`, `status`, `mcp`. | 1,286 lines |
| `src/state/` | `db.ts`: every SQL statement in the product (the `StateDb` class: tables, migrations, queries). `rejections.ts`: copies `.rejected/` file state into the DB. | 2 files, 1,930 lines |
| `src/search/` | Retrieval: embedding providers (Ollama, local fastembed), vector search with MMR, TF-IDF fallback, per-model thresholds, answer synthesis, the query log. | 7 files, 1,250 lines |
| `src/diagnostics/` | `vir doctor` (about 20 checks) plus two pieces of runtime state the pipeline writes: distill-failure accounting and the provider-preflight marker. | 3 files, 1,243 lines |
| `src/mcp/` | The stdio MCP server (6 tools), the tool list, and the `claude mcp add/remove` wrapper. | 3 files, 801 lines |
| `src/daemon/` | Scheduler router: launchd on macOS; systemd user timer with cron fallback on Linux. | 4 files, 643 lines |
| `src/lint/` | `vir lint` checks (orphans, stale notes, LLM contradiction check) and two `--fix` migrations that move files. | 3 files, 625 lines |
| `src/dedupe/` | `vir dedupe`: find near-duplicate notes, LLM-confirm, merge, archive the loser. | 2 files, 410 lines |
| `src/claude/` | `updater.ts` only: writes the `VIR:START`/`VIR:END` block into `CLAUDE.md` files. Not the Claude CLI provider (that is `pipeline/claudeCli.ts`). | 1 file, 403 lines |
| `src/audit/` | `vir audit`: an LLM judges each note keep / verify / merge / reject; `--apply-rejects` moves rejects. | 5 files, 376 lines |
| `src/ui/` | Terminal styling (`display.ts`) and OS notifications (`notify.ts`, `macNotifier.ts`). | 3 files, 368 lines |
| `src/prune/` | `vir prune`: demote notes distilled from agent-internal transcripts; restore them. | 2 files, 302 lines |
| `src/cost/` | `~/.vir/cost.log` append and read, the price table, the `vir cost` report. | 3 files, 295 lines |
| `src/output/` | `json.ts`: the `--json` wire types the Obsidian plugin depends on. | 1 file, 291 lines |
| `native/notifier/` | Swift source for `assets/Vir.app`, the macOS notification sender (banners show "vir", not "Script Editor"). | 4 files |
| `eval/` | Offline harness, never shipped: retrieval A/B arms, distill-prompt A/B, label tooling, the note-usefulness experiment. Reached only through npm scripts. *Inventoried only.* | 63 files, ~5,000 lines |
| `site/` | Astro + Starlight website at virwiki.dev (Vercel). *Inventoried only.* | — |
| `.github/workflows/` | One CI file: build, type-check (including tests and eval), test; site check and build. No publish workflow. | 1 file |

---

## 4. The flows

**TL;DR:** Six flows define the product: first setup, the scheduled distill, knowledge flowing back, money, failure handling, and review from Obsidian.

### Flow 1 — First run: install to first note

**Plain-language summary**
1. The user installs the npm package and runs `vir init`.
2. A wizard asks for the vault folder, the Claude Code transcripts folder, optional article and PDF folders, the provider and the models.
3. It scans existing transcripts and asks which projects to include.
4. It validates the answers and saves `~/.vir/config.json`, readable only by the owner.
5. It offers to register vir's MCP server with Claude Code.
6. It tells the user to run `vir run` once and then `vir schedule install`; it does not schedule anything itself.

**Detailed chain**
1. `src/cli.ts` `init` command → `src/cli/init.ts:cmdInit`.
2. `src/config.ts:ensureVirDir` creates `~/.vir` with mode 0700.
3. Interactive prompts (`@inquirer/*`). Kie gets its own model list, because Kie names models differently (`src/cli/init.ts:cmdInit`, `classifyChoices`/`distillChoices`).
4. `src/cli/projectSelect.ts:promptProjectDecisions`: multi-select of discovered projects; failures fall back to "decide later with `vir projects`".
5. `src/cli/initConfig.ts:buildInitConfig` merges answers over any existing config → `src/config.ts:ConfigSchema.safeParse`. Invalid → issue list, exit code 1.
6. `src/config.ts:saveConfig` writes a 0600 temporary file and renames it over `config.json` (an *atomic write*: the file is either fully old or fully new, never half-written).
7. `src/mcp/install.ts:installToClaudeCode("user")` runs `claude mcp add --scope user vir vir mcp`.
8. macOS only: `src/cli/notificationsSetup.ts:setupNotifications`.
9. Prints `next: vir run to test once, then vir schedule install`.

**What breaks this:** a new config key that `buildInitConfig` does not carry is silently dropped on re-init (`src/cli/initConfig.test.ts` guards this with a sample of every key). Changing `saveConfig` back to an in-place write re-opens a window where API keys are world-readable.

**Why this matters:** `config.json` holds API keys in plain text; its file mode is the only protection.

### Flow 2 — The scheduled run: transcripts become notes

**Plain-language summary**
1. The scheduler starts `vir run --daemon` every few hours (default 3).
2. vir takes a lock file so two runs can never work at once.
3. It hashes every transcript and drops the ones it must never pay for: subagent and SDK-agent transcripts, excluded or undecided projects, already-processed bytes, demoted notes, and sessions that failed three times.
4. One tiny test call checks the provider is reachable before anything else spends money.
5. For each remaining session it strips tool noise and secrets, trims a huge transcript to fit, then asks the model to classify it and, if it is useful enough, write a note and a title.
6. The note is written to the vault, its row and vector are stored, and the user may get a notification.
7. After the loop: project summaries, articles, PDFs, and a sweep that embeds anything still missing a vector.

**Detailed chain**
1. `src/daemon/launchd.ts:renderPlist` → launchd runs `<node> <dist/cli.js> run --daemon` every `cadenceHours × 3600` seconds.
2. `src/cli.ts` `run` action → `src/pipeline/lock.ts:acquireLock`. The lock is a *pidfile*: a file holding the running process ID, created with an exclusive flag so exactly one process wins. A stale lock (dead PID) is removed only under a second guard file, `vir.lock.reclaim`.
3. `src/pipeline/run.ts:runPipeline` → `src/state/rejections.ts:syncRejections` (copy `.rejected/` state into the DB).
4. `src/pipeline/scanner.ts:scanSessions`: SHA-256 hash of every `.jsonl` file, every run.
5. Free gates, each recording a `skip_reason` row: `src/pipeline/projects.ts:classifyTranscript` (subagent and workflow transcripts), `readTranscriptHead` + `sniffAgentEntrypoint` (SDK-launched agents), `groupByProject` + `decideProject` (include / exclude / pending). Interactive runs prompt for undecided projects; the daemon only notifies.
6. Preflight count and size-based estimate (`src/pipeline/projects.ts:estimateSessionCost`) → `src/cli.ts:confirmCostIfNeeded` when more than 20 sessions are new.
7. `src/pipeline/distiller.ts:probeProvider`: a 5-token call raced against 15 seconds.
8. Per session in `runPipeline`: `StateDb.isProcessed` (hash match), `isPruned`, `retryExhausted` (3 failures) in `src/state/db.ts`; `src/pipeline/parser.ts:parseSession`; content backstops for sidechain and agent transcripts.
9. `src/pipeline/distillSession.ts:distillOneSession`: `filter.ts:scoreSession` (heuristic, threshold 0.4) → `scrubber.ts:scrub` → `toolCallFilter.ts:filterToolCalls` → `trimTranscript` (cap 450,000 characters, keeping 30% head and 70% tail) → `beforePaidCall` (claude-cli batch cap of 25) → `Distiller.run` (`classify` → `modelFor` → `distill` → `titleFor`/`retitle`, every call through `callLLM`).
10. Skip outcomes: a row that already holds a note keeps it (`StateDb.keepNote`); otherwise `StateDb.record` with `skipped=1`. Success: `src/pipeline/writer.ts:VaultWriter.write` (embedding, Related links from the nearest existing notes) → `StateDb.record` → `writer.flushPendingEmbeddings`.
11. Errors in the loop: `ClaudeCliLimitError` sets `limitHalted` and breaks; anything else → `StateDb.recordError` (attempts + 1, stored hash kept).
12. After the loop (`runPipeline`): `summarizeProject` for projects with three or more new notes; `runArticlePhase` and `runPdfPhase` unless halted; `runEmbeddingSweep` → `embeddingSweep.ts:sweepEmbeddings` using `writer.embeddingText`.
13. `src/cli.ts` `run` action `finally` → `releaseLock`; exit code 1 on any error, article or PDF error, or limit halt.

**What breaks this:** reordering the gates so a paid call happens before a free skip; recording a skip over a row that holds a note (the 0.23.3 bug); storing the vector before the row exists (the 0.24.0 bug: every new note was embedded twice, the second time from different text); taking the lock non-atomically (the 0.23.2 bug: two runs could both hold it and pay twice).

**Why this matters:** this loop spends money on every session it lets through, and its rows decide whether a note is ever visible.

### Flow 3 — Knowledge back into Claude Code

**Plain-language summary**
1. Claude Code calls vir's MCP tool `vir_query` with a question.
2. vir turns the question into a vector and compares it with every stored note vector made by the same model.
3. Human-verified notes get a fixed boost; a diversity step picks the top results; keyword search is the fallback.
4. Unless the agent passed `synthesize: false`, one paid LLM call writes an answer from those notes.
5. Separately, `vir sync-claude` writes a block of the best notes into `CLAUDE.md` files, after showing a diff.

**Detailed chain**
1. `src/mcp/server.ts:runMcpServer` opens the DB with `{ readonly: true }` and registers six tools; `vir_query` handler.
2. `src/search/retriever.ts:searchWithOutcome` → `searchByEmbedding`: `provider.embedQuery`; `getEmbeddings` from all four tables; `partitionByEmbeddingModel` (vectors from another model are never compared); cosine floor from `src/search/thresholds.ts`; `isVerified` adds 0.2; `mmrRerank` (MMR: *maximal marginal relevance*, prefers results that differ from those already picked). Zero hits → `searchTfIdf` over the vault files.
3. `src/search/queryLog.ts:recordQueryEvent` → `~/.vir/queries.jsonl`.
4. `src/mcp/server.ts:buildQueryResult` → `src/search/synthesizer.ts:synthesize` → `callLLM`, skipped when `synthesize: false`.
5. `sync-claude`: `src/claude/updater.ts:planUpdates` (reads `listDistilled`) → `applyPlan`: refuses a file with unbalanced markers, then `writeAtomically` (temporary file renamed over the real path, following a symlink so a dotfiles link survives).

**What breaks this:** any write to stdout on the MCP path corrupts the protocol (stdio carries JSON-RPC, the message format MCP uses); the read-only DB skips migrations, so a new column read without a guard crashes an older database.

### Flow 4 — Money: what a call costs and how spend is guarded

**Plain-language summary**
1. Every model call in the product goes through one function, `callLLM`.
2. After the call, vir appends a record with the token counts and an estimated dollar cost to `~/.vir/cost.log`.
3. Calls through the Claude subscription, and calls to a model vir has no price for, are recorded as "unknown", never as $0.
4. `vir cost` totals the log and lists quota calls and unpriced calls separately.
5. Before spending, guards apply: a cost prompt on big runs, a 25-session cap on the subscription path, and confirmations on audit, dedupe, lint, compose and reconcile.

**Detailed chain**
1. `src/pipeline/distiller.ts:callLLM` → `callAnthropic` (SDK) / `callKie` (fetch, 120 s timeout) / `src/pipeline/claudeCli.ts:callClaudeCli` (spawn, 600 s).
2. `distiller.ts:recordCost` → `costForRecord` (null for claude-cli or when `src/cost/pricing.ts:resolvePricing` finds no price) → `computeCost` → `src/cost/log.ts:appendCostRecord`.
3. `vir cost` (`src/cli.ts` `cost` action) → `readCostLog` → `src/cost/report.ts:buildReport` (`subscriptionCalls`, `unpricedCalls`).
4. Guards: `src/cli.ts:confirmCostIfNeeded`; `src/pipeline/run.ts:CLAUDE_CLI_SESSION_CAP`; `src/cli/guards.ts:confirmPaidStep` (skips the paid step when there is no terminal); `src/diagnostics/doctor.ts:pricedModelsCheck`.

**What breaks this:** an LLM call that bypasses `callLLM` is spend nobody sees.

**Why this matters:** the provider bills real money; the log is the only record vir keeps.

### Flow 5 — Failure: provider down, quota wall, a failing session

**Plain-language summary**
1. If the provider is down, the probe fails once; vir records a marker, notifies, and stops the run before any session is touched.
2. If the subscription quota wall is hit mid-run, vir stops and records nothing, so every remaining item is simply new on the next run.
3. If one session fails, vir records the error and counts the attempt; after three failures on the same bytes the session is parked.
4. `vir reconcile` retries failed rows, but only those `vir run` would still process, restores an earlier note when a retry is skipped, and counts failures toward the same limit.
5. `vir doctor` shows all of this.

**Detailed chain**
1. `distiller.ts:probeProvider` throws → `run.ts:runPipeline` catch → `src/diagnostics/preflightFailure.ts:recordPreflightFailure` (`~/.vir/provider-preflight.failed`) → notification → rethrow → `src/cli/runAction.ts:runAction` sets exit code 1.
2. `claudeCli.ts` throws `ClaudeCliLimitError` → `run.ts` sets `limitHalted`; the article and PDF phases halt on it too; nothing is recorded.
3. `StateDb.recordError`: error set, attempts + 1, the stored hash is not overwritten; `MAX_DISTILL_ATTEMPTS` is 3; `retryExhausted` parks the row.
4. `src/cli/reconcile.ts:runReconcile` → `selectReconcileTargets` → `reconcileGate` (same filters as Flow 2, step 5) → `summarizeReconcileTargets` (marks transcripts deleted from disk) → `handleMissingSource` or `distillOneSession` → `keepNote` / `record` / `recordError`.
5. `src/diagnostics/doctor.ts`: distill failures, the preflight marker, limit detection.

**What breaks this:** letting the quota wall count as a per-session failure parks good sessions; letting `recordError` overwrite the hash hides the failure from both `run` and `reconcile`. Before 0.23.1, articles and PDFs that hit the quota wall were recorded as processed with an error and never retried: lost for good.

**Why this matters:** Claude Code deletes old transcripts after about 30 days, so a session that is never retried in time is lost for good.

### Flow 6 — Review from Obsidian

**Plain-language summary**
1. The Obsidian plugin asks vir for the review queue: notes the audit flagged, worst first.
2. The user approves or rejects a note in Obsidian.
3. vir checks the path really is a note in the vault, takes the lock, and applies the action.
4. Approve stamps `verified: true` into the note; reject moves it to `.rejected/` and stops serving it at once.
5. Restore moves a rejected note back.

**Detailed chain**
1. `src/cli.ts` `review --json` → `src/cli/reviewJson.ts:runReviewJson`.
2. `--audited` → `reviewQueue` → `src/cli/review.ts:orderForAudit` (fresh audit verdicts only, reject → merge → verify).
3. `--approve` / `--reject` → `resolveReviewTarget` (must be `<category dir>/<name>.md` under the vault) → `runReviewAction` → `withLock`.
4. `approveNote` (frontmatter `verified`, `reviewed_at`) or `rejectNote` (move to `.rejected/`, refuses to overwrite an earlier rejected copy) → `StateDb.markRejected`.
5. `--restore` → `resolveRejectedName` → `restoreRejected` → `StateDb.clearRejected`.
6. Output: one JSON value on stdout; errors as `{error, kind}` on stderr with exit 1 (`src/output/json.ts`).

**What breaks this:** the plugin hand-copies these types; changing a field here breaks the plugin silently.

**Why this matters:** a rejected note that keeps serving would keep feeding wrong knowledge to the agent.

---

## 5. Data model

**TL;DR:** Four SQLite tables plus a set of files; no foreign keys, and the session ↔ note link is recomputed, not stored.

**Why this matters:** these rows decide what was paid for, what is served, and what is retried.

Migrations are additive only: `StateDb.migrate` adds missing columns on every writable open and never drops or renames (`src/state/db.ts:migrate`). The MCP server and parts of `doctor` open read-only and skip migrations, so their reads guard for missing columns.

| Table | Key | Main fields | Written by | Read by |
|---|---|---|---|---|
| `sessions` | `path` | `hash`, `skipped`, `skip_reason`, `error`, `attempts`, `content`, `category`, `topic`, `project`, `confidence`, `started_at`, `entrypoint`, `embedding` (+ model, dim), overlays `pruned_at`/`prune_reason`, `rejected_at`, `archived`, audit columns | `record`, `recordError`, `keepNote`, `storeEmbedding`, `markPruned`, `markRejected`, `archive`, `recordAudit`, `updateContent` | `isProcessed`, `retryExhausted`, `listDistilled`, `getEmbeddings`, `listReconcileTargets`, `listAudits`, `getStats` and more |
| `articles` | `path` | `hash`, `error`, `attempts`, `note_path`, `content`, `category`, `title`, `url`, `author`, `published`, `embedding` | `recordArticle`, `storeArticleEmbedding` | `isArticleProcessed`, `listArticles`, `getArticleEmbeddings` |
| `pdfs` | `path` | as articles, plus `pages` | `recordPdf`, `storePdfEmbedding` | `isPdfProcessed`, `listPdfs`, `getPdfEmbeddings` |
| `topics` | `id` (slug) | `title`, `content`, `source_note_ids`, `model`, `created_at`, `updated_at`, `embedding` | `recordTopic`, `storeTopicEmbedding` | `getTopic`, `listTopics`, `getTopicEmbeddings` |

There is no status column. A session's state is derived from several columns; `docs/architecture/lifecycle-session-row.html` draws it.

**Written but never read in `src/`:**
- `sessions.note_paths`: written on every record, read only by `site/scripts/refresh.mjs` and `eval/run.ts`. Dropping it breaks those two.
- `articles.processed_at`, `pdfs.processed_at`.
- `sessions.rejected_at`: only used in `WHERE` clauses; the value itself is never selected.
- `pdfs.pages`, `pdfs.confidence`, `pdfs.distilled_at`, and `topics.topic_text`, `source_note_ids`, `confidence`, `model`: selected into row objects that no caller reads.

**Read but never written:** none found.

**Unused indexes:** `idx_sessions_hash`, `idx_articles_hash`, `idx_pdfs_hash`. No query filters on `hash`; every lookup uses the `path` primary key.

**Relations enforced only by convention**
- Session id ↔ row: `path LIKE '%/<id>.jsonl'`. `markRejected` sanitises the id; `storeEmbedding` does not. A leading-wildcard `LIKE` scans the whole table.
- Row ↔ note file: recomputed as `<category>s/<slug(topic, session id)>.md`, and found on disk by the session-id suffix (`writer.ts:locateBySession`).
- `rejected_at` mirrors the `.rejected/` files' frontmatter and is re-synced on every run (`rejections.ts:syncRejections`).
- `config.projects` is keyed by the decoded project name (`projects.ts:projectNameFor`).

**Files outside SQLite**

| File | Writer | What happens if missing or broken |
|---|---|---|
| `~/.vir/config.json` | `config.ts:saveConfig`, `projectSelect.ts:persistProjectDecisions` | Every command fails with "run `vir init`" |
| `~/.vir/vir.lock`, `vir.lock.reclaim` | `lock.ts:acquireLock`, `reclaimStale` | Dead PID reclaimed; a guard older than 10 s is cleared |
| `~/.vir/cost.log` | `cost/log.ts:appendCostRecord` | Empty report; bad lines skipped; never rotated |
| `~/.vir/queries.jsonl` | `queryLog.ts:recordQueryEvent` | Rotates at 5 MB, one generation |
| `~/.vir/daemon.log` | `run.ts:appendRunLog`, the scheduler's stdout | Never rotated |
| `~/.vir/provider-preflight.failed`, `claude-cli-limit.confirmed` | `preflightFailure.ts`, `claudeCli.ts` | Read by `doctor` only |
| Vault `patterns/ gotchas/ decisions/ tools/ articles/ pdfs/ topics/ projects/ summaries/` | `writer.ts`, `summarizer.ts`, `periodSummary.ts` | Plain Markdown; `summaries/` and `log.md` have no reader in `src/` |
| Vault `.rejected/`, `archived/` | review, audit, prune; dedupe | Skipped by search |

---

## 6. Domain concepts

**TL;DR:** The vocabulary that means something particular in vir.

| Term | What it means to the user | Where in code |
|---|---|---|
| transcript / session | One Claude Code conversation, saved as a `.jsonl` file | `pipeline/scanner.ts`, `parser.ts` |
| distill | Turning a session into a short note with an LLM | `pipeline/distiller.ts:Distiller` |
| note | One Markdown file in the vault, typed `pattern`, `gotcha`, `decision` or `tool` | `pipeline/writer.ts:CATEGORY_DIR` |
| article / PDF note | A note made from a clipped web article or a PDF | `pipeline/articleDistiller.ts`, `pdfDistiller.ts` |
| topic page | A page `vir compose "<topic>"` synthesizes from several notes | `pipeline/composer.ts` |
| project summary / period summary | A rolled-up page per project, or per week or month | `pipeline/summarizer.ts`, `periodSummary.ts` |
| project decision | Include, exclude, or undecided (pending) per Claude Code project | `pipeline/projects.ts:decideProject` |
| gated skip | A session vir did not distill because of a setting; it comes back if the setting changes | `state/db.ts:GATED_SKIP_REASONS` |
| parked | A session that failed three times and is retried only by `vir reconcile --force` | `state/db.ts:retryExhausted` |
| verified | A note the user approved; ranked higher in search | `cli/review.ts:approveNote`, `search/retriever.ts:isVerified` |
| rejected / pruned / archived | Notes taken out of service: by the user, by `vir prune`, or by dedupe | `.rejected/`, `archived/`; `db.ts:servingGate` |
| Related links | Links at the bottom of a note to its nearest notes by meaning | `pipeline/writer.ts:neighborLinks` |
| VIR block | The section between `<!-- VIR:START -->` and `<!-- VIR:END -->` that vir owns in `CLAUDE.md` | `claude/updater.ts` |
| provider | Who runs the model: `anthropic`, `kie`, or `claude-cli` | `config.ts`, `distiller.ts:callLLM` |
| quota wall / limit halt | The subscription limit message from `claude -p`; vir stops the run | `pipeline/claudeCli.ts:ClaudeCliLimitError` |

---

## 7. Deliberate decisions

**TL;DR:** Choices that look odd and should stay; each was verified against the current code.

| Decision | Reason | If reverted |
|---|---|---|
| Set `process.exitCode`, never call `process.exit()` (`cli/runAction.ts:runAction`) | `exit` can cut off buffered output | The last error line is lost |
| Never build the Anthropic SDK client for Kie or claude-cli (`distiller.ts:maybeAnthropicClient`) | The SDK sends an `x-api-key` header Kie rejects | Kie authentication fails |
| `claude -p` always runs with cwd `~/.vir` and `--no-session-persistence` (`claudeCli.ts:buildClaudeCliArgs`) | A project cwd loads that project's `CLAUDE.md` into the prompt; persistence would create transcripts vir then ingests | Prompt contamination and a self-ingestion loop |
| Scrub before any LLM call or write (`distillSession.ts:distillOneSession`) | Keys, emails and home paths must never reach a provider or the DB | Secret leakage into notes and logs |
| Migrations only add columns (`db.ts:migrate`) | The daemon and the read-only MCP server open old databases | Data loss or crashes on read |
| A stored hash means "done"; `recordError` keeps the old hash (`db.ts:recordError`) | A bumped hash would hide the failure from `run` and `reconcile` | Failed sessions become unreachable |
| A skip never hides an existing note (`db.ts:keepNote`) | Filters are forward-looking | Re-runs silently hide notes (fixed in 0.23.3) |
| Related links come from vector neighbours; keep the old section when there is no vector (`writer.ts:VaultWriter.write`) | LLM-guessed links resolved 1 time in 2,261 | A rewrite with Ollama down wipes every Related section |
| The MCP server opens the DB read-only (`mcp/server.ts:runMcpServer`) | An agent session must never mutate state | Writes from inside Claude Code |
| Unknown cost is null, never $0 (`distiller.ts:costForRecord`) | Honest totals | Under-reported spend |
| `doctor --json` has exactly 8 fields (`output/json.ts`) | Contract with the Obsidian plugin | Plugin breaks |
| Pidfile lock: exclusive create plus a reclaim guard (`lock.ts:acquireLock`) | A check-then-write let two processes both "hold" it | Double spend on the same sessions |
| `confirmPaidStep` skips the paid step without a terminal (`cli/guards.ts`) | Cron and scripts must not spend unasked | Unattended spend |
| Period summaries get no table, no vector, and are excluded from keyword search (`retriever.ts:SKIP_DIRS`) | Summaries of notes would crowd out their own sources | Retrieval pollution |
| Review approval lives only in note frontmatter (`review.ts:approveNote`) | Humans and the plugin edit files directly | `--rewrite-only` would need to round-trip it through the DB. Note: rejection is now *also* in the DB (`rejected_at`) |

---

## 8. State of completion

**TL;DR:** The core is shipped and well tested; the Linux scheduler is the main half-built area; dead code is under 0.5%.

**Shipped**

| Feature | Where | Confidence | How you know |
|---|---|---|---|
| Session distill with gates, retry bound, quota halt | `pipeline/run.ts`, `distillSession.ts` | High | `run.*.test.ts` (8 files); real daemon in use |
| Articles and PDFs | `run.ts:runArticlePhase`, `runPdfPhase` | High | `run.claudeCli.test.ts` against real SQLite |
| Vector + TF-IDF retrieval with MMR | `search/retriever.ts` | High | `retriever.test.ts`; eval harness measured it |
| MCP server, 6 tools | `mcp/server.ts` | Medium | Pure helpers tested; handlers untested |
| `sync-claude` | `claude/updater.ts` | High | `updater.test.ts` (markers, atomic write, symlink) |
| Review, audit, prune, dedupe, lint | `cli/`, `audit/`, `prune/`, `dedupe/`, `lint/` | Medium–High | Tests per module; CLI wiring untested |
| Cost log and report | `cost/` | High | `report.test.ts`, `costLabel.test.ts` |
| macOS daemon and notifications | `daemon/launchd.ts`, `ui/macNotifier.ts` | High | Running on the owner's machine |
| Obsidian `--json` contract | `output/json.ts`, `cli/reviewJson.ts` | High | `reviewJson.test.ts`, `json.test.ts` |

**Partial**

| What exists | What is missing | Reachable by a user today? |
|---|---|---|
| Linux scheduler (systemd timer, cron fallback) | `renderService`, `renderTimer`, install and status are untested; `--run-now` is ignored on Linux; `systemdQuote` does not escape `%` | Yes, via `vir schedule install` on Linux; README marks it experimental |
| `vir calibrate` | No cost prompt, no lock, ignores project and transcript filters; not in the README | Yes |
| `vir summarize <project>` / `--all` dry run | `--dry-run` is ignored on these paths | Yes: a "dry run" spends and writes |
| `vir query` (non-JSON) | `--limit` ignored (always 8) | Yes |
| `vir status` | Pending-embedding count omits PDFs | Yes |
| `--json` across commands | Only `query` and `review` have a structured error shape | Yes |

**Dead / orphaned** (about 20 lines dead, about 115 lines used only by tests)
- Never imported: `search/embedder.ts:OLLAMA_PROVENANCE`, `search/provider.ts:resolveActiveProviderCached`, `ui/display.ts:SPINNER`, the `ora` re-export, `cli/pruneAction.ts` `PruneCliOptions.dryRun`.
- Test-only: the four `select*EmbeddingTargets` mirrors, `embedder.ts:embeddingForNote`, `isOllamaAvailableCached`, `StateDb.countBySkipReason`, `StateDb.reset`, `claudeCli.ts:resetRawEnvelopeLogGate`.
- Unreferenced files: `vir-flow.html`, `demo.tape` (repo root).
- One TODO: `src/cost/pricing.ts:27` (refresh Kie prices). No commented-out blocks; every dependency and config key is used.

---

## 9. Risks and findings

**TL;DR:** No data-loss bugs remain on the main path; the rest are spend leaks, lock gaps, and inconsistent exit codes and JSON.

**Why this matters:** most items are either money spent without a prompt or files written while the daemon might be writing the same ones.

| # | Severity | Finding | Where |
|---|---|---|---|
| 1 | Medium | `vir summarize <project>` and `--all` ignore `--dry-run`: a "dry run" makes real LLM calls and writes files, without the lock | `src/cli/summarize.ts:summarizeCommand` (only the period path checks `dryRun`, line 116) |
| 2 | Medium | `vir run --rewrite-only` rewrites every note and `index.md` without the lock, so it can race a daemon run | `src/cli.ts:164` |
| 3 | Medium (Linux) | The cron fallback treats any failure of `crontab -l` as an empty crontab and then writes its own, which could wipe the user's entries | `src/daemon/cron.ts:69-73` |
| 4 | Medium | `vir calibrate` spends (classify + distill) with no prompt, no lock, and no project filter | `src/cli.ts` `calibrate` action |
| 5 | Low | Paid steps without a prompt: `run` with 20 or fewer sessions, `run --articles-only/--pdfs-only`, the `doctor` key ping | `src/cli.ts:155-161`, `src/diagnostics/doctor.ts:checkApiKey` |
| 6 | Low | `vir embed`, `sync-claude` and `projects include/exclude` write without the lock | `src/cli/embed.ts`, `src/cli.ts` |
| 7 | Low | Exit 0 on failure: plain `vir query` when search throws; `mcp install` on error; `lint` with issues; `embed` with errors; a failed `dedupe` merge | `src/cli.ts:731-735`; `src/mcp/install.ts`; `src/cli/lint.ts`; `src/cli/embed.ts`; `src/cli/dedupe.ts` |
| 8 | Low | `--json` shapes differ: `doctor` and `projects` are pretty-printed with no error shape; `ollama_unavailable` is never emitted; `no_vault` checks different paths for `query` and `review` | `src/output/json.ts`, `src/cli.ts:668`, `src/cli/reviewJson.ts:177` |
| 9 | Low | MCP `vir_project_summary` and `vir_compose` return "not generated" as a success payload, not an error | `src/mcp/server.ts` |
| 10 | Low | Keyword search indexes `projects/*.md` summaries, while period summaries are deliberately excluded | `src/search/retriever.ts:18` |
| 11 | Low | A note whose content changes while the embedder is down keeps its old vector; the sweep only fills empty ones | `src/state/db.ts:record` |
| 12 | Low | `storeEmbedding` builds its `LIKE` pattern without the id sanitiser `markRejected` uses | `src/state/db.ts:storeEmbedding` |
| 13 | Low | `daemon.log` and `cost.log` grow forever | `src/pipeline/run.ts:appendRunLog`, `src/cost/log.ts` |
| 14 | Low | Read-only consumers on a pre-migration DB: `listDistilled`, `getEmbeddings`, `listDistillFailures` read later columns unguarded | `src/state/db.ts` |
| 15 | Info | Hash indexes unused; dead code as in section 8 | `src/state/db.ts` |

---

## 10. Documentation drift log

**TL;DR:** `CLAUDE.md` still describes vir as of roughly 0.22; ten claims would mislead an agent today.

**Why this matters:** `CLAUDE.md` is fed to every future Claude Code session as truth.

| Doc | What it claims | What the code does | Evidence |
|---|---|---|---|
| `CLAUDE.md:173` | Note title comes from the classify step | A separate paid `retitle` call titles the finished note; classify's topic is the fallback | `distiller.ts:titleFor` |
| `CLAUDE.md:764` | Review verdicts live in frontmatter, not SQLite | Rejection is also in the DB (`rejected_at`); only approval is file-only | `db.ts:markRejected` |
| `CLAUDE.md:749-753` | Rejected notes leak through DB reads; use `prunedGate()` | Fixed; the gate is `servingGate()` | `db.ts:servingGate` |
| `CLAUDE.md:667-669`, `:305-307` | The MCP server never spends tokens | `vir_query` synthesizes by default; `synthesize: false` opts out | `mcp/server.ts:buildQueryResult` |
| `CLAUDE.md:802-811` | Reconcile selects only empty-content rows; a failed retry leaves the row as-is | Also rows with error and kept content; applies `reconcileGate`; a failure calls `recordError` | `cli/reconcile.ts` |
| `CLAUDE.md:430-433` | The lock is taken by `run` and `reconcile` | Also summarize, compose, dedupe, audit, review, prune, lint fixes; creation is atomic with a reclaim guard | `cli/guards.ts`, `pipeline/lock.ts` |
| `CLAUDE.md:442-446` | A missing price row logs $0 silently | Unpriced calls log null and are counted as unpriced | `distiller.ts:costForRecord` |
| `CLAUDE.md:477-478` | `claude` must be symlinked into `/opt/homebrew/bin` for the daemon | `resolveClaudeBin` searches PATH and common install dirs | `claudeCli.ts:resolveClaudeBin` |
| `CLAUDE.md:204`, `:67-70` | Never reimplement `kebab`; `slug.ts` is the single source | Three local copies remain | `articleDistiller.ts`, `pdfDistiller.ts`, `composer.ts` |
| `CLAUDE.md:147`, `:593-595`; `CONTRIBUTING.md` | `display.ts` is the one place `console.log` lives | About 37 calls across `cli.ts` and command modules, plus `writer.ts:231` | grep `console.log` |
| `CLAUDE.md:141`, `:973`; `README.md:388` | `vir doctor` runs 15 checks | 13 always, up to 8 conditional | `doctor.ts:runDoctor` |
| `CLAUDE.md:132-134` | `vir_query` types: session, article, topic, all | Also `pdf` | `mcp/server.ts:QUERY_TYPES` |
| `CLAUDE.md:198` | `RELATED_MIN_SIM` constant | Per-model `relatedMinSim` in `thresholds.ts` | `search/thresholds.ts` |
| `CLAUDE.md:188`, `:715` | `preservedThemesBlock` | Renamed `preservedListBlock(path, key)`; also carries `branches` | `writer.ts:preservedListBlock` |
| `CLAUDE.md:158-159` | `run.ts` runs the tool filter before scrubbing | Lives in `distillSession.ts`; the 450k-character trim is undocumented | `distillSession.ts` |
| `CLAUDE.md:241-245` | Upsert line numbers 518 / 860 / 1049 / 1275 | Now 869 / 1285 / 1506 / 1764 | `db.ts` |
| `CLAUDE.md:517-518` | All 6 LLM callers use `maybeAnthropicClient` | About 13 call sites | grep |
| `CLAUDE.md:112-113` | `computeCost` takes 5 arguments | 6 (`tier`) | `cost/pricing.ts:computeCost` |
| `CLAUDE.md:797-801` | Exit code checks `errored` and `articlesErrored` | Also `pdfsErrored` and `limitHalted` | `cli.ts:225-234` |
| `CLAUDE.md:252-262` | "Two input sources" | Three; the bullet contradicts the one above it | — |
| `CLAUDE.md` Structure tree | File tree | Missing about 25 files (`distillSession`, `guards`, the `cli/` command modules, `audit/`, `prune/`…) | `find src` |
| `CLAUDE.md:369`, `:1052` | "the 4h daemon" | Default cadence is 3 hours; 4 is the owner's config | `config.ts:23` |
| `CLAUDE.md:699-704`; `CONTRIBUTING.md` | `npm run typecheck` before submitting | CI runs `typecheck:all`, which also covers tests and eval | `package.json`, `ci.yml` |
| `CLAUDE.md:1002`; `README.md:368` | Bare `vir lint` runs orphans, stale, contradictions | Also strays and legacy-related; contradictions skipped without a terminal unless `--yes` | `cli/lint.ts` |
| `CLAUDE.md` Commands | Command list | Missing several flags (`lint --fix/--yes`, `dedupe --yes`, `embed --setup`, `review --json/--restore`, `notifications`…) | `cli.ts` |
| `README.md:25`, `:528` | 612 / 887 tests passing | 1,073 in the full suite | `npm test` |
| `README.md:527` | Version 0.22.0 | 0.24.2 | `package.json` |
| `README.md:149`, `:410` | Verified notes rank first | A fixed +0.2 boost, not strict first | `retriever.ts:VERIFIED_BOOST` |
| `handoff.md:3-4` | Latest release 0.23.0 | Six releases since (0.23.1–0.24.2), none recorded | `CHANGELOG.md` |
| `tasks/lessons.md:218-222` | Wrap handlers with `process.exit(1)` | Contradicts the later convention; no `process.exit(` in `src` | `cli/runAction.ts` |
| `tasks/lessons.md:394-397` | `search()` checks `isOllamaAvailable()` live | Resolves a provider (Ollama, local, none) | `search/provider.ts` |
| `tasks/lessons.md:849-851` | `npm test` fires real notifications; fix in flight | Fixed in `vitest.setup.ts` | `vitest.setup.ts` |
| `tasks/todo.md:144-147`, `:152-154`, `:1132`, `:480-486` | Open items: worktree project mapping, test notifications, audit preview, five bug-hunt items | All done | `projects.ts:decodeProjectName`, `vitest.setup.ts`, `cli/audit.ts`, see section 8 |
| `src/version.ts` comment | "The ONE runtime read" of the version | `cli.ts` and `doctor.ts` read it too | `cli.ts:71-76`, `doctor.ts` |
| `src/state/db.ts:1829` comment | The retriever does not read topic vectors | It does | `retriever.ts:searchByEmbedding` |
| `src/output/json.ts` header | "these two schemas" | Three schemas plus errors | `output/json.ts` |
| `distiller.ts:95` comment | `Distiller.selectModelFor` | The method is `modelFor` | `distiller.ts:modelFor` |

---

## 11. Open questions

**TL;DR:** Things the code cannot answer.

1. Does anything outside this repo still read `sessions.note_paths` besides `site/scripts/refresh.mjs` and `eval/run.ts`? If not, should those two read the recomputed path instead?
2. Is the Linux scheduler meant to be supported, or should `vir schedule install` refuse on Linux until it is tested?
3. Is `vir calibrate` still used? If so, should it share the cost prompt and filters; if not, can it go?
4. Should `vir run --rewrite-only` take the lock now that it writes every note and `index.md`?
5. Which `--json` contracts are stable for the plugin? `site/.../commands.md` lists only `query` and `doctor`, but `review --json` is a plugin contract.
6. Should `daemon.log` and `cost.log` rotate like `queries.jsonl`?
7. Is the Kie price table still right? `pricing.ts:27` has a TODO to refresh it, and Kie has no `claude-sonnet-5` row.
8. Should `projects/*.md` summaries be excluded from keyword search, like period summaries?
9. The doctor reports 25 sessions in 10 undecided projects with transcripts up to 51 days old: are those projects meant to be included before Claude Code deletes them?
10. Plugin side (out of scope): does `vir-obsidian` validate the `--json` shapes, or trust them?

---

## 12. Explaining this system out loud

**TL;DR:** Twelve questions you are likely to be asked, answered from the facts above.

**1. "Walk me through the architecture."**
*Answer.* vir is a local command-line tool, not a service. It reads the transcript files Claude Code leaves in my home directory, runs the useful ones through an LLM to make short typed notes, and writes those notes as Markdown into my Obsidian vault. State lives in one SQLite file: what was processed, the vectors for search, and what was rejected or demoted. A launchd job runs it every few hours. The same binary also runs as an MCP server, which Claude Code starts as a child process, so the agent can search the notes mid-session. There is no network listener and no database server; that was the point.
*What they test:* whether you can describe boundaries and data flow, not frameworks.
*Follow-up:* "Why not a web service?" Honest answer: it is single-user and the data is personal; a service would add hosting, auth and privacy problems for no benefit.

**2. "Why SQLite and plain files?"**
*Answer.* The notes are the product and the user edits them in Obsidian, so they have to be files. SQLite holds everything the files cannot: content hashes to know what was already paid for, the vectors, retry counters and review overlays. It is synchronous, needs no server, and WAL mode lets the read-only MCP server read while a run writes. Migrations only add columns, because the daemon and the MCP server open old databases.
*What they test:* whether storage was chosen or defaulted.
*Follow-up:* "Where does that break?" A session is linked to its row with `LIKE '%/<id>.jsonl'`, which scans the whole table; fine at thousands of rows, not at millions.

**3. "How do you avoid paying twice for the same work?"**
*Answer.* Every transcript is hashed. A matching stored hash means "done", so the next run skips it for free. All the cheap filters run before the first paid call: project decisions, agent transcripts, demoted notes, and sessions that already failed three times. There is also a pidfile lock so two runs cannot overlap, and a cost prompt on big batches.
*What they test:* idempotency, meaning running the same thing twice has the same effect as once.
*Follow-up:* "What about a failed call?" A failure keeps the old hash and bumps an attempt counter, so the session is retried, but at most three times.

**4. "What was the hardest bug?"**
*Answer.* The lock. The first version checked whether the lock file existed, then wrote it: two steps, so two processes starting together could both win. I fixed that with an exclusive create, then raced eight real processes against it as a check. For a fresh lock it worked. For a stale lock left by a crashed run, I still got about three winners per trial: one process judged the lock stale, another replaced it, and the first deleted the replacement. The fix was a second guard file so only one process at a time may remove a stale lock. After that, twenty trials gave exactly one winner each.
*What they test:* debugging method and honesty about a first fix not being enough.
*Follow-up:* "Why not a database lock?" Some lock holders do not open the database, and a pidfile survives crashes in a way that is easy to inspect.

**5. "How does search work?"**
*Answer.* Every note gets a vector from a local embedding model, Ollama or a bundled fastembed model. A query is embedded the same way and compared by cosine similarity, but only against vectors from the same model. Notes the user approved get a fixed boost, and a diversity step called MMR avoids returning five near-copies. If no vector matches, it falls back to TF-IDF keyword search over the files.
*What they test:* whether you understand embeddings beyond the buzzword.
*Follow-up:* "Is the boost principled?" No: it is a flat +0.2, which nudges cosine scores but dominates the much smaller TF-IDF scores.

**6. "How do you keep secrets out of the notes?"**
*Answer.* Before anything reaches a provider or the database, a scrubber masks API keys, bearer tokens, emails and home paths, and a tool filter strips big tool outputs. That happens in one shared function, so the run and the retry path cannot diverge. The config file with API keys is written owner-only from the first byte.
*What they test:* security posture on a tool that reads private data.
*Follow-up:* "Is the scrubber complete?" No; it is pattern-based, so an unusual secret format gets through.

**7. "What happens when the AI provider is down?"**
*Answer.* One cheap probe call runs before the loop. If it fails, vir records a marker, sends a notification, and stops: one clear failure instead of hundreds of failed sessions. If the subscription quota runs out mid-run, it stops without recording anything, so nothing counts as a failure.
*What they test:* failure isolation.
*Follow-up:* "And a single bad session?" It gets an error row and an attempt counter; after three failures it is parked, and only `vir reconcile --force` retries it.

**8. "Where does it stop scaling?"**
*Answer.* Every run hashes every transcript in full; with a few thousand files that is seconds, but it grows linearly. Search loads every vector and compares them in memory, which is fine for a personal vault of hundreds or a few thousand notes. Both are deliberate: it is a personal tool.
*What they test:* knowing your limits.
*Follow-up:* "What would you change first?" Skip unchanged files by modification time before hashing.

**9. "What trade-off did you accept on purpose?"**
*Answer.* Notes are files the user can edit, so some state lives in two places: approval only in the note's frontmatter, rejection in both the file's location and the database. That costs a sync step on every run, but keeps Obsidian the real interface.
*What they test:* whether you know the cost of your choices.
*Follow-up:* "Has it bitten you?" Yes: rejected notes used to keep serving from the database until a `rejected_at` column was added.

**10. "How is it tested?"**
*Answer.* About 1,070 Vitest tests, colocated with the code, run against a temporary home directory so they never touch real data. Recent fixes were written test-first against a real SQLite file rather than mocks, because the mocked tests had hidden ordering bugs between writing a note and recording it. CI also type-checks the tests.
*What they test:* whether tests caught real bugs.
*Follow-up:* "What is untested?" The MCP request handlers, the CLI wiring, and the Linux scheduler.

**11. "What is genuinely weak?"**
*Answer.* The Linux scheduler is barely tested, and its cron fallback can overwrite a user's crontab if reading it fails. The summarize command's dry run on single projects is not dry: it makes real calls. And the agent-facing `CLAUDE.md` describes an older version, so it misleads future AI sessions.
*What they test:* honesty.
*Follow-up:* "Why not fixed?" They were found while writing this atlas; they are listed in section 9.

**12. "How do you control cost?"**
*Answer.* Every model call goes through one function that logs tokens and an estimated cost. Calls on the subscription, or to a model with no known price, are logged as unknown rather than zero, so totals are not quietly wrong. Big runs show an estimate first, and a subscription run is capped at 25 sessions.
*What they test:* operational maturity.
*Follow-up:* "Any spend without a prompt?" Yes: small runs, `vir calibrate`, and the agent's `vir_query` unless it opts out.

---

## 13. Terms used in this atlas

**TL;DR:** Every technical and project term above, in the order it first appears.

| Term | Meaning |
|---|---|
| transcript | A saved Claude Code conversation (`.jsonl`). → section 6 |
| vault | The Obsidian folder of Markdown notes vir writes into. |
| LLM | Large language model: the AI (Claude) that classifies and writes notes. |
| MCP (Model Context Protocol) | A standard way for an AI app to call tools; vir is an MCP server Claude Code queries. |
| CLI | Command-line interface: the `vir` command. |
| daemon | The scheduled background run of `vir run`. |
| launchd / systemd / cron | The macOS and Linux schedulers that start the daemon. |
| SQLite | A database stored in a single local file. |
| commander | The library that turns `vir <command> --flags` into function calls. |
| CI | Continuous integration: GitHub Actions builds, type-checks and tests every push. |
| WAL (write-ahead log) | A SQLite mode that lets readers read while a writer writes. |
| provider | The service running the model. → section 6 |
| distill | Turning a session into a note. → section 6 |
| embedding / vector | A list of numbers representing a text's meaning, used to find similar notes. |
| Ollama / fastembed | Local programs that compute embeddings. |
| TF-IDF | Keyword search that weights rare words higher; the fallback search. |
| atomic write | Write to a temporary file and rename it, so the file is never half-written. |
| pidfile lock | A file holding the running process ID; only one process can create it. |
| SHA-256 hash | A fingerprint of a file's bytes; same bytes, same hash. |
| gated skip / parked / pruned / rejected / archived | Ways a session or note is taken out of processing or service. → section 6 |
| scrub | Masking secrets and personal paths in text. |
| tool filter | Removing large tool outputs from a transcript before the LLM sees it. |
| classify / retitle | The LLM steps that type a session and title its note. |
| upsert | Insert a row, or update it if it already exists. |
| attempts | A per-row counter of consecutive failures; 3 parks the row. |
| stdout | A process's standard output stream. |
| JSON-RPC over stdio | The message format MCP uses over a process's standard input and output. |
| cosine similarity | How close two vectors point; the search score. |
| MMR (maximal marginal relevance) | Ranking that balances relevance against similarity to results already picked. |
| verified | A note the user approved. → section 6 |
| frontmatter | The YAML block at the top of a Markdown note. |
| migration | A change to the database schema; vir only adds columns. |
| idempotency | Running something twice has the same effect as once. |
| race condition | Two processes acting at the same time produce a wrong result. |
| mock | A fake stand-in for a real component in a test; can hide real behaviour. |
| preflight probe | One cheap call that checks the provider before a run spends money. |
| quota wall | The subscription limit on `claude -p`. → section 6 |
| symlink | A file that points at another file. |
| exit code | The number a command returns; 0 means success. |
| VIR block | vir's owned section in `CLAUDE.md`. → section 6 |
| drift | A doc claim the code no longer matches. |

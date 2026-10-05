# vir — Architecture
*Generated: 2026-10-05 at revision `06c6606` (v0.23.0) · refreshed for v0.24.2 at `23c0652`. `file:line` references and the diagrams are pinned to `23c0652`.*

Supersedes the 2026-06-12 architecture doc and map (v0.8.3; removed, see git history). Changes since that version are listed at the end of this document.

## 1. Project Overview

vir is a local-first Node CLI and daemon. It distills Claude Code session transcripts, clipped web articles and PDFs into a typed Obsidian vault, then feeds that knowledge back into Claude Code in two ways: an opt-in `CLAUDE.md` block sync and a stdio MCP server. It has a single maintainer and is published to npm as `@djolex999/vir-cli` (MIT). A companion Obsidian plugin (`vir-obsidian`) talks to the CLI through a `--json` wire contract. The project is in active weekly development, with 80 colocated test files in `src/` and a separate offline eval harness. Tech identity: strict TypeScript on Node ≥20, better-sqlite3 for state, and three interchangeable LLM backends (Anthropic SDK, Kie.ai over fetch, the `claude -p` subscription CLI).

## 2. Technology Stack

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Language | TypeScript, NodeNext, `strict` + `noUncheckedIndexedAccess` | 5.6 / Node ≥20 | The build excludes tests and `eval/`; `npm run typecheck:all` (`tsconfig.check.json`) checks them |
| CLI | commander, @inquirer/*, chalk, ora | 12.x | 29 actions, all wrapped in `runAction` |
| State | better-sqlite3, WAL mode | 11.x | Additive `ALTER TABLE` migrations; no `user_version` |
| Validation | zod | 3.x | Config schema plus MCP tool inputs |
| LLM | `@anthropic-ai/sdk`, native fetch for Kie, `claude` CLI subprocess | 0.32 | The SDK pin is old next to the `claude-sonnet-5` default model |
| Embeddings | Ollama `nomic-embed-text` (768d) or local fastembed `bge-small-en-v1.5` (384d) | — | Auto-detected; TF-IDF fallback when neither is available |
| MCP | @modelcontextprotocol/sdk over stdio | 1.29 | 6 tools |
| PDF | unpdf | 1.6 | |
| Scheduling | launchd (macOS), systemd user timer, falling back to cron (Linux) | — | Windows is unsupported |
| Notifications | Swift `Vir.app` helper (committed, ad-hoc signed), osascript, notify-send | — | |
| Testing | vitest, colocated `*.test.ts`, `HOME` sandboxed in `vitest.setup.ts` | 4.x | 80 test files in src, 39 in eval |
| CI | GitHub Actions: `cli` (Node 20 build, `typecheck:all`, test) and `site` (Node 22 check/test/build/links) | — | Linux only; no linter, no release workflow |
| Docs site | Astro 7 + Starlight, Preact islands, Tailwind 4 | — | Static output, deployed on Vercel at virwiki.dev |

## 3. Directory Structure

```
src/
  cli.ts              # commander wiring for 29 actions (1,269 lines); big command bodies live in cli/
  config.ts           # ~/.vir/config.json (zod, dir 0700 / file 0600)
  cli/                # runAction chokepoint, guards (lock + paid-step confirm), one module per large
                      #   command (init, lint, embed, summarize, audit, compose, dedupe), review, reconcile
  pipeline/           # run.ts orchestrator, distillSession (core shared with reconcile), scanner, parser, filter, toolCallFilter, scrubber,
                      #   distiller (callLLM), claudeCli, writer, lock, articles/PDFs, composer, summaries
  search/             # retriever (vectors → TF-IDF, MMR), embedding providers, synthesizer, query log
  state/              # db.ts (sessions/articles/topics/pdfs), rejections sync
  mcp/                # stdio server, tool list, claude CLI registration
  claude/updater.ts   # VIR:START/END block sync into CLAUDE.md files
  audit/ prune/ dedupe/ lint/   # vault hygiene: LLM judging, demotion, merge, checks
  cost/               # provider-aware pricing, ~/.vir/cost.log, report
  daemon/             # launchd / systemd / cron router
  diagnostics/        # vir doctor, failure and preflight markers
  output/json.ts      # --json wire types shared with the Obsidian plugin
  ui/                 # display.ts (intended single console owner), notifications
eval/                 # offline retrieval + distill A/B + usefulness harness; imports src one-way
native/notifier/      # Swift source for assets/Vir.app
site/                 # Astro/Starlight docs and marketing site
```

## 4. Route Map

vir has no HTTP routes. Its surfaces are CLI commands, MCP tools and the `--json` contract with the plugin. Auth does not apply because everything runs on the user's machine (see §9).

**CLI commands.** All are wrapped in `runAction`, which sets `process.exitCode` instead of calling `process.exit`.

| Group | Commands |
|---|---|
| Ingest | `run`, `reconcile`, `projects [include\|exclude]`, `embed` |
| Use | `query`, `compose`, `summarize`, `sync-claude`, `status` |
| Curate | `review` (+ `--json`), `audit`, `prune`, `dedupe`, `lint` |
| Operate | `init`, `schedule install\|uninstall`, `doctor`, `cost`, `queries`, `calibrate`, `notifications`, `mcp run\|install\|uninstall\|status` |

**MCP tools** (`src/mcp/tools.ts:4-11`):

| Tool | Reads | Side effects |
|---|---|---|
| `vir_query` | retriever over SQLite vectors plus vault files | Paid LLM synthesis on queries with hits, skipped with `synthesize: false`; appends to `queries.jsonl` and `cost.log` |
| `vir_status`, `vir_recent_notes`, `vir_recent_articles` | read-only DB | none |
| `vir_project_summary`, `vir_compose` | cached `projects/` and `topics/` pages | none; they point at the CLI when a page is missing |

The server never writes the vault or the DB. `vir_query` is its one paid call; since 0.24.0 its tool description says synthesis is billed, so an agent can pass `synthesize: false` to get the notes alone.

## 5. Module Architecture

System map: [architecture-system-map.html](./architecture-system-map.html)

Business logic lives in `src/pipeline/`, with `run.ts` as the orchestrator. `cli.ts` only wires commander to command functions; the large ones live in `src/cli/<command>.ts`. `vir run` and `vir reconcile` share one session core, `distillOneSession`, and keep only their own gates, counters and error policy.

```
cli.ts action → runAction → pipeline/run.ts
  scan → gates → parse → distillOneSession: filter → toolCallFilter → scrub → Distiller(callLLM) → VaultWriter → StateDb
query / MCP → retriever (provider → vectors | TF-IDF) → synthesizer(callLLM)
sync-claude → StateDb.listDistilled → updater.planUpdates → applyPlan → CLAUDE.md
```

The design relies on a few single chokepoints:

- **`callLLM`** (`distiller.ts:329-360`) is the only place an LLM call is made and the only place cost is recorded.
- **`toolCallFilter.ts`** is the only owner of the transcript tool-block grammar.
- **`runAction`** is the only error-to-exit-code mapper.
- **`recordQueryEvent`** is the only writer of the query log.
- **`ui/display.ts`** is meant to be the only console owner. In practice it isn't: the CLI command modules still make 59 raw `console.*` calls, and library code makes 3 (`writer.ts`, `distiller.ts`).

Where tests matter, pure builders are kept separate from side-effectful orchestrators (`buildPrunePlan`/`applyPrunePlan`, `buildReviewQueue`, `selectEmbeddingTargets`, `planUpdates`/`applyPlan`).

## 6. Data Model

SQLite lives at `~/.vir/vir.db` and has four deliberately isolated tables:

| Table | Identity | Purpose |
|---|---|---|
| `sessions` | `path` (transcript), `hash` SHA-256 | Distilled content, classification, embedding and provenance, `skip_reason`, `attempts`, the prune/reject/archive overlays, and audit annotations |
| `articles` | `path`, `hash` | Web-clip notes |
| `pdfs` | `path`, `hash` | PDF notes |
| `topics` | slug of the topic text | `vir compose` pages; upsert preserves `created_at` |

There is no status column. A session's state is derived from `skipped`, `skip_reason`, `error`, `attempts`, `pruned_at`, `rejected_at` and `archived`. See the lifecycle: [lifecycle-session-row.html](./lifecycle-session-row.html).

Rules worth knowing:

- **Verdicts are split across storage.** Review approval (`verified: true`) lives only in note frontmatter. Rejection lives in the file's location (`.rejected/`) plus `rejected_at`. Audit verdicts live only in the DB and never gate serving.
- **Read-only consumers skip migrations.** The MCP server and doctor open the DB read-only, so they guard with `columnsOf`, `servingGate` and `sqlite_master` probes. Only `pruned_at`/`rejected_at` and the table existence checks are guarded. `listDistilled`, `getEmbeddings` and `listDistillFailures` name later-migrated columns without a guard, so they would throw on a pre-migration DB.
- **Articles and PDFs retry up to 3 times (0.23.1).** An error is recorded with the hash and bumps `attempts`. `isArticleProcessed`/`isPdfProcessed` treat an errored row as unprocessed until it has failed 3 times on the same bytes; a changed file starts over.

## 7. Data Flow

**Flow: transcript to note (`vir run`, daemon every N hours).** Diagram: [dataflow-distill-pipeline.html](./dataflow-distill-pipeline.html)

```
~/.claude/projects/**/*.jsonl
  → scan + SHA-256 (every file, every run)
  → category / agent gates → project decision (include | exclude | pending | flag-skip)
  → cache (hash) → pruned → parked (attempts ≥ 3)          [all free; config skips write a skip_reason row]
  → preflight probe (one 5-token call; aborts the run on an outage)
  → parse → heuristic score ≥ 0.4 → toolCallFilter → scrub
  → classify (Haiku) → confidence ≤ 0.6 dropped → distill (Sonnet / hybrid) → retitle
  → VaultWriter.write (embed, Related links) → db.record
  → after the loop: project summaries, articles, PDFs, embedding sweep
```

Error handling is per session. A generic error calls `recordError` and increments `attempts`. A `ClaudeCliLimitError` halts the run and writes no error rows; since 0.23.1 that includes skipping project summaries and the article and PDF phases.

**Flow: MCP query.** Diagram: [sequence-mcp-query.html](./sequence-mcp-query.html)

```
Claude Code → vir_query (stdio)
  → searchWithOutcome: embed query → same-model vectors from all 4 tables → cosine floor
    → read files, +0.2 for verified → MMR top-k   (TF-IDF over vault files on 0 hits)
  → recordQueryEvent → synthesize via callLLM (paid; skipped with synthesize: false) → answer + sources
```

**Flow: knowledge return.** `vir sync-claude` reads `listDistilled` and rewrites the bytes between `VIR:START` and `VIR:END` in the global and per-project `CLAUDE.md` files. It refuses to touch a file with unbalanced markers. Since 0.24.0 writes are atomic (temp file + rename onto the resolved path, so a dotfiles symlink survives). A failed `applyPlan` exits 1.

## 8. External Services

| Service | Purpose | SDK | Credentials | Risk |
|---|---|---|---|---|
| Anthropic API | classify, distill, synthesis, compose, audit | `@anthropic-ai/sdk` | `~/.vir/config.json` (0600, plaintext) | Critical when selected |
| Kie.ai | cheaper Anthropic proxy | fetch with Bearer token, 120s abort | same | High: errors arrive inside HTTP-200 bodies (handled by `kieResponseError`); a model with no Kie price is logged as unpriced, never $0 |
| `claude` CLI | subscription-quota provider | `spawn` of the binary found by `resolveClaudeBin` (PATH, then common install dirs), argv array, 600s timeout | Claude Code's own auth | High: quota walls |
| Ollama | 768d embeddings at localhost:11434 | fetch | none | Low; best-effort |
| fastembed (local) | 384d embeddings, installed into `~/.vir/embedder` | dynamic import | none | Low |
| SQLite | state and idempotency | better-sqlite3 | local file | High: source of truth |
| Obsidian vault | the product output | fs | local | Medium: plain markdown |
| launchd / systemd / cron | cadence | spawnSync | — | Low |
| Vercel | docs site | — | — | Low |

## 9. Authentication & Authorization

This is a local single-user tool: no accounts, no sessions, no network listener (MCP runs over stdio). The security model has three parts:

- **Secrets at rest.** The `~/.vir` directory is 0700 and the config file is 0600, and permissions are healed silently on load. `saveConfig` writes a 0600 temp file and renames it into place, so the keys are never readable by others.
- **Scrub before persist.** Anthropic, OpenAI, GitHub and AWS keys, Bearer tokens, emails and home paths are masked before anything is written to the vault, the DB or the logs. Only `/Users/` paths outside `$HOME` are collapsed; Linux equivalents are not.
- **Path-guarded `--json` review actions.** Targets must resolve to `<category>/<name>.md` under the vault root, and the action takes the pidfile lock.

## 10. Deployment

Everything runs on the user's machine.

1. `npm install -g @djolex999/vir-cli`
2. `vir init`
3. `vir schedule install`, which writes a launchd plist (`com.github.djolex999.vir`, `StartInterval` = cadence × 3600, logs to `~/.vir/daemon.log`) or a systemd user timer or a cron line.

The build is plain `tsc` into `dist/`. The npm `files` allowlist ships `dist/`, the logo and `assets/Vir.app`. Publishing is manual and gated by `prepublishOnly: build && test`. The docs site deploys statically to Vercel. Runtime files under `~/.vir`: `vir.db`, `config.json`, `vir.lock`, `cost.log`, `queries.jsonl`, `daemon.log`, `provider-preflight.failed`, `claude-cli-limit.confirmed`, `embedder/`, `Vir.app`.

## 11. Patterns & Conventions

These conventions are specific and mostly well held:

- **Free before paid.** Every gate runs before the first billed call, and every config-driven skip records its reason.
- **One environmental fact, one failure.** The preflight probe and the claude-cli limit halt both stop the run once instead of failing every session.
- **Exit codes, not exits.** `process.exitCode` everywhere; zero `process.exit` calls.
- **Additive migrations.**
- **Stable-identity slugs.**
- **Reversible demotion.** Pruned and rejected rows keep their content, so a restore is exact.
- **Sandboxed tests.** `vitest.setup.ts` points `HOME` at a temp dir.
- **One-way eval isolation**, guarded by `eval/noLeak.test.ts`.

**Inconsistencies:**

- **The display monopoly is eroding.** There are 59 raw console calls across `cli.ts` and the `src/cli/` command modules, plus `writer.ts:231` and `distiller.ts:630,719`. The MCP server imports `writer.ts`, so any future stdout write on that path corrupts JSON-RPC.
- **Duplicated code:**
  - `kebab` is copied in three files, even though `slug.ts` claims to be the single definition.
  - `parseFrontmatter` appears in three places.
  - The `runArticlePhase` and `runPdfPhase` functions are near-clones.
- **`runPipeline` is still about 1,000 lines in one function.** The shared session core moved out; the gates, dry-run estimator and phases did not.

## 12. Risks & Recommendations

The original `[DO NOW]` and `[DO LATER]` items are all fixed (see the end of this document). What remains is maintenance:

### [DO IF IT BREAKS] Finish the display monopoly and the remaining duplication
**Observation**: 59 raw console calls in the CLI modules and 3 in library code; `kebab` and `parseFrontmatter` copied three times; `runArticlePhase`/`runPdfPhase` near-clones; `runPipeline` still ~1,000 lines.
**Action**: route command output through `ui/display.ts` module by module; merge the doc phases when either changes next. (M)

### [DO IF IT BREAKS] Read-only paths on a pre-migration DB
**Observation**: the MCP server and doctor skip migrations; `listDistilled`, `getEmbeddings` and `listDistillFailures` name later-migrated columns without a guard.
**Action**: guard them like `getStats` if an old DB is ever served read-only before a write. (S)

---

**Since the 2026-06-12 doc:**

- **Fixed:**
  - the article NULL-embedding blind spot (`selectArticleEmbeddingTargets`);
  - `applyPlan` is now tested (`updater.test.ts`);
  - 0.23.1: a claude-cli quota halt no longer loses articles and PDFs, and errored ones retry up to 3 times;
  - 0.23.2: the pidfile lock is atomic, including stale-lock reclaim (guarded by `vir.lock.reclaim`).
  - 0.23.3: a filter or low-confidence skip of a re-processed session keeps its note (plus a one-time repair of notes it had hidden);
  - 0.24.0: write-time embeddings reach new rows and the sweep embeds the same text; `vir_query` `synthesize: false`; `claude` found under the daemon's PATH; locks on review/dedupe/audit/compose/summarize and cost prompts for dedupe/lint; atomic `CLAUDE.md` writes; tests and `eval/` type-checked in CI; `distillOneSession` shared by run and reconcile; large commands moved out of `cli.ts`;
  - 0.24.1: no crash when the preflight probe fails; `sync-claude` exits 1 on a failed write; `config.json` written owner-only from the first byte; unpriced models logged as unknown, not $0.
  - 0.24.2: reconcile applies vir run's filters and reports deleted transcripts; failed reconcile retries count toward the retry bound; real estimate in the run cost prompt; `$EDITOR` with arguments; `--full` covers articles/PDFs; oversized transcripts trimmed to fit; Linux home paths scrubbed.
- **New since then:**
  - the `claude-cli` provider;
  - PDFs;
  - local embeddings and model provenance;
  - audit, prune and the rejected-row overlays;
  - project triage;
  - the eval harness;
  - CI.
- **Still open:** see §12.

# Changelog

## 0.17.5 — 2026-09-11

**`vir prune`.** 0.14.0's agent-transcript filters are forward-only, so every
note distilled before them is still in the vault, the embedding pool, TF-IDF
and all six MCP tools. This demotes them. Dry run is the default; nothing is
ever deleted.

- **`vir prune`** reports what it would demote, per reason, and exits.
  `--apply` moves each note to `.rejected/` and marks its row; `--restore`
  puts every pruned note back byte-for-byte. On the vault this was built
  against: 132 candidates (129 sidechain, 3 workflow), 278 kept.
- **Prune state is DB-authoritative** — `pruned_at` + `prune_reason` on the
  sessions row. Deliberately NOT `skipped`: flipping that on a row holding a
  note is the 0.14.0 semi-prune. And deliberately not frontmatter, which is
  invisible to SQL — the reason `vir review`'s `.rejected/` move leaks through
  eight DB-backed read paths today (`listDistilled` and everything downstream,
  `getStats`, the embedding sweep). Every serving query now carries
  `prunedGate()`, which is a no-op on a DB whose migration has not run, so the
  read-only MCP path still opens an un-migrated database.
- **Gated at the paid boundary.** `--full` bypasses `isProcessed`, so without
  a gate in the run loop it re-classifies and re-distills every pruned session
  and only discovers at `write()` that the note is demoted — billing you on
  every run, forever. The check sits beside the retry bound, which has the
  same "even under --full" reasoning.
- **Classification is pure and zero-I/O.** 396 of 411 distilled transcripts no
  longer exist on disk (Claude Code prunes at ~30 days), and `entrypoint` was
  never backfilled — NULL on 376 of 411 rows — so the stored path does the
  work: `subagents/` yields sidechain, `wf_`/`workflows` yields workflow, and
  a stored `sdk*` entrypoint yields agent. The launcher traps hold by
  construction: the classifier reads `entrypoint` only, never `promptSource`
  (which reads "sdk" on desktop-launched human sessions) and never turn count
  (which would kill single-prompt autonomous runs).
- **Two buckets are reported and never pruned.** `unclassifiable` (no
  entrypoint, transcript gone — 231 rows) and `merge-winner` (dedupe records
  no parentage, so a winner cannot be shown to be all-agent — 12 rows). A
  prune that guesses is a delete with extra steps.
- **`--restore` is exact.** A pruned row keeps its content, embedding and
  hash; the note is stamped with prune's own frontmatter keys, never review's
  `rejected_at`, so a note that is both rejected and pruned restores cleanly.
- **Kept notes are never edited.** Dangling wikilinks pointing at pruned notes
  are counted and reported (177 on the reference vault), never rewritten.
- **`vir doctor`** gains a human-table row with pruned counts per reason and
  the restore hint. The 8-field `doctor --json` contract is unchanged.
- `CATEGORY_DIR` is exported from `writer.ts` rather than re-declared.

## 0.17.4 — 2026-09-11

**Four findings from the July audit backlog.** Two of them lose data; two
lie quietly. No new surface.

- **A garbled classify response no longer buries a session forever.**
  `parseClassification` folded an unparseable response into a confidence-0
  verdict, which `run.ts` recorded as `skipped: true` with the current hash
  — and `vir reconcile` only targets `skipped = 0`. One transient
  formatting glitch dropped that session's knowledge with no recovery path,
  indistinguishable from a session the model had genuinely judged dull. The
  two now diverge where the distinction exists: the fallback branches are
  marked `unparsed` and `run()` throws `ClassifyParseError`, which the
  existing handler routes through `recordError` (skipped = 0, error set,
  attempts + 1). The session becomes a reconcile target and
  `MAX_DISTILL_ATTEMPTS` bounds it at 3 consecutive failures. A real
  low-confidence verdict is untouched — that one is an answer, not an
  accident. (bug-hunt #17)
- **`vir sync-claude` no longer mangles a hand-edited CLAUDE.md.** Both
  markers were matched with a bare first-`indexOf`, no ordering or balance
  check, against a file the user edits by hand. An orphan `VIR:START`
  failed the guard and a SECOND block was appended — and the next sync then
  sliced from the orphan to the new block's END, deleting every line
  written between them (the deletion is armed by one sync and sprung by the
  next). `END` before `START` duplicated the region between them; a second
  complete block was left behind forever; and markers inside a fenced code
  block counted as real, so a CLAUDE.md that DOCUMENTS vir's markers got
  edited at the example. Markers are now located fence-aware and paired
  forward into complete blocks; unbalanced markers are refused with a
  reason and nothing is written, because appending was what armed the
  deletion. `applyPlan` returns `{ ok, reason }` and `vir sync-claude`
  prints it. (bug-hunt #13)
- **A `config.pricing` override for an unknown model no longer logs $0.**
  `resolvePricing` returned null as soon as the model was absent from
  `DEFAULT_PRICING`, before overrides were consulted — so an override for a
  model id newer than the table, which is exactly what the override exists
  for, priced the run at $0 silently. Only a COMPLETE override stands
  alone: with no base to patch, half a price is a wrong price. (bug-hunt
  #14)
- **MCP stops telling clients three untrue things.** It announced
  `version: "0.1.1"`, a literal untouched since the first release — now
  `readVirVersion()`, with a test asserting the initialiser carries no
  literal at all. `vir mcp install` advertised 4 tools while the server
  registers 6; both sides now read one `VIR_TOOLS` list, pinned by a test
  that scans the server's own `registerTool` calls, so a new tool cannot
  ship half-announced. And `getStats()` names six migration-added columns
  while the read-only MCP path deliberately skips migrations, so on an
  upgraded-but-never-written DB `vir_status` died with `no such column:
  category`; it now degrades to empty stats. (bug-hunt #19)

## 0.17.3 — 2026-09-11

**A note is identified by its session, not by its title.** Completes the
0.17.2 fix, which only covered half the cases. Includes everything in
0.17.2, which was tagged but never published.

- **A retitle no longer loses the review verdict or forks a duplicate.** A
  note's path is `makeSlug(topic, sessionId)` — built from the *topic*, which
  the distiller changes between runs on purpose (0.9.1 retitles
  deliberately). The path was therefore never identity. Every consumer that
  recomputed it from the current topic missed the note it meant to update:
  `preservedReviewFields()` read the new path, so `verified` / `reviewed_at`
  and the +0.2 retrieval boost were dropped; the old note stayed behind as a
  duplicate; and the 0.17.2 `.rejected/` guard keyed off the current slug
  too, so a retitled note came back rejected-no-more. Three symptoms, one
  cause. (bug-hunt #12, finishing #9)
- **`locateBySession()`** indexes the vault by the filename's session suffix,
  built once per writer and kept current as notes are written — a rescan per
  note would be O(n²) on a vault with thousands. `.rejected/` is scanned last
  so it wins: a rejection is the authoritative location for its session. A
  stale hit (a note `vir review` moved between runs) triggers one rebuild;
  a miss never does, so a batch of new notes doesn't rescan per note.
- **The suffix is an index hint; the full id is the authority.** `makeSlug`
  truncates the session id to 8 characters, so two sessions can share a
  filename suffix — and a match authorises deleting the old file. Every hit
  is confirmed against the `session_id` in frontmatter before it is used. A
  collision degrades to an orphaned duplicate, never a deletion. (The first
  draft of this patch resolved on the suffix alone and deleted the colliding
  note; the collision test caught it.)
- **`write()` retires what it replaces** — on a retitle the old file is
  removed and its `index.md` row dropped, since append mode never
  regenerates the index.
- **`archived/` is deliberately not indexed.** A dedupe-merged note being
  re-created by a re-distill is the same shape of problem, but what a merge
  should mean for the loser's session is a product decision, not a
  refactor — it gets its own.

## 0.17.2 — 2026-09-11

**Rejection sticks.** `vir review` rejections survive a `--full` re-distill.
No other behavior changes.

- **A rejected note no longer comes back.** `vir review` rejects by *moving*
  the note into `.rejected/`, which left the category path empty — so
  `preservedReviewFields()`, which carries a verdict across a rewrite by
  reading the destination path, found nothing and a re-distill wrote the
  note straight back as if it had never been rejected. `rejected_at` was in
  that function's keep-list the whole time; it just never had a file to be
  read from. `write()` now checks `.rejected/<slug>.md` first and returns
  that path untouched when it exists: the slug is
  `makeSlug(topic, sessionId)`, so a re-distill of the same session resolves
  to the same filename and the check is exact, not a heuristic. The
  embedding call and the index and log appends are skipped for a note nobody
  wants. `vir reconcile` and rewrite-only runs share `write()`, so one guard
  covers all three paths. (#9)
- **`REJECTED_DIR` has one definition**, in `writer.ts`, imported by
  `review.ts`. The literal was declared in both files — the same drift that
  produced the slug-helper bug (bug-hunt #1), caught before it could bite
  twice.

## 0.17.1 — 2026-09-04

**Website and brand.** No CLI behavior changes.

- **virwiki.dev.** Single-page site in `site/` (Astro, Preact islands, static
  on Vercel): live graph of a real vault sample laid out at build time, the
  note anatomy with the exact `writer.ts` frontmatter, measured numbers
  instead of a benchmark, cost stated up front, dark mode.
- **New mark.** The graph-spiral logo replaces the whirlpool across README,
  the npm package asset, the site, and the Obsidian plugin (vir-obsidian
  0.2.2 ships the matching ribbon icon).
- README numbers re-measured: 534 tests, 396 rescued sessions, 1,386 → 410
  transcripts-to-notes.

## 0.17.0 — 2026-08-13

**New distill provider: your Claude Code subscription.** `provider:
"claude-cli"` shells out to the installed `claude` binary in print mode —
zero per-session dollars, zero credentials. The API path (anthropic) stays
the default for new and existing installs; this ships as an option until it
has real mileage. Existing configs are untouched.

- **`claude-cli` provider** behind the existing `callLLM` seam, alongside
  anthropic and kie. Spawns `claude -p` with arg arrays (never a shell
  string), prompt on stdin, JSON envelope out, per-invocation `--model`
  pinning — hybrid routing survives. Two structural correctness
  requirements, enforced by tests rather than convention:
  `--no-session-persistence` always (vir never writes transcripts into
  `~/.claude/projects` — no self-scanning, no disk bloat) and a fixed
  neutral spawn cwd (`~/.vir`, so no project's CLAUDE.md can leak into
  distill context). Neither has a config path that could omit it.
- **Subscription limits are a wall, not a 429.** A detected limit
  (`ClaudeCliLimitError`) is never retried, halts `vir run` and
  `vir reconcile` with one message carrying the reset time, and burns no
  per-session attempt counters — one environmental fact, not N failures
  (the preflight-probe lesson). The detection regex is docs-sourced and
  honestly labeled UNVERIFIED: any unrecognized error envelope is written
  raw to daemon.log once per run as evidence, unknown errors fail safe
  (no retry chains), the first real match stamps
  `~/.vir/claude-cli-limit.confirmed`, and a new `vir doctor` "limit
  detection" row reports whether the pattern has ever been confirmed.
- **Batch cap: 25 sessions per run** on claude-cli only. Subscription quota
  has no meter, so a big backlog is bounded per cycle (~50 CLI calls ≈ one
  heavy interactive session); the cap is stated before the loop starts and
  the deferred remainder is reported and picked up next run. API providers
  are never capped.
- **Cost honesty.** claude-cli calls land in cost.log with
  `estimated_cost_usd: null` — cost not-applicable, never a fake $0.00
  that would corrupt dollar aggregates. `vir cost` reports them as a
  separate subscription-calls count, excluded from total/median/p90;
  dry-run estimates label "subscription quota (no $)".
- **`vir init` presents the choice honestly**, one line each: API key =
  predictable per-session cost, no effect on Claude Code limits;
  subscription = free and keyless, consumes your Claude Code usage limits.
  claude-cli asks for no key. `vir doctor` authenticates it with the
  existing claude-CLI detector plus a live ping.
- **Re-init key survival is now enforced by schema enumeration.**
  `buildInitConfig` had silently dropped a config key three times (bug #5,
  the projects map, logQueries); a new test enumerates `ConfigSchema`
  itself, so any future key must declare a survival sample and be carried
  over — by construction, not by remembering. The test immediately caught
  a FOURTH live drop: `embeddingProvider` (never carried since 0.15.0 — a
  configured provider silently reset to auto-detect on re-init). Fixed.

## 0.16.0 — 2026-08-13

**Retrieval logging.** Every `vir query` and MCP `vir_query` retrieval now
appends one record to a local, append-only `~/.vir/queries.jsonl` — which
notes surfaced, at what rank and score, by which method, and how fast. The
log is the ground truth for which notes earn their place in retrieval, and
the baseline for future ranking work. Local-only, never transmitted; the
synthesized answer is never recorded. Additive release: ranking, thresholds,
and retrieval behavior are unchanged.

- **Query log** (`~/.vir/queries.jsonl`, JSONL, not SQLite — the read-only
  MCP facade must never write the DB, and file appends don't contend with
  the daemon's SQLite lock). One record per query, written after retrieval
  resolves and before synthesis: timestamp, source (`cli`/`mcp`), query
  text, type filter, method (`embedding`/`tfidf`), degraded flag + reason,
  provider provenance (name/model/dim, null on tfidf), candidate count
  above the floor, model-mismatch exclusions, search latency, and per-hit
  `{slug, rank, score, verified}` — `verified` per hit is how the flat
  +0.2 `VERIFIED_BOOST` eventually gets calibrated instead of guessed.
- **Best-effort, never silent.** A log write failure can never fail a
  query (outer guard, unit-tested), but it emits one stderr line (stderr
  only — MCP stdout is the JSON-RPC channel) and stamps
  `~/.vir/queries.failed`, which the new `vir doctor` "query log" check
  surfaces when a failure post-dates the last successful write within 7
  days. Human table only; the 8-field `doctor --json` contract is unchanged.
- **Rotation.** The log caps at 5 MB; at the cap it rolls to
  `queries.jsonl.1` (one generation kept, ~10 MB bound total). Readers
  merge both generations in order.
- **`vir queries` (+ `--json`).** The payoff: total queries, method split,
  degraded rate, most-surfaced notes with mean rank, and the dead-weight
  list — notes that never surfaced in any logged query, the prune target.
  Dead weight is suppressed (JSON: `null`, never `[]`) below 20 logged
  queries: with a small sample "never surfaced" means unasked, not unused,
  and the report refuses to dress noise as signal.
- **Config: `logQueries`** (default `true`). Documented in the README:
  logged locally, never transmitted, delete anytime, `"logQueries": false`
  to disable.
- `SearchOutcome` gained `candidates` and `provider` provenance fields
  (additive, telemetry-only — never a ranking input).

## 0.15.0 — 2026-07-31

**Embeddings are now optional and provider-agnostic.** A new user needs only
an API key: semantic search activates on demand, and keyword search is a
supported floor, never an error state. Schema migration (additive), a new
provider, and new command surface.

- **Embedding model provenance.** Every embedding row stores the model and
  dimension that produced it (`embedding_model` / `embedding_dim` on all four
  tables; additive migration, existing rows backfill to `nomic-embed-text`/768).
  Retrieval refuses to compare vectors from different models — cosine across
  incompatible geometries is confident nonsense — and reports the excluded
  count instead of silently mixing them.
- **`EmbeddingProvider` interface** (`embedDoc`/`embedQuery`, `modelName`,
  `dimensions`, `maxInputChars`). Ollama is now one implementation, not the
  assumption.
- **Local provider: `vir embed --setup`.** Installs fastembed +
  bge-small-en-v1.5 (384d) into `~/.vir/embedder` on demand — never a package
  dependency (the CLI tarball stays ~212 kB). States the disk cost (~233 MB +
  ~128 MB model) and asks before touching disk or network. No node-gyp, no
  build step, ~190 ms cold start.
- **Provider resolution**: configured (`embeddingProvider` in config, optional)
  > Ollama detected > local installed > none. `vir init` asks no embedding
  question; when nothing resolves, `vir run` prints a one-line offer once per
  run and continues on keyword search.
- **Per-model similarity thresholds** (`RELATED_MIN_SIM`, the candidate floor)
  moved into a per-model table. bge values calibrated against a real 389-note
  vault by quantile-matching nomic's floors (doc-doc distributions are
  near-identical across the two models; bge query scores run ~0.15 hotter).
- **Honest labeling.** `via: tfidf (no provider)` is distinct from
  `via: tfidf (embeddings failed)` — different states, different fixes.
  `vir doctor` reports the active provider, model, dimension, alternatives
  with their costs, and the count of notes embedded under a different model
  (non-zero means an unfinished migration; `vir embed --force` finishes it).
- **Model-boundary re-embeds require consent.** `vir embed --force` across a
  model boundary states the note count and estimated time first; plain
  `vir embed` fills same-model gaps only. The index stays queryable at every
  point mid-migration.
- **Context-limit fix.** Ollama serves nomic at num_ctx 2048; notes over ~8k
  chars used to 500 and silently NULL their embedding forever. `embedText`
  now truncates at the model limit (recorded, not silent) with reactive
  halving, and `EmbedderError` carries a typed kind
  (`context-limit` / `http` / `network`) so daemon.log distinguishes a
  too-big note from a down Ollama.
- **TF-IDF idf smoothing** (`log(1 + N/df)`): a single-note vault can now
  find its own note (bare `log(N/df)` zeroed every term when df = N).
  Established-vault rankings shift minimally (top-3 changes limited to
  adjacent swaps on a 412-note corpus).
- `OLLAMA_HOST` env var overrides the Ollama base URL (Ollama's own
  convention).

## 0.14.0 — 2026-07-31

**Project-level and transcript-category distillation filtering.** Every
filter gates at the SCAN phase — before the paid classify call — and every
skip records a DB row with its reason; never a silent omission.

- **Per-project decisions** (`projects` config map, three-state: include /
  exclude / absent = undecided). Undecided sessions record `project-pending`
  and wait; the daemon never prompts (macOS notification instead, behind the
  new `notifications` flag); interactive `vir run` and `vir init` triage via
  a multi-select showing session counts and rough costs. Multi-select
  defaults to over-capture (undecided starts checked) — transcripts prune at
  ~30 days, so a wrong exclude is permanent.
- **`vir projects`**: per-project table (decision, sessions, distilled,
  pending, excluded, est. pending cost), `include|exclude <name>`, `--json`.
- **Project identity** decoded from transcript dir names by longest match
  against real on-disk directories (handles dashed names, dots, deleted
  cwds; falls back to the raw dir name, never guesses).
- **Nested workflow/subagent transcripts** (`subagents/…`, `wf_*`) are
  agent-internal execution, excluded by default (`workflowTranscripts`),
  with distinct `workflow-transcript` / `sidechain-transcript` skip reasons.
- **Top-level SDK-launched harness agents** (review/verify transcripts —
  first user line's `entrypoint` starts with `"sdk"`) excluded by default
  under their own `agentTranscripts` key and `agent-transcript` reason;
  detected entrypoint persisted per session; doctor reports counts by
  entrypoint. On the audited machine these were 67 of 97 top-level
  transcripts.
- **All filter skips are reversible** (flipping a decision or knob re-enters
  the transcripts) and **forward-only** (a row holding a distilled note is
  never overwritten — existing notes stay retrievable).
- **One-off run scoping**: `vir run --only <p>` / `--exclude-project <p>`
  (repeatable, never persisted).
- **`vir doctor`**: warns on undecided projects (with oldest-transcript age
  and the ~30-day prune deadline); informational agent-transcript line.
- **Default provider is now anthropic + claude-sonnet-5** (Kie stays fully
  supported; existing kie configs untouched, one-line notice on interactive
  runs). Provider preflight probe makes an outage one clear failure instead
  of N retry chains.
- **`vir init` masks API-key input** and echoes only a masked confirmation.
- New dep: `@inquirer/checkbox` (the multi-select). Additive DB migrations:
  `skip_reason`, `entrypoint`.

## 0.13.0 — 2026-07-30

- **Retry bound:** 3 consecutive failed distills park a session (new
  `sessions.attempts` column, reset on success) — `vir run` skips it even
  under `--full`; `vir reconcile --force` is the only way back in.
- **Process lock:** `~/.vir/vir.lock` pidfile with stale-PID reclaim
  serializes distiller-calling commands; a second `vir run`/`vir reconcile`
  exits immediately with the holder PID instead of double-spending.
- **`vir schedule install` no longer starts a paid run** (`RunAtLoad` is now
  false); new `--run-now` flag opts into an immediate first tick.
- **`vir doctor` backup-freshness check** (renders only when
  `~/.vir/backup.sh` exists): warns when the last successful backup is
  older than 48h.

Earlier releases (≤ 0.12.0) are documented in their annotated git tags and
commit messages (`git log --oneline --decorate`).

## 0.12.1 — 2026-07-30

Bug-fix release: eight fixes, all TDD (RED → GREEN), one commit each.

- `vir run --rewrite-only --dry-run` no longer rewrites the vault under the
  dry-run banner — it reports the would-rewrite count and exits before any
  write or index regeneration.
- Network-level fetch failures (`TypeError` with an error `cause` — undici's
  ECONNREFUSED/ENOTFOUND/socket-reset shape) are now retryable on the Kie
  path; previously they burned zero retries (30 of 41 backlog rows).
- `vir doctor`'s Ollama check performs a one-shot embedding probe instead of
  a reachability ping; `--json`'s `ollama.model` is the probe result (null
  when embedding fails), never an echoed constant.
- Embedding failures during `vir query` degrade to TF-IDF *loudly*: the error
  is surfaced, the result set is marked degraded, and the `via:` label
  reflects what actually served the results.
- A failed re-distill no longer records the transcript hash (hash = success
  marker), so changed transcripts stay eligible for `vir run`; the reconcile
  selector also claims error rows with surviving content (rescuing rows
  already orphaned) and restores the last good note when the source
  transcript is gone.
- `vir doctor` distinguishes daemon "not installed" from "installed but not
  running" — and the latter no longer reports ok.
- The TF-IDF fallback walk skips `.rejected/` and `archived/`, so
  human-rejected and dedupe-archived notes can never resurface via
  `vir query` / MCP `vir_query`.
- `docs/bug-hunt-2026-07.md` re-verified: 6 findings marked resolved with
  source refs, 3 marked not-re-verified.

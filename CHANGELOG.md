# Changelog

## 0.17.1 — 2026-09-04

**Website and brand.** No CLI behavior changes.

- **virwiki.dev.** Single-page site in `site/` (Astro, Preact islands, static
  on Vercel): live graph of a real vault sample laid out at build time, the
  note anatomy with the exact `writer.ts` frontmatter, measured numbers
  instead of a benchmark, cost stated up front, dark mode.
- **New mark.** The graph-spiral logo replaces the whirlpool across README,
  the npm package asset, the site, and the Obsidian plugin (vir-obsidian
  0.2.2 ships the matching ribbon icon).
- README numbers re-measured: 548 tests, 396 rescued sessions, 1,386 → 410
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

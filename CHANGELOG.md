# Changelog

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

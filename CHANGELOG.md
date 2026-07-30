# Changelog

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

---
title: "json-output-contract"
description: "Decision distilled by vir from a Claude Code session on 2026-05-27. Added `--json` output mode to `vir query` and `vir doctor` commands in the vir CLI (v0.7.1), creating a stable machine-r"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `7bcca3cb` · 2026-05-27 · classifier confidence 0.92
:::

## Summary

Added `--json` output mode to `vir query` and `vir doctor` commands in the vir CLI (v0.7.1), creating a stable machine-readable contract for the upcoming vir-obsidian plugin. Pure builder functions were extracted into `src/output/json.ts` and tested in isolation using TDD before wiring into the CLI. A subsequent security review traced all changed files from entry point to sink and found no vulnerabilities — the change is read-only structured JSON reporting for search queries and diagnostics.

## What Was Learned

**JSON output contract for CLI commands (`vir query --json` / `vir doctor --json`)**

- `query --json` emits a JSON array to stdout (`[]` when empty, exit 0). On failure: stdout is empty, a single-line `VirErrorPayload` goes to stderr, exit non-zero. Ollama being unavailable is not a failure — the retriever degrades to TF-IDF, so results still return.
- `doctor --json` emits one JSON object, always exits 0. Health lives in the `daemon` field (`ok`/`stale`/`down` via a 2× polling-interval window).
- `query --json` skips synthesis (no LLM token spend), returns raw retriever hits mapped to the wire schema.

**Architecture: pure builders for CLI output modes**

- To unit-test a new CLI output mode without spawning the binary, extract the domain→wire-schema mapping into pure functions in their own module. The command `.action()` becomes a thin wrapper: gather side-effectful inputs (config, DB, filesystem, network), call the builder, serialize, set exit code.
- `src/output/json.ts` followed this pattern: 14 fast unit tests cover the schema and daemon-health classification (injectable `now`). The untestable wiring (empty-stdout-on-error, exit codes) was verified with one live smoke run.

**Unreachable enum entries in error contracts**

- A wire-contract error `kind` enum may legitimately include a value you never emit. `ollama_unavailable` exists in `VirErrorPayload` for the consumer's exhaustiveness check, but the CLI never emits it because Ollama-down is handled gracefully (TF-IDF fallback). Document why at the definition site, or a future maintainer may "fix" the gap by making Ollama-down an error and silently break graceful degradation.

**`prepublishOnly` as a publish guard**

- Added `"prepublishOnly": "npm run build && npm test"` to `package.json`. This fires on both `npm publish` and `npm publish --dry-run`, preventing a stale `dist/` or red tests from shipping. The manual `npm run build` before publish is still recommended so the tarball preview reflects the current state.

**Security: stdout/stderr contract for CLI ↔ plugin IPC**

- When a plugin parses `JSON.parse(stdout)` without guards, the CLI must guarantee stdout is empty on failure. Enforce this by routing all error payloads exclusively to stderr, and verify that no transitive dependency (e.g., embedder, search modules) writes to stdout or `console.log`.

**Security: deliberate secret exclusion from diagnostic payloads**

- `runDoctorJson` intentionally omits any API key health check so credentials are never serialized into the JSON output. Diagnostic endpoints should emit only operational metadata (paths, db size, version, model name), never secrets — even when the secret probe exists elsewhere in the codebase.

**Security: same-user local surface reduces cross-principal risk**

- CLI ↔ plugin trust boundaries where both sides run as the same OS user do not constitute a cross-principal boundary. File paths in stderr error messages are conventional in this context and not a reportable leak.

**Retrieval ranking: verified-note boost applied pre-slice**

- Notes with `verified: true` in YAML frontmatter receive a flat `+0.2` score boost applied *before* the `topK` slice in both embedding and TF-IDF paths. This ensures human-approved notes can outrank unverified ones that would otherwise fall just inside the window. In TF-IDF, the boost is only applied when `score > 0` (lexical match required), preventing verified notes from surfacing on zero overlap.

**Retrieval ranking: MMR reranking for embedding diversity**

- The embedding search path uses Maximal Marginal Relevance (MMR) to rerank results. The user-facing `retrievalDiversity` config (1.0 = pure diversity) is inverted before passing to `mmrRerank`, where `lambda` is the relevance weight — a UX convention inversion that should be documented at the call site.

## Context

- **Project:** vir
- **Category:** decision
- **Date:** 2026-05-27 (query JSON contract design: 18:22 UTC; security review: 18:55 UTC)

## Related

- `src/output/json.ts` — pure JSON builder, no I/O; the canonical builder module and wire schema types (`VirQueryResult`, `VirDoctorResult`, `VirErrorPayload`)
- `src/output/json.test.ts` — 14 unit tests covering schema shape, daemon health classification, and error payloads
- `src/cli.ts` — `runQueryJson`, `runDoctorJson` entry points
- `src/diagnostics/doctor.ts` — diagnostic payload, secret exclusion pattern
- `src/search/retriever.ts` — MMR rerank, verified boost, embedding/TF-IDF fallback logic
- `src/search/embedder.ts` — Ollama embedding client (`nomic-embed-text`)
- `src/mcp/server.ts` — existing `parseFrontmatter` / `categoryFromTitle

## Archived Duplicates
- json-output-contract-82ea5cef

---
title: "error-handling-refactor"
description: "Decision distilled by vir from a Claude Code session on 2026-05-28. The session was a security review of four changed files in the `vir` project, focused on a new `reconcile` command, a `r"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `daa71c94` · 2026-05-28 · classifier confidence 0.92
:::

## Summary

The session was a security review of four changed files in the `vir` project, focused on a new `reconcile` command, a `runAction` error-handling wrapper, updated DB query logic, and a `process.exit` → `process.exitCode` refactor. No security vulnerabilities were found. The review confirmed safe data flow through all new code paths.

## What Was Learned

**`runAction` wrapper pattern for Commander.js CLI actions**: Commander silently swallows non-zero exits when an async action handler rejects after a tool call. The fix is a single chokepoint wrapper that catches all errors and sets `process.exitCode = 1` instead of calling `process.exit(1)`. Using `process.exitCode` (not `process.exit`) lets the process drain stdout/stderr naturally before exiting, preventing truncated output.

**`process.exit(1)` → `process.exitCode = 1; return;` migration rule**: Any `process.exit(1)` inside an async handler should be converted to set the exit code and return explicitly. This ensures `finally` blocks (e.g., `db.close()`) run correctly on error paths — a behavioral improvement, not just a style change.

**`listReconcileTargets` SQL pattern**: Reconcile targets are sessions where `skipped = 0` AND `(content IS NULL OR content = '')` — covering both pre-0.7.2 silent failures (empty string from the Kie-200 bug) and errored sessions (NULL). The selector is purely SQL with no parameters, safe from injection.

**Separate DB tables for different content taxonomies**: Articles and topics live in their own tables (`articles`, `topics`) so their category taxonomies never pollute session listings, stats, or rewrite paths. Read methods guard against missing tables (the read-only MCP path skips migrations), using `hasArticlesTable()` / `hasTopicsTable()` guards before queries.

**ON CONFLICT upsert preserves existing content**: The `record()` upsert uses `COALESCE(excluded.content, sessions.content)` so re-processing a session with `content = NULL` does not overwrite previously distilled content. This is the correct pattern for idempotent pipeline writes.

**Embedding storage keyed by sessionId suffix**: Embeddings are stored and looked up via `path LIKE '%/<sessionId>.jsonl'` — a suffix-anchored LIKE query — because callers typically have the basename, not the full path.

## Context

- **Project**: vir
- **Category**: decision
- **Date**: 2026-05-28T03:00:23.061Z

## Related

- [exit-code-propagation-strategy](/vault/decisions/exit-code-propagation-strategy-1d4fa0af/)
- [mcp-tools-architecture](/vault/decisions/mcp-tools-architecture-953519c3/)
- [tool-output-bounding-strategy](/vault/decisions/tool-output-bounding-strategy-7eef1373/)
- [parser-fallback-robustness](/vault/decisions/parser-fallback-robustness-67301cf4/)
- json-output-contract

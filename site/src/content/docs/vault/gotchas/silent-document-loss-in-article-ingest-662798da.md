---
title: "silent-document-loss-in-article-ingest"
description: "Gotcha distilled by vir from a Claude Code session on 2026-07-31. Vir is a CLI tool that indexes Claude Code sessions into a structured knowledge base, retrieves them on demand for conte"
editUrl: false
---

:::note[Written by vir, not by a human]
**Gotcha** · session `662798da` · 2026-07-31 · classifier confidence 0.92
:::

## Summary

Vir is a CLI tool that indexes Claude Code sessions into a structured knowledge base, retrieves them on demand for context, and periodically distills them into timestamped summaries. The codebase is well-tested (431 tests pass), small (~14.5k LOC), and operates as a single-user information funnel from transcripts to embeddings to rich-text summaries—but contains three small architectural omissions that can silently lose documents during reingest, and three roadmap items marked unbuilt that are either complete or have hidden prerequisites.

## What Was Learned

- **The core pipeline is read-once**: articles and PDFs are tracked by content hash; once processed, `--full` cannot re-run them because the CLI never receives the options to pass down. This, combined with orphaned error handling, means a transient error during article ingest leaves no recovery path visible to the user.

- **Language migration is a partial-update hazard**: only the `sessions` table has a `PRAGMA table_info` migration system; `articles`, `pdfs`, and `topics` use `CREATE TABLE IF NOT EXISTS`, so schema changes appear on fresh installs and silently don't appear on existing ones. Adding an embedding model/dimension column (needed before the next backend switch) is currently blocked.

- **The roadmap understates completion by three items**: `vir status` can already report skip reasons (the method exists, no caller); the contradiction detector already runs and reports (only the graph persistence is missing); and graceful first-run with no Ollama is mostly there (only the "state what's missing" UX is new).

- **Dead code marks answered questions**: `clearError()` is unreachable in production due to a guard 12 lines above it. This method was written to rescue the 354 sessions that survive only in the database, making it a sign that ingest resilience was once considered, then either abandoned or forgotten.

- **The HTML artifact is derived from the markdown, never independently researched**: this keeps them from drifting apart, and both are self-contained (no external requests, fully printable, bilingual English/Serbian with persistent toggle, palette lifted from the CLI itself).

## Context

**project:** vir  
**category:** gotcha  
**date:** 2026-07-31T01:27:13.036Z

---

### Additional Durable References

- **Most actionable finding**: Generalize the `sessions` table's column migration system to per-table maps before shipping B2 (multi-backend support) in the roadmap. Roughly 15 lines; doing it after is a silent breakage for existing installs.

- **Dead code to decide on**: The two-guard pattern in `cli/reconcile.ts:249,261` needs clarification—whether the first guard is a misplaced duplicate or the second is a later addition. That determines whether to revive `db.clearError()` or delete it (both ~20 lines).

- **Convention to verify**: `db.countBySkipReason()` exists but is never called. Confirm whether B5 should wire it into `vir status`, or whether the method is exploratory and should stay dormant.

## Related

- [silent-failure class unfinished](/vault/gotchas/silent-failure-class-unfinished-7bfa9706/)
- [llm-wiki-ingestion](/vault/patterns/llm-wiki-ingestion-0393252f/)
- [parser-fallback-robustness](/vault/decisions/parser-fallback-robustness-67301cf4/)
- [search-result-filtering](/vault/gotchas/search-result-filtering-01e12b99/)
- [unguarded-json-parse-stdout](/vault/gotchas/unguarded-json-parse-stdout-acb1e000/)

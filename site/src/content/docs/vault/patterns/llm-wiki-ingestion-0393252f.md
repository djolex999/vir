---
title: "llm-wiki-ingestion"
description: "Pattern distilled by vir from a Claude Code session on 2026-05-24. This session implemented web article ingestion for the `vir` CLI tool (a Claude Code session knowledge distiller), addin"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `0393252f` · 2026-05-24 · classifier confidence 0.92
:::

## Summary

This session implemented web article ingestion for the `vir` CLI tool (a Claude Code session knowledge distiller), adding a parallel pipeline that processes Obsidian Web Clipper markdown into the same vault as session notes. All 11 tasks were completed with TDD, resulting in 20 new tests (+59→79 total), a clean TypeScript build, and a published `v0.6.0` npm release.

## What Was Learned

**Separate storage for divergent type domains.** When a new entity shares a pipeline shape but has a different taxonomy, give it its own table. Articles reuse the distill→write flow but their category set (`concept|technique|reference|opinion`) differs from sessions (`pattern|gotcha|decision|tool`). Overloading `sessions.category` would have broken 6 session-only consumers (`listDistilled`, `getStats`, `rewriteOne`, linter, summarizer, dedupe) that assume the session `Category` type.

**Stable slugs from identity, not content.** Idempotent note filenames must derive from a stable identity key, never the content hash. Sessions use `sessionId`; articles use `sha256(url ?? filePath).slice(0,8)`. If the slug tracked content, a re-clip/re-edit would mint a new file and orphan the old note instead of overwriting it.

**Read-only DB consumers must tolerate migration-created tables.** The MCP server opens `StateDb` with `{ readonly: true }` and skips migrations. A table added in a new version won't exist on a DB that was upgraded but never written to. Every article read method guards with a `sqlite_master` table-exists check and returns `[]/false` instead of throwing `"no such table"`. Verified against an old sessions-only DB.

**`git push --follow-tags` silently skips lightweight tags.** The commit pushed with no `[new tag]` line in output. Required an explicit `git push origin v0.6.0`.

**`npm view` shows stale data immediately after publish** due to CDN cache lag — `0.5.0` appeared as `latest` for several seconds after `0.6.0` published successfully. Not a failure; wait a few seconds and re-check.

## Context

- **Project:** vir
- **Category:** pattern
- **Date:** 2026-05-24T20:37:05.194Z

## Related

- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- [mirrored-sweep-for-new-entity-type](/vault/patterns/mirrored-sweep-for-new-entity-type-7415aa64/)
- [period-window summaries without retrieval pollution](/vault/decisions/period-window-summaries-without-retrieval-pollutio-3745b31b/)
- session-storage-hook-management
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)

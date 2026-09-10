---
title: "fetch-timeout-safety"
description: "Pattern distilled by vir from a Claude Code session on 2026-05-22. This session implemented `vir doctor`, a new diagnostic command that runs 10 sequential health checks on a vir installat"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `2140b459` · 2026-05-22 · classifier confidence 0.92
:::

## Summary

This session implemented `vir doctor`, a new diagnostic command that runs 10 sequential health checks on a vir installation and reports results in a three-state (ok/warn/fail) table. The feature was built, tested, committed, tagged, and published to npm as v0.3.3.

## What Was Learned

**Three-state diagnostic severity model:** Hard failures (exit 1) should be reserved for conditions that genuinely break the tool — bad config, invalid API key, unwritable vault, corrupt DB. Things that are merely "not yet configured" (daemon not installed, fresh DB, optional CLI absent) should be warnings (exit 0), or you'll cry wolf on a perfectly usable fresh install.

**Native `fetch` has no default timeout.** A stalled connection hangs indefinitely. The pattern used in `embedder.ts` — `AbortController` + a timeout constant — should be applied to every outbound `fetch` to an external service. `distiller.callKie()` currently lacks this and can wedge the daemon. The `vir doctor` API-key probe had to work around it with `Promise.race([call, timeout])`.

**`--follow-tags` only pushes annotated tags.** `git tag v0.3.3` creates a lightweight tag; `--follow-tags` silently skips it. Use `git tag -a v0.3.3 -m "..."` to create an annotated tag that `--follow-tags` will push automatically.

**All user-facing output in vir routes through `ui/display.ts`.** New commands should add helpers there (e.g. `statusRow()`) rather than calling `console.log` directly. This keeps the color palette and glyph set consistent across the CLI.

**New module structure:** `src/diagnostics/doctor.ts` — each check returns `{ status, label, detail? }`, the runner collects all results, then prints the table and sets the exit code based on the presence of any hard failures.

## Context

- **Project:** vir
- **Category:** pattern
- **Date:** 2026-05-22T23:33:18.090Z

## Related

- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- [llm-wiki-ingestion](/vault/patterns/llm-wiki-ingestion-0393252f/)
- test-driven-development-seams
- [exit-code-propagation-strategy](/vault/decisions/exit-code-propagation-strategy-1d4fa0af/)
- [period-window summaries without retrieval pollution](/vault/decisions/period-window-summaries-without-retrieval-pollutio-3745b31b/)

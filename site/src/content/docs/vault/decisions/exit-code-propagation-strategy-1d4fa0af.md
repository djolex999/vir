---
title: "exit-code-propagation-strategy"
description: "Decision distilled by vir from a Claude Code session on 2026-05-28. This session implemented the vir v0.8.0 reliability release, addressing three distinct failure modes: silent success whe"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `1d4fa0af` · 2026-05-28 · classifier confidence 0.92
:::

## Summary

This session implemented the vir v0.8.0 reliability release, addressing three distinct failure modes: silent success when CLI actions threw errors, a missing retry path for Kie's transient 404 responses, and no recovery mechanism for sessions that previously failed silently.

## What Was Learned

**Exit-code propagation via a single wrapper**

Commander silently swallows async action rejections after a tool call, causing `vir run` to report exit 0 on failed distillation. The fix is a single `runAction` wrapper that every `.action(...)` call routes through. It catches throws, logs via injectable `logError`, and sets `process.exitCode = 1` — not `process.exit(1)`, which truncates buffered stdout/stderr. In-handler validation failures follow the same pattern: `process.exitCode = 1; return;` instead of `exit(1)`. The injectable logger makes the wrapper unit-testable without intercepting `console.error` globally.

**Body shape takes precedence over status code when a provider reuses one code for two failure modes**

Kie returns 404 for both transient service hiccups (body: `{error: {type: "api_error"}}`) and genuine misroutes (no `api_error` envelope). The solution: parse the non-OK body as JSON in `callKie`, capture `error.type` as `HttpError.errorType`, and branch in `isRetryable` on `status === 404 && errorType === "api_error"`. Genuine 404s with no envelope remain hard failures. The pattern generalizes to any provider whose HTTP status codes are ambiguous.

**Recovery commands must be built on top of a fixed propagation layer, not before it**

The `vir reconcile` command retries sessions with `skipped=0` and `content IS NULL OR content = ''`. If reconcile had shipped before the exit-code fix, its retries could have silently failed again through the same bug. P0 (propagation) must pass all tests before P1 (recovery) is built on it.

**Recoverable vs. false-cost collateral is the key dry-run metric**

`--dry-run` reports two numbers: recoverable count (sessions to retry) and false-cost collateral (sessions with a cost record but null/empty content — money spent with nothing to show). On the real DB: 10 recoverable, $0.45 estimated retry, 0 collateral. Zero collateral means the financial leak was already plugged in 0.7.2; 0.8.0 fixed visibility, not money.

**Pure-function selectors enable unit tests without a real DB**

`selectReconcileTargets(rows)` mirrors `db.listReconcileTargets()` SQL as a pure function over a fixture array. The canonical 3-row fixture (null content, empty string content, normal content) covers all branches and runs in the test suite without spinning up SQLite.

## Context

- **Project:** vir
- **Category:** decision
- **Date:** 2026-05-28T02:45:59.851Z

## Related

- [mcp-tools-architecture](/vault/decisions/mcp-tools-architecture-953519c3/)
- [tool-output-bounding-strategy](/vault/decisions/tool-output-bounding-strategy-7eef1373/)
- [fetch-timeout-safety](/vault/patterns/fetch-timeout-safety-2140b459/)
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- [cost-recording-retry-safety](/vault/patterns/cost-recording-retry-safety-agent-ae/)

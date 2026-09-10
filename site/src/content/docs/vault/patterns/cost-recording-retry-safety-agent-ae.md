---
title: "cost-recording-retry-safety"
description: "Pattern distilled by vir from a Claude Code session on 2026-05-27. vir 0.7.0 adds a `src/cost/` module for per-call LLM cost tracking and a `vir cost` CLI command, alongside a toolCallFil"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `agent-ae` · 2026-05-27 · classifier confidence 0.92
:::

## Summary

vir 0.7.0 adds a `src/cost/` module for per-call LLM cost tracking and a `vir cost` CLI command, alongside a toolCallFilter enhancement that strips Skill-block results regardless of filter mode. Build is clean and all 110 tests pass.

## What Was Learned

**Cost tracking architecture**: A dedicated `src/cost/` module with three files — `pricing.ts` (model rate tables + override lookup), `log.ts` (append-only NDJSON cost log with best-effort error swallowing), and `report.ts` (aggregation: total, median, p90 per session). `recordCost` is called inside `callLLM` on the success path only, so retries via `withRateLimitRetry` never double-count.

**Retry-safe cost recording pattern**: Place `recordCost` after `await callProvider(...)` but before `return result`, inside `callLLM` itself. Wrap the entire `recordCost` body in `try/catch` so failures are silent. Since `withRateLimitRetry` wraps `callLLM`, a retried call re-enters `callLLM` fresh — `recordCost` only fires on the eventual success.

**Skill-strip always-on rule**: `stripSkillResults` runs *before* the `filterToolCalls mode === "off"` early-return. The off branch still propagates `skillResultsStripped`, recalculates `filteredTokens` from the post-strip text, and returns the correct shape. This ensures Skill block payloads (which can be large) are always stripped regardless of user filter config.

**Dry-run cost estimation**: A pre-loop dry-run applies the identical `scrub(filterToolCalls(...).filtered)` and `scrub(rawSummary)` transforms used in the real distill loop, then calls `computeCost` without any LLM calls. It intentionally over-estimates because it cannot know whether `cls.confidence <= 0.6` would skip the distill step; the UI shows a ±30% disclaimer. The `Distiller` client is constructed before the dry-run early-return (a minor wasted allocation).

**Provider-aware pricing**: `recordCost` passes `config.provider` into both log and pricing lookup. `DEFAULT_PRICING[provider]` is indexed by provider first, then model prefix. Partial config overrides (`config.pricing`) merge over defaults — only the fields specified are replaced, so a user can override just `inputPer1M` and inherit the table's `outputPer1M`.

**Model key lookup via bidirectional `startsWith`**: `findTableKey` matches when either the requested model name starts with a table key or a table key starts with the requested name — handles both `claude-sonnet-4` matching `claude-sonnet-4-20251022` and vice versa. Falls back to `undefined` → `computeCost` returns `0` silently for unknown models.

**`formatUsd` precision tiers**: Sub-cent amounts collapse to `$0.00` with two decimal places, so a tiered formatter is needed: `n < 0.01 → toFixed(4)`, `n < 1 → toFixed(3)`, else `toFixed(2)`.

**Doctor exemption**: `callLLM` called without a `cost` field causes `recordCost` to early-return — no cost is logged for diagnostic pings.

## Context

- **Project**: vir
- **Category**: pattern
- **Date**: 2026-05-27

## Related

- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- [fetch-timeout-safety](/vault/patterns/fetch-timeout-safety-2140b459/)
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- [tool-output-bounding-strategy](/vault/decisions/tool-output-bounding-strategy-7eef1373/)
- [mcp-tools-architecture](/vault/decisions/mcp-tools-architecture-953519c3/)

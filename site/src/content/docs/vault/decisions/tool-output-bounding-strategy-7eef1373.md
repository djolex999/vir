---
title: "tool-output-bounding-strategy"
description: "Decision distilled by vir from a Claude Code session on 2026-05-24. This session on the `vir` project (a Claude Code session distiller) uncovered that the spec's core premise was wrong — t"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `7eef1373` · 2026-05-24 · classifier confidence 0.92
:::

## Summary

This session on the `vir` project (a Claude Code session distiller) uncovered that the spec's core premise was wrong — the parser already discarded all tool output before distillation, making the planned filter dead code. Two user-guided course corrections produced a substantively different but more valuable feature: bounded tool context in distillation (v0.4.0), plus README restructuring (v0.4.1) and npm metadata cleanup (v0.4.2 staged).

## What Was Learned

**Spec premise must be verified against the code before building.** The spec assumed `parser.ts` emitted `[tool_use:…]` / `[tool_result:…]` blocks into session text. It did not — it discarded all 517 tool blocks per session. The "~70% cost savings" claim would have been false; the filter would have been a no-op.

**The real token bloat is in `tool_use` inputs, not `tool_result` outputs.** On a real 517-call session, `tool_use` inputs held ~148k tokens (Write/Edit carrying full file bodies) vs ~40k in `tool_result` content. Filtering only `tool_result` (per spec) reduced 217k → 213k tokens (~2%). Adding `tool_use` payload truncation (keeping `file_path`, `command`, `description` intact, truncating `content`/`new_string`/`old_string` past thresholds) achieved 217k → 95k tokens (~56% reduction) while preserving tool intent for the distiller.

**The block grammar should live in one module, owned by the filter.** `toolCallFilter.ts` owns both `renderToolUse`/`renderToolResult` (emitters) and the parse regex, so the parser and filter cannot drift. The parser imports and calls the renderers.

**Prose fields must stay clean of tool blocks.** `assistantText`, `userText`, and `rawSummary` feed classification (Haiku) and the heuristic filter (`filter.ts` signal-word regex). Tool blocks must only appear in the new `transcriptText` field, which feeds distillation (Sonnet) after filtering.

**Annotated tags (`git tag -a`) work with `--follow-tags`; lightweight tags do not.** `git push --follow-tags` silently skips lightweight tags. Use `git tag -a v0.x.y -m "v0.x.y"` to get the one-shot push behavior.

**Never document a feature that doesn't exist in code, even if the spec says to.** The spec asked for a `vir review` active-learning command (with ✓ in the comparison table as a differentiator). Grep confirmed it didn't exist. It was moved to Roadmap as a `- [ ]` planned item rather than presented as current.

**Zod defaults handle backward-compatible config field additions.** Adding `filterToolCalls` with `.default("moderate")` means existing config files without the field parse correctly. The init wizard preserves the existing value via `existing?.filterToolCalls` in the `ConfigSchema.safeParse` call.

## Context

- **Project:** vir
- **Category:** decision
- **Date:** 2026-05-24T19:07:28.447Z

## Related

- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- v1-architecture-and-sequencing
- [llm-wiki-ingestion](/vault/patterns/llm-wiki-ingestion-0393252f/)
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- [fetch-timeout-safety](/vault/patterns/fetch-timeout-safety-2140b459/)

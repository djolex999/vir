---
title: "skill-result-stripping"
description: "Pattern distilled by vir from a Claude Code session on 2026-05-27. Added `skillResultsStripped` tracking and Skill tool result stripping to `toolCallFilter.ts` in the `vir` project. Skill"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `agent-a0` · 2026-05-27 · classifier confidence 0.92
:::

## Summary

Added `skillResultsStripped` tracking and Skill tool result stripping to `toolCallFilter.ts` in the `vir` project. Skill tool results above a character threshold are replaced with a compact placeholder, running unconditionally (even in `"off"` mode) before the main tool-call filter logic.

## What Was Learned

**Real Skill tool_use input shape:** The input object always uses the key `"skill"`, not `"name"` or `"command"`. Values use colon-namespaced paths like `"superpowers:brainstorming"` or bare names like `"pre-ship-audit"`.

```json
{ "skill": "superpowers:test-driven-development" }
```

**FilterResult interface is additive-safe:** Callers like `run.ts` only destructure the fields they need (`toolCallsStripped`, `tokensSaved`), so adding new fields to `FilterResult` is non-breaking without touching callers.

**Skill stripping runs before the mode gate:** The `stripSkillResults()` pass runs unconditionally regardless of `filterToolCalls` mode. The pre-existing `"off" returns input unchanged` test still passes because its fixture contains no Skill blocks — the test's intent was "no tool filtering," not "byte-identical output when Skill blocks exist."

**Stripped placeholder format:** Matches the project's existing one-liner pattern for stripped results:
```
[tool_result: Skill] [Skill <name> loaded]
```
No closing fence tag — consistent with how large Bash output is stripped.

**Name extraction fallback order:** `input.skill` → `input.command` → `input.name` → literal `"skill"`. In practice `input.skill` is always present in real transcripts.

## Context

- **Project:** vir
- **Category:** pattern
- **Date:** 2026-05-27T01:39:20.408Z
- **Files changed:** `src/pipeline/toolCallFilter.ts`, `src/pipeline/toolCallFilter.test.ts`

## Related

- [tool-output-bounding-strategy](/vault/decisions/tool-output-bounding-strategy-7eef1373/)
- modular-extractors-with-graceful-degradation
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- [fetch-timeout-safety](/vault/patterns/fetch-timeout-safety-2140b459/)
- v1-architecture-and-sequencing

---
title: "filter-before-classify-paid-boundary"
description: "Pattern distilled by vir from a Claude Code session on 2026-07-30. This session built a feature-complete project and transcript filtering system for vir using strict test-driven developme"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `990e18b0` · 2026-07-30 · classifier confidence 0.92
:::

## Summary

This session built a feature-complete project and transcript filtering system for vir using strict test-driven development. All work shipped with 431 passing tests and zero type errors. The feature gates sessions before costly LLM calls, making project triage and agent-transcript filtering load-bearing architectural decisions rather than UI conveniences.

## What Was Learned

**Session filtering is a three-layer architecture:**
1. **Structural detection at scan time** (zero I/O) — path patterns for workflows/sidechains, entrypoint prefix for SDK agents
2. **Content-level backstops at parse time** — `isSidechain` and `entrypoint` fields in JSONL persist after the parse, catching layout changes or truncated scans before any classify call
3. **Database enforcement** — reversible skip reasons (config-gated) never overwrite already-distilled rows; decisions are forward-looking only

**The real population differs sharply from assumed shapes:** Workflow/sidechain/agent transcripts comprise 136/115/67 of your 233 top-level files (88% pre-filter). Machine review agents dominate by entrypoint (`promptSource` is contaminated on desktop-launched sessions; `entrypoint` is the pure signal). Default behavior must over-capture (30-day pruning deadline) rather than silently exclude. Blind sampling of below-threshold sessions (0 of 20 kept-worthy) confirms the scorer works; its problem is the input population, not the threshold.

**Known edge cases:** Project dir named literally `subagents`, transcripts with fields in unexpected positions, corrupted/truncated JSONL files, and the C23 autonomous-run ("1 SDK user line → 22 nested turns by injection") all have explicit regression tests. The `projects.ts` pure functions handle all shapes; the `run.ts` gates operate under full failure assumption — a `getByPath` miss becomes a `skipReason: null` row, never a silent skip.

## Context

**Project:** vir (LLM wiki CLI for Obsidian, Claude Code)
**Category:** pattern
**Date:** 2026-07-30T17:28:50.095Z (continuing previous session)

**Deliverables (cumulative across both sessions):**
- Layers 1–3: `decodeProjectName` (longest-match), config `projects` map (three states), and `decideProject` logic (2/10 complete)
- Layers 4–6: `classifyTranscript` (structural) and `sniffAgentEntrypoint` (launch signature) (5/10 complete)
- Layers 7–10: Run gates, spy tests (Distiller.run zero calls when filtered), DB schema migrations, parser backstops (10/10 complete)
- Layers 11–15: Init wizard (inverted default, multi-select counts, agent-transcript question), `vir projects` table (include/exclude subcommands), doctor check, dry-run preview (15/15 complete)
- Utilities: Config schema evolutions (4 keys added), DB query helpers, cost estimation, report builders

**Verified against real ~/.claude/projects (233 files, 7 projects, 8 months history):** The filtered and annotated table now shows honest pending cost ($5.70 vs $15.60 before). All 67 SDK agents correctly identified by entrypoint sniff; no false positives or escapes on this population.

## Related

- [cost-recording-retry-safety](/vault/patterns/cost-recording-retry-safety-agent-ae/)
- [tool-output-bounding-strategy](/vault/decisions/tool-output-bounding-strategy-7eef1373/)
- [skill-result-stripping](/vault/patterns/skill-result-stripping-agent-a0/)
- [fetch-timeout-safety](/vault/patterns/fetch-timeout-safety-2140b459/)
- article-embeddings-excluded-from-sweep

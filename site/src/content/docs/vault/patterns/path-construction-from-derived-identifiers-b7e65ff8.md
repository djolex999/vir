---
title: "path-construction-from-derived-identifiers"
description: "Pattern distilled by vir from a Claude Code session on 2026-06-26. The session reviewed a TypeScript pipeline for summarizing Obsidian vault notes by time period (week/month). Key changes"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `b7e65ff8` · 2026-06-26 · classifier confidence 0.92
:::

## Summary

The session reviewed a TypeScript pipeline for summarizing Obsidian vault notes by time period (week/month). Key changes include a new `periodSummary.ts` orchestrator, refactored shared prompt logic in `summarizer.ts`, SKIP_DIRS exclusion to prevent summary artifacts from being indexed, and CLI additions for `--week` and `--month` flags. Security analysis found no vulnerabilities: file paths are constructed from validated date arithmetic, the model allowlist fails closed, and LLM prompts receive only trusted vault content in a single-tenant context.

## What Was Learned

- **Path construction is safe via slug generation**: Offsets (`--week [n]`, `--month [n]`) are parsed as integers and bounds-checked before feeding into `periodSlug()`, which produces well-formed identifiers like `week-2026-W26` or `month-2026-06`. No attacker-controlled strings reach the filesystem path.
- **Model selection uses a closed allowlist**: The CLI accepts only `["haiku", "sonnet"]` and validates before passing to `normalizeModelName()` and `resolveModelShorthand()`. Unknown values are rejected.
- **SKIP_DIRS correctly isolates derived artifacts**: Adding `summaries/` to the basename-match exclusion list prevents summary outputs from being re-indexed and retrieved as source notes, maintaining TF-IDF integrity.
- **Trust model is single-tenant**: The tool operates over a user's own vault without multi-principal boundaries, so LLM prompts receiving note content (`r.topic`, `r.content`) pose no privilege violation.
- **Cost attribution uses only synthetic identifiers**: Logging includes `session` (slug), `project` ("summaries"), and `stage` ("summarize-period"), with no PII or secrets exposed to observability.

## Context

**Project:** vir  
**Category:** pattern  
**Date:** 2026-06-26T01:58:22.344Z  
**Files analyzed:** `periodSummary.ts`, `summarizer.ts`, `retriever.ts`, `cli.ts`, `distiller.ts`

## Related

- [local-CLI-path-safety](/vault/patterns/local-cli-path-safety-b34f803d/)
- [embedding-pipeline-backfill-parity](/vault/patterns/embedding-pipeline-backfill-parity-9afb0664/)
- [sanitization-alone-insufficient-for-path-safety](/vault/gotchas/sanitization-alone-insufficient-for-path-safety-3a425d11/)
- [llm-wiki-ingestion](/vault/patterns/llm-wiki-ingestion-0393252f/)
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)

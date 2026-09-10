---
title: "local-CLI-path-safety"
description: "Pattern distilled by vir from a Claude Code session on 2026-06-26. A Claude Code session reviewed security implications of new period summarization features (`--week` and `--month` flags)"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `b34f803d` · 2026-06-26 · classifier confidence 0.92
:::

## Summary

A Claude Code session reviewed security implications of new period summarization features (`--week` and `--month` flags) added to a local CLI tool. The analysis traced data flows from user input through file operations and LLM calls, confirming that all path components are internally generated, CLI inputs are validated, and no new attack surfaces were introduced.

## What Was Learned

**Input validation patterns:**
- Numeric offsets (`--week [n]`, `--month [n]`) validated with `Number.isInteger(offset) && offset >= 0` before use
- Model selection (`--model`) enforced against allowlist `["haiku", "sonnet"]`
- Both patterns prevent injection/traversal at the CLI boundary

**Safe path construction for generated outputs:**
- Output filenames derived entirely from date math (`Date.UTC()`) and literal template slugs (`week-YYYY-Www`, `month-YYYY-MM`)
- No user-controlled strings enter path components; slug generation is deterministic and internal
- Both project and period summary paths write under the same vault root with equivalent validation

**Data flow isolation:**
- Note content reaches LLM prompts but originates from user's own local sessions—not a new exfiltration path
- Frontmatter (period kind, date, counts) written before LLM output, preventing YAML injection
- Cost tracking uses internal identifiers; no attacker-controlled data reaches accounting systems

**Hardening through exclusion:**
- TF-IDF walk skips `summaries` directory to prevent recursive inclusion of derived summaries in vector search
- Exclusion list uses literal directory names, not user input

## Context

**Project:** vir  
**Category:** pattern  
**Date:** 2026-06-26T01:58:44.284Z

Files reviewed: `periodSummary.ts` (orchestration), `retriever.ts` (search), `summarizer.ts` (LLM), `cli.ts` (entry point)

## Related

- [sanitization-alone-insufficient-for-path-safety](/vault/gotchas/sanitization-alone-insufficient-for-path-safety-3a425d11/)
- [fetch-timeout-safety](/vault/patterns/fetch-timeout-safety-2140b459/)
- [embedding-pipeline-backfill-parity](/vault/patterns/embedding-pipeline-backfill-parity-9afb0664/)
- [cost-recording-retry-safety](/vault/patterns/cost-recording-retry-safety-agent-ae/)
- [timeout-abort-safety](/vault/patterns/timeout-abort-safety-cb814268/)

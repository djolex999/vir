---
title: "readme-restructure-badges"
description: "Decision distilled by vir from a Claude Code session on 2026-05-22. This session completed the vir v0.3.4 docs release: restructuring the README, creating CONTRIBUTING.md and demo.tape, it"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `b71e2ae1` · 2026-05-22 · classifier confidence 0.92
:::

## Summary

This session completed the vir v0.3.4 docs release: restructuring the README, creating CONTRIBUTING.md and demo.tape, iterating extensively on a vhs-recorded demo GIF, and shipping via git push + npm publish. The bulk of the work was debugging demo.tape issues (Ctrl+L not working, LLM-backed commands too slow, output overflowing the terminal window) and resolving an npm packaging question about keeping the GIF off the tarball.

## What Was Learned

**vhs demo.tape gotchas (several hit in sequence):**
- `Ctrl+L` gets typed literally as `^L` into the next command when the shell's readline doesn't bind it — use `type "clear"` + `Enter` instead
- Output taller than the window always scrolls to the bottom; there's no way to show the "top" of long output. Commands producing 60–80 lines (like `vir status` with a full vault) will always land on the last line. Choose concise commands or accept losing the top
- LLM-backed commands (`vir query`) are ~30s round-trips → 30s of spinner dead-air in the GIF + a large file. `Wait+Screen` syntax for blocking on output appearance exists but can be fragile. Better to omit such commands entirely from a README hero GIF
- Always render in your real shell, not a headless session — the installed `vir` binary in `vhs`'s environment may be stale (predated `vir doctor`)

**npm `files` allowlist vs `.npmignore`:**
- To ship an asset on GitHub but not in the npm tarball, narrow the `files` array to specific file paths rather than a directory: `"assets"` → `"assets/vir_whirlpool_logo.svg"`. This silently excludes sibling files (like a large demo GIF) without needing `.npmignore`. The `files`-vs-`.npmignore` precedence is ambiguous; an explicit allowlist is unambiguous. Confirm with `npm pack --dry-run` before publishing.

**`--follow-tags` only pushes annotated tags:**
- `git tag v0.3.4` creates a lightweight tag; `git push --follow-tags` won't push it. Either use `git tag -a v0.3.4 -m "..."` for an annotated tag, or push explicitly with `git push origin v0.3.4`.

**README spec interpretation:**
- A spec listing changed/new sections should be read as a change-list, not a delete-list. Sections omitted from the spec TOC (Install, Prerequisites, real-data proof) were preserved rather than dropped.

## Context

- **Project:** vir
- **Category:** decision
- **Date:** 2026-05-22T23:48:31.333Z

## Related

- [mcp-tools-architecture](/vault/decisions/mcp-tools-architecture-953519c3/)
- [tool-output-bounding-strategy](/vault/decisions/tool-output-bounding-strategy-7eef1373/)
- security-audit-patch
- [llm-wiki-ingestion](/vault/patterns/llm-wiki-ingestion-0393252f/)
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)

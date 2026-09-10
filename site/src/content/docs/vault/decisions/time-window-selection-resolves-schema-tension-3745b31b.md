---
title: "time-window selection resolves schema tension"
description: "Decision distilled by vir from a Claude Code session on 2026-06-26. This session shipped three vir-cli releases (0.10.0 period summaries, 0.11.0 PDF ingestion, 0.11.1 flags fix) and one pl"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `3745b31b` · 2026-06-26 · classifier confidence 0.92
:::

## Summary

This session shipped three vir-cli releases (0.10.0 period summaries, 0.11.0 PDF ingestion, 0.11.1 flags fix) and one plugin release (vir-obsidian 0.2.0 PDF parity), then synced all eight canonical docs across both repos. Two provider outages (Kie down) forced an Anthropic detour for the live PDF distill verify.

## What Was Learned

**PDF ingestion architecture (vir-cli 0.11.0):** PDFs are the third input source, a deliberate clone of the article skeleton. Key deviation: `scanPdfs` hashes cheaply first and only parses new files (PDF extraction via `unpdf` is expensive; articles parsed the whole dir up front). The read path (`getPdfEmbeddings`) and the sweep/backfill (`selectPdfEmbeddingTargets`, `storePdfEmbedding`) ship together to avoid reopening the NULL-embedding blind spot that bit 0.8.2/0.8.3.

**`--only` shortcuts must replicate the shared tail:** `--pdfs-only` and `--articles-only` both early-returned before the main path's `--dry-run` guard and end-of-run embedding sweep. Result: `--pdfs-only --dry-run` fired real paid calls instead of previewing, and inline-embed misses didn't self-heal until the next full `vir run`. Fixed in 0.11.1: each shortcut branch now gates on `opts.dryRun` (using the shared `dryRunDocPhase` helper) and calls `runEmbeddingSweep` before returning.

**Manual-only posture for high-cost infrequent sources:** PDF (and article) ingestion is expensive per item with no `>20`-style cost gate. Both `pdfsDir` and `articlesDir` are kept *absent* from config (not set to a sentinel) so the 4h daemon never polls them unattended. To ingest: set the dir, `--dry-run` to preview, run, optionally unset. "Off" = remove the optional key.

**Auto-confirming a paid command inside an unrelated task:** A ~415-session backlog distill fired mid-session during plugin work — a large unintended charge from a side-effecting command run without a fresh, explicit cost confirmation. A paid variable-cost command must re-confirm at the point of spend, not inherit a blanket "yes" from an adjacent task.

**Plugin category parity requires a multi-step sweep:** Adding a CLI category to the plugin is not one line. Source-typed notes (topic/article/pdf) classify by their `type` discriminator, not `category` (which is absent or a sub-taxonomy like `paper`/`concept` that `isVirCategory` rejects). Missed: a pdf's date lives in `distilled_at`, not `date:` — dateless notes sort to 0 and get cut by `recentCount`. Also: the wire carries no title; `titleFromFrontmatter` (`source_title`/`title`/`topic`) is needed or every note renders its filename slug. The 0.2.0 work also revealed articles had the same latent classification bug (no article notes existed to surface it).

**`unpdf` vs `pdf-parse`:** Chose `unpdf` (unjs) — ESM-native, actively maintained, bundles pdf.js with no native deps. The `npm audit` `hono` advisory came from the pre-existing `@modelcontextprotocol/sdk` dep, not `unpdf`.

**`DistilledRow` date ambiguity:** The spec said "window over distill date, not session date — use what `listDistilled()` exposes." These clauses conflict: the note's `date:` frontmatter is `startedAt` (session date), `listDistilled()` exposes only `startedAt`, and the true distill timestamp (`processed_at`) isn't exposed. Windowed over `startedAt` — matches the date printed on each note, needs no schema change. One-line flip in `selectNotesInPeriod` if `processed_at` windowing is preferred.

## Context

- project: vir
- category: decision
- date: 2026-06-26T01:35:25.554Z

## Related

- [tool-output-bounding-strategy](/vault/decisions/tool-output-bounding-strategy-7eef1373/)
- [mcp-tools-architecture](/vault/decisions/mcp-tools-architecture-953519c3/)
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- [llm-wiki-ingestion](/vault/patterns/llm-wiki-ingestion-0393252f/)
- [fetch-timeout-safety](/vault/patterns/fetch-timeout-safety-2140b459/)

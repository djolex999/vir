---
title: "active-learning-review-loop"
description: "Pattern distilled by vir from a Claude Code session on 2026-05-24. Implemented `vir review` (active learning command) for the vir project, bumped to v0.5.0, and shipped to npm. The featur"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `f41385ca` · 2026-05-24 · classifier confidence 0.95
:::

## Summary

Implemented `vir review` (active learning command) for the vir project, bumped to v0.5.0, and shipped to npm. The feature lets users walk through auto-distilled notes and approve, edit, or reject each one; verified notes get a retrieval boost in both the embedding and TF-IDF search paths.

## What Was Learned

**Review verdicts must be preserved on every write path, not just obvious ones.** When humans annotate files that a pipeline regenerates, the generator must carry those annotations over unconditionally. `writer.write()` rebuilds frontmatter from scratch, so both `--rewrite-only` and `--full` re-distill would silently wipe `verified`/`reviewed_at`/`rejected_at` frontmatter fields. The fix is a `preservedReviewFields()` helper that reads the existing file before every write and re-injects user-authored keys. The rule: audit every write path when humans can edit a file the system owns.

**Flat additive boosts interact differently across score scales.** A constant `+0.2` boost to verified notes only nudges cosine similarity (bounded 0–1) but dominates TF-IDF scores (~0.05), effectively making it "verified-first among any lexical match" on that path. This is a defensible behavior, but it's a much stronger effect than on the embedding path from the same constant. Prefer proportional multipliers when the goal is consistent ranking strength across retrieval methods.

**Export internal helpers to make interactive CLI logic testable without a TTY.** `parseFrontmatter`, `setFrontmatter`, `approveNote`, `rejectNote`, and `collectNotes` were all exported as pure functions so 8 unit tests could cover the review logic without spawning a process or faking stdin.

**`git push --follow-tags` only pushes annotated tags.** A lightweight `git tag v0.x.0` gets silently skipped. Always use `git tag -a v0.x.0 -m "..."` for release tags.

## Context

- **Project:** vir
- **Category:** pattern
- **Date:** 2026-05-24T20:09:51.011Z

## Related

- [mmr-reranking-integration](/vault/patterns/mmr-reranking-integration-573d0e9f/)
- [llm-wiki-ingestion](/vault/patterns/llm-wiki-ingestion-0393252f/)
- [readme-restructure-badges](/vault/decisions/readme-restructure-badges-b71e2ae1/)
- [tool-output-bounding-strategy](/vault/decisions/tool-output-bounding-strategy-7eef1373/)
- [cost-recording-retry-safety](/vault/patterns/cost-recording-retry-safety-agent-ae/)

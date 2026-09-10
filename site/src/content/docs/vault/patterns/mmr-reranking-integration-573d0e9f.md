---
title: "mmr-reranking-integration"
description: "Pattern distilled by vir from a Claude Code session on 2026-05-24. Implemented MMR (Maximum Marginal Relevance) reranking for semantic search in the `vir` project, shipping as `v0.6.1`. T"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `573d0e9f` · 2026-05-24 · classifier confidence 0.92
:::

## Summary

Implemented MMR (Maximum Marginal Relevance) reranking for semantic search in the `vir` project, shipping as `v0.6.1`. The feature diversifies embedding-based query results by balancing relevance against similarity to already-selected results. A secondary fix inverted the user-facing config parameter semantics to be more intuitive while keeping the algorithm's internal conventions standard.

## What Was Learned

**MMR reranking algorithm (`mmrRerank`):** Greedy iterative selection that scores remaining candidates as `λ * relevance - (1-λ) * max_similarity_to_selected`. The first pick is always the highest-relevance item (pure relevance anchor). λ=1.0 degenerates to a plain relevance sort; λ=0.0 maximizes diversity after the first pick. Complexity is O(N × topK) over a capped pool, making it cheap for in-memory use.

**Invert product-facing knobs at the boundary; keep the algorithm canonical.** When the user-facing parameter reads opposite to an algorithm's standard convention (here: `retrievalDiversity=1.0` means "pure diversity", but MMR's λ=1.0 means "pure relevance"), don't redefine the algorithm's parameter. Convert at the call site: `mmrRerank(candidates, topK, 1 - cfg.retrievalDiversity)`. Then choose the default so the mapped value preserves prior behavior (`retrievalDiversity: 0.3` → `λ=0.7`, same as before). The rename ships as a behavioral no-op for existing users.

**`ScoredCandidate` interface pattern:** When piping through a two-stage pipeline (score → rerank → reconstruct hit), carry `{ docId, score, embedding, content }` as an intermediate type. The verified boost is folded into `score` before reranking so MMR treats it naturally as the relevance signal.

**`git push --follow-tags` only pushes annotated tags.** `git tag v0.x.y` creates a lightweight tag that `--follow-tags` silently skips. Use `git tag -a v0.x.y -m "v0.x.y"` for releases. Catching this requires `git ls-remote --tags origin` after push.

**Config object literals in tests break on every new required field.** Adding `retrievalDiversity` to the Zod schema required updating `sampleConfig()` helpers in `config.test.ts` and `writer.test.ts`. Pattern: search `claudeProjectsDir:` (a required field unlikely to be optional) to find all literal `Config` objects needing updates.

**No `prepublishOnly` hook means `dist/` must be built manually before `npm publish`.** There's no safety net — publishing without a fresh build ships stale compiled output.

## Context

- **Project:** vir
- **Category:** pattern
- **Date:** 2026-05-24T21:16:47.233Z

## Related

- [llm-wiki-ingestion](/vault/patterns/llm-wiki-ingestion-0393252f/)
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- [fetch-timeout-safety](/vault/patterns/fetch-timeout-safety-2140b459/)
- parallel-data-fetching
- [active-learning-review-loop](/vault/patterns/active-learning-review-loop-f41385ca/)

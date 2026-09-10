---
title: "embedding-model-tradeoffs-bundled-vs-remote"
description: "Decision distilled by vir from a Claude Code session on 2026-07-31. This session evolved from a README rewrite through a multi-gate TDD implementation adding optional, provider-agnostic em"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `2608f39e` · 2026-07-31 · classifier confidence 0.92
:::

## Summary
This session evolved from a README rewrite through a multi-gate TDD implementation adding optional, provider-agnostic embeddings to `vir`, culminating in a v0.15.0 release. Key durable outcomes: a reusable pattern for evaluating/replacing embedding backends without vendor lock-in, and hard-won calibration data for bge-small vs nomic thresholds on real vault data.

## What Was Learned
- **Embedding provider abstraction pattern**: introduce an `EmbeddingProvider` interface (name, modelName, dimensions, maxInputChars, embedDoc/embedQuery, provenance) before adding a second backend. Resolution order should be configured > detected (e.g. Ollama) > installed local fallback > none, with graceful fallthrough (never block, never error) and a once-per-run notice rather than an init-time question.
- **Embedding provenance must be stored per-vector** (model + dim columns) because cosine similarity across different embedding models is meaningless. Retrieval must partition/refuse cross-model comparisons rather than silently comparing incompatible vectors; migrations should backfill legacy rows to the one historical model.
- **Similarity thresholds are model-specific properties, not global constants.** Calibration should be done empirically (quantile-matching real query/doc and doc/doc cosine distributions) rather than guessed — guesses were meaningfully wrong in this session (initial bge guesses of 0.5/0.7 vs measured 0.35/0.6).
- **fastembed + bge-small-en-v1.5** is a viable Ollama-free local embedding option: no native build step (prebuilt binaries), ~230MB install, fast cold start (~188ms cached), and retrieval quality comparable to nomic-embed-text on real data. Should be installed lazily/on-demand (e.g. `vir embed --setup`) rather than as a hard/optional npm dependency, to keep package size small.
- **TF-IDF idf formula `log(N/df)` breaks on single-document corpora** (df===N yields idf=0), making the first note in a fresh vault unfindable. Fix: smooth to `log(1 + N/df)`, which converges to the original for large corpora but never returns zero.
- **Ollama's context limit (2048 tokens for nomic-embed-text)** causes silent embedding failures for large notes (>~8k chars) that get swallowed to NULL and retried forever; needed typed error kinds (context-limit/http/network) and truncation-with-retry logic.
- Before large refactors touching retrieval/embedding, use ephemeral scratch experiments (outside the repo, read-only against production DB/vault) to empirically compare models before committing to an approach.
- Release workflow: bump version, update CHANGELOG, rebuild dist from a clean tree, verify `git status` is clean vs HEAD (proving dist matches committed source), then commit, annotated-tag with `--follow-tags`, and publish (letting `prepublishOnly` rebuild+retest as a second verification).

## Context (project: vir, category: decision, date: 2026-07-31T12:59:17.019Z)
Repository: `~/projects/vir` (npm package `@djolex999/vir-cli`). This session spanned README accuracy fixes, an embedding-model comparison experiment, and a full TDD implementation of pluggable embedding providers, released as v0.15.0. Related repo: `vir-obsidian` (Obsidian plugin consuming vir's `--json` contracts), already shipped separately at v0.2.1.

## Related

- [mirrored-sweep-for-new-entity-type](/vault/patterns/mirrored-sweep-for-new-entity-type-7415aa64/)
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- ollama-probe-null-breaks-inference
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- article-embeddings-excluded-from-sweep

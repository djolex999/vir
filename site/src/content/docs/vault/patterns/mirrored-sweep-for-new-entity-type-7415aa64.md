---
title: "mirrored-sweep-for-new-entity-type"
description: "Pattern distilled by vir from a Claude Code session on 2026-06-26. Three sequenced Claude Code sessions delivered vir 0.9.0–0.9.2: article embedding self-heal sweep (closed a 0.6.0 write-"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `7415aa64` · 2026-06-26 · classifier confidence 0.92
:::

## Summary

Three sequenced Claude Code sessions delivered vir 0.9.0–0.9.2: article embedding self-heal sweep (closed a 0.6.0 write-time-only blind spot), multi-theme dilution labeling via `themes:` frontmatter, MCP exposure of `vir_compose` as a read-only cached-or-pointer tool, and Kie high-tier pricing (`kieTopUpTier` config). All three releases shipped annotated tags, all tests pass (184→208), and live verification confirmed the provider contract and embedding paths work.

## What Was Learned

- **A new entity in the embedding pool needs sweep coverage in the same change.** Sessions, topics, and articles are now all healed end-to-end — read path + back-fill sweep + manual `vir embed`. Shipping the read path alone (as happened with articles in 0.6.0) reopens the NULL-embedding blind spot.
- **Classify-JSON drives the note title and metadata, not a distill marker.** The plan's distill-TITLE: premise was wrong; `classification.topic` comes from the Haiku classify step as JSON. Themes and single-lesson titling live there, not in the markdown body.
- **Read-only facades mean zero side effects—never spend tokens or write files.** `vir_compose` on MCP stays cached-or-pointer (mirrors `vir_project_summary`), not returns-synthesis, because the server is documented read-only and `composeFromSources` is an inseparable LLM+write.
- **Verify the remote before assuming a tag is missing.** vir-obsidian's 0.1.2 was already published (lightweight), not "never tagged"—`git ls-remote --tags` is ground truth.
- **Mocked-LLM test suites prove logic, never the provider contract.** The 147 green tests all passed despite a bug (empty topic notes on real Kie calls) because mocks can't catch provider-side regressions. Always run at least one real call for external provider features.

## Context

**project:** vir  
**category:** pattern  
**date:** 2026-06-26T01:00:00.000Z

Three sessions (A: 0.9.0, B: 0.9.1, C: 0.9.2), each TDD RED→GREEN, each through build+test+commit+annotated-tag+push+npm-publish. Live verification post-ship: synthesis and topic-via-embedding confirmed working; article path un-verifiable due to config typo (`articlesDir: "y"`); themes awaits next natural `vir run`.

## Related

- [llm-wiki-ingestion](/vault/patterns/llm-wiki-ingestion-0393252f/)
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- [active-learning-review-loop](/vault/patterns/active-learning-review-loop-f41385ca/)
- [mcp-tools-architecture](/vault/decisions/mcp-tools-architecture-953519c3/)
- [mmr-reranking-integration](/vault/patterns/mmr-reranking-integration-573d0e9f/)

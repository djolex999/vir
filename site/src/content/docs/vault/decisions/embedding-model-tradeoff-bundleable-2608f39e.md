---
title: "embedding-model-tradeoff-bundleable"
description: "Decision distilled by vir from a Claude Code session on 2026-07-31. This session shipped vir 0.15.0: a provider-agnostic embedding architecture (Ollama + on-demand local fastembed/bge-smal"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `2608f39e` · 2026-07-31 · classifier confidence 0.92
:::

## Summary
This session shipped vir 0.15.0: a provider-agnostic embedding architecture (Ollama + on-demand local fastembed/bge-small provider) with model provenance tracking, per-model similarity thresholds, and a TF-IDF idf-smoothing fix, all built via strict TDD gates. It also included a README accuracy audit against actual code/tests, and an empirical embedding-model comparison experiment that grounded the design decisions in real data rather than assumptions.

## What Was Learned

- **Calibrate model-dependent constants from real distributions, not intuition.** "bge runs hotter" was true for query-doc cosine (+0.15) but false for doc-doc similarity (nearly identical to nomic). A guessed threshold based on the wrong assumption would have broken the Related-notes feature. Always quantile-match real distributions (tractable even at tens of thousands of pairs) before shipping any model-dependent numeric constant.
- **Heavy optional runtime dependencies should use their own npm prefix (`npm install --prefix ~/.vir/embedder`) + `createRequire`/dynamic import, not `optionalDependencies`.** `optionalDependencies` still downloads for every install; an explicit on-demand install keeps the base package small (212 kB) and makes the disk/time cost a consented step, not a silent one.
- **Smoke-test the N=1 / edge-of-scale case of ranking formulas.** Plain TF-IDF idf (`log(N/df)`) is zero for every term when the corpus has one document — a brand-new vault's first note would be unfindable. Fixed via smoothing (`log(1 + N/df)`), verified via before/after ranking diffs on the real corpus to bound blast radius.
- **A model's *served* limit can differ from its *native* limit.** Ollama served nomic-embed-text at num_ctx 2048 even though the model supports 8192, causing hard 500s on inputs >~8k chars. Fix: truncate proactively at the served limit, retry with reactive halving if still too large, and record truncation events — never silently drop text.
- **Best-effort error swallowing needs typed error kinds.** A bare `catch { return null }` around embedding calls made it impossible to distinguish "input too large" from "daemon down" in logs; adding `EmbedderError.kind` (context-limit | http | network) restored diagnosability without changing the best-effort contract.
- **Cross-model vector comparison is silent corruption if untracked.** Every embedding needs provenance (model name + dimension) so retrieval can refuse to compare incompatible vector spaces; migrations backfilling legacy data must assume the historical single embedder.
- **Before touching a README's factual claims (roadmap, tool counts, versions, test counts), verify each against the actual codebase/tests** — several claims in vir's README were stale (test count, MCP tool count, model defaults, shipped-vs-planned features).
- **TDD discipline held throughout a large multi-gate feature**: RED test written and watched fail before every implementation change, across 7 architectural "gates" (provenance, thresholds, provider interface, local provider, resolution order, labeling, model-switching) plus a full pre-release fresh-install simulation with isolated HOME/fake Ollama host to validate zero-provider behavior end-to-end.

## Context
Project: vir. Category: decision. Date: 2026-07-31T12:59:17.019Z.

## Related

- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- [query-logging-append-only-architecture](/vault/patterns/query-logging-append-only-architecture-a2bc5634/)
- ollama-probe-null-breaks-inference
- [mirrored-sweep-for-new-entity-type](/vault/patterns/mirrored-sweep-for-new-entity-type-7415aa64/)
- [thesis-as-launch-launchpad](/vault/decisions/thesis-as-launch-launchpad-395d2f80/)

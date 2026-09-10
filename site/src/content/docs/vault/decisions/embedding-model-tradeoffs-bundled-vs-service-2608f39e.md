---
title: "embedding-model-tradeoffs-bundled-vs-service"
description: "Decision distilled by vir from a Claude Code session on 2026-07-31. Extended a Claude Code CLI's (\"vir\") embedding pipeline from a hard Ollama dependency to a provider-agnostic, optional a"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `2608f39e` · 2026-07-31 · classifier confidence 0.92
:::

## Summary
Extended a Claude Code CLI's ("vir") embedding pipeline from a hard Ollama dependency to a provider-agnostic, optional architecture, following strict TDD, then shipped it end-to-end (README rewrite, changelog, version bump, npm publish, live-install verification). Key decisions: never guess model-dependent constants (similarity thresholds) — calibrate them from real distributions on the actual vault data before shipping.

## What Was Learned
- **Calibrate model-dependent constants from real distributions, not intuition.** "bge runs hotter than nomic" was true for query-doc cosine similarity (+0.15) but false for doc-doc similarity (nearly identical distributions). A naive port of thresholds across embedding models can silently break unrelated features (e.g. gutting a "related notes" graph). Quantile-match real distributions before porting any embedding-model-specific constant.
- **Heavy optional native dependencies (ML runtimes, ONNX, etc.) should be lazily installed to a separate prefix, not listed as `optionalDependencies`** — npm still downloads optional deps for every install. Using `npm install --prefix ~/.vir/embedder` + `createRequire`/dynamic import keeps the main package tiny and makes the cost an explicit, consented user action.
- **Always test the N=1 / degenerate case of ranking formulas.** Standard IDF (`log(N/df)`) returns 0 for every term when a corpus has exactly one document — meaning a brand-new install's first note is permanently unfindable. Smoothing (`log(1 + N/df)`) fixes this with negligible impact at scale. Only a fresh-install simulation (not unit tests against an existing large vault) surfaces this class of bug.
- **A served model's effective limit can be smaller than the model's actual capability** (e.g. Ollama serving nomic-embed-text at context 2048 despite the model supporting 8192). Best-effort embed/fetch wrappers that swallow errors need typed error kinds (context-limit vs. http vs. network) so failure logs are diagnosable instead of uniformly silent.
- **Provenance tracking is required whenever multiple embedding backends can coexist**: store `(model, dim)` alongside every vector, migrate additively with backfill for legacy rows (assume the sole historical embedder), and have retrieval explicitly refuse/exclude cross-model comparisons rather than silently computing meaningless cosine similarity.
- Before any release: rebuild `dist/` from a clean tree, confirm zero uncommitted diffs against HEAD, run the full test suite, then let `prepublishOnly` rebuild/retest again during `npm publish` as a second independent check. Tag annotated releases and verify the tag landed on the remote.
- After publishing, do a real `npm i -g` + smoke test (e.g. `vir doctor`) against the live/global install and real user data to catch migration or environment issues invisible to the dev tree.

## Context
project: vir, category: decision, date: 2026-07-31T12:59:17.019Z

## Related

- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- [mirrored-sweep-for-new-entity-type](/vault/patterns/mirrored-sweep-for-new-entity-type-7415aa64/)
- ollama-probe-null-breaks-inference
- [thesis-as-launch-launchpad](/vault/decisions/thesis-as-launch-launchpad-395d2f80/)
- [time-window selection resolves schema tension](/vault/decisions/time-window-selection-resolves-schema-tension-3745b31b/)

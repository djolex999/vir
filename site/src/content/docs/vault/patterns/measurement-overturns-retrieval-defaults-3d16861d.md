---
title: "measurement-overturns-retrieval-defaults"
description: "Pattern distilled by vir from a Claude Code session on 2026-09-11. Built a retrieval evaluation harness (`npm run eval`) for the vir project to measure search quality across five arms (TF"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `3d16861d` · 2026-09-11 · classifier confidence 0.95
:::

## Summary

Built a retrieval evaluation harness (`npm run eval`) for the vir project to measure search quality across five arms (TF-IDF, nomic, bge, with/without MMR), and ran a baseline on 41 queries with 1215 Sonnet 5 labels, uncovering that MMR at 0.3 only costs (turn it off), TF-IDF and embeddings win different queries (hybrid, not fallback), and no cosine floor separates garbage from relevant (re-rank, not threshold tuning).
Three retrieval beliefs were contradicted by measurement: MMR should go to 0, not toward 1.0; TF-IDF beat production on nDCG by +0.176 [0.044, 0.313]; and garbage threshold tuning is not a fix (the generator is).

## What Was Learned

- **Experiment code that grounds shipped constants must stay in the repo and never disappear.** The 07-31 embedding experiment (20 queries, 75k doc-doc pairs) produced `search/thresholds.ts` constants, then vanished—only the numbers survived in a comment. A threshold's only provenance cannot be a comment. Anything that measures the system lives in `eval/` (never ships: `files` whitelist + outDir excludes it), data under `~/.vir/` (guarded by `noLeak.test.ts`). experiment-code-not-scratchpad

- **Isolation via HOME in child processes:** Each arm runs the production `searchWithOutcome` in a child process with `HOME=~/.vir/eval/homes/<arm>`. Every path constant (`VIR_DIR`, `LOCAL_PROVIDER_DIR`, etc.) resolves through `homedir()` and lands inside the arm home. Real `~/.vir` stays untouched per run. The pattern: injectable config, read-only DB opens, env var override. HOME-isolation-for-testing

- **Measured before built, period.** Track C's proposed changes were reordered by measurement, not opinion: (1) MMR default 0.3 → 0 (smallest change, immediate win), (2) hybrid/RRF (both arms win different queries), (3) re-rank (only thing that fixes garbage). A retrieval knob gets a `npm run eval -- run` number before it gets its own PR. measure-before-building-retrieval

- **Small N is fine when CI is reported.** 13 human-entrypoint transcripts for the A/B test is fewer than 15, but paired bootstrap over 2000 rounds on per-query differences is valid—you'll just need ~0.5 SD effect size to see a clear CI. Report the CI; let the user judge. small-N-with-CI

- **Pool-first evaluation (TREC pooling) prevents bias toward one arm.** Union top-20 across all five arms, judge at k=10 (shallower than pool depth). A note no arm surfaced is correctly never judged, and a note that appears in only one arm's top 10 gets labeled only once—no arm bias. Later k=20 labels only new pairs. pool-first-prevents-arm-bias

- **claude-cli cost records undercount input tokens ~1000×** (claude-cli envelope carries `cache_creation_input_tokens` / `cache_read_input_tokens` / `usage.input_tokens`, but `parseCliEnvelope` keeps only `usage.input_tokens`, which is ~2 for a 3k-token prompt). Every distill record since 0.17.0 shows `input_tokens ≈ 2` with `token_source: "real"`. Fix: sum all three fields in the parser. claude-cli-token-counting-bug

- **Rare-token gating for identifier picking.** Don't test lexical recall on identifiers with corpus-omnipresent tokens (`context`, `sync`, skill names). Pick only from identifiers where at least one token has df/N ≤ 0.05. Prevents re-testing the same lexical pattern across notes. rare-token-gating

- **stripMarkdown deletes inline code before tokenizing.** Identifiers like `getUserMedia`, `REAL_EXERCISE_RULE` that appear only in backticks are unfindable to TF-IDF because the tokenizer never sees them. Affects the lexical-semantic split measurement (C6 input). stripMarkdown-silences-inline-code

## Context

Djole is building a search system that needs to choose between different retrieval strategies and tune their knobs. The vault holds 322 notes from prior work. A baseline harness that isolates each arm and measures nDCG/recall@8 with CI revealed that the current default (Sonnet classifier, nomic embeddings, MMR on at 0.3) underperforms TF-IDF on this specific corpus and gains nothing from MMR—a finding that would have been invisible without measurement. The lessons apply to any system where a knob or architecture choice feels right but needs proof before shipping.

## Related

- [schema-enumeration-stops-drops](/vault/patterns/schema-enumeration-stops-drops-a2bc5634/)
- vir-audit-subagent-development
- [model-judge-human-mismatch](/vault/gotchas/model-judge-human-mismatch-b147175c/)
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- unit-tests-miss-config-regressions

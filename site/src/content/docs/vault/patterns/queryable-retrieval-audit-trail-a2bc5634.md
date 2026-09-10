---
title: "queryable-retrieval-audit-trail"
description: "Pattern distilled by vir from a Claude Code session on 2026-08-13. Built a complete retrieval-logging system (vir 0.16.0) and added an optional subscription-based distill provider for Cla"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `a2bc5634` · 2026-08-13 · classifier confidence 0.95
:::

## Summary

Built a complete retrieval-logging system (vir 0.16.0) and added an optional subscription-based distill provider for Claude Code users (vir 0.17.0), stopping before publish and with all code test-driven. The 0.16.0 release logs every search to `~/.vir/queries.jsonl` with rotation, adds a `vir queries` report command with dead-weight analysis (20-query minimum sample to suppress noise), and exports `SearchOutcome` provenance. The 0.17.0 release adds a `claude-cli` provider that shells out to the user's `claude` binary — keyless, zero dollars, pure subscription quota consumption — with structural guarantees (`--no-session-persistence` un-omittable, neutral cwd), a limit-halt mechanism that blocks retry (not just error reporting), and a 25-session batch cap. Both are production-ready; the claude-cli provider is an OPTION, Anthropic remains the default.

## What Was Learned

- **Enumerate schema keys in test fixtures.** VIR shipped four separate wizard-silent-key regressions (projects, logQueries, embeddingProvider, and one caught mid-session) because re-init relied on manual carry-over. The fix: a test that enumerates the entire ConfigSchema and fails if any key lacks a non-default sample value — it caught the fourth drop immediately on the first run. Non-default samples are load-bearing: a dropped key falls silently back to the zod default, so only a differing value can detect the drop.

- **Probe actual binaries before designing around assumed constraints.** The claude-cli design assumed transcript pollution and planned defensive filtering; a 10-minute `claude -p` probe found `--no-session-persistence`, eliminating the problem structurally. Same probe verified model pinning, entrypoint format, and the absence of a session-suppression call overhead. Investigate-then-build beats building against untested constraints.

- **Unverifiable patterns get evidence paths, not trust.** The subscription-limit regex is docs-sourced and unreproducible (can't trigger it on demand without a real limit). Rather than guess, the implementation logs raw error envelopes once per run, defaults to the safe action (halt, never retry against a wall), and marks a doctor row "unverified" until the first real hit stamps a confirmation marker. The regex can be corrected when it inevitably encounters something the docs didn't cover.

- **Dead-weight thresholds prevent noise.** With 2 logged queries, every unmeasured note looks unused. At 20 queries (≈40–80 calls to the search API at typical topK 5–8), even useful notes have had 100+ chances to surface. The guard: `deadWeight: string[] | null`, where null below the threshold reads as "insufficient sample, not zero weight." This immediately pushed back against premature optimization.

- **Honest labeling compounds trust.** Calling claude-cli cost "subscription quota (no $)" instead of "$0.00" took three extra lines, but it's the difference between "great, I'm saving money" and "wait, I just spent 5 hours and didn't know quota was being measured." Same with the limit-detection doctor row: "unverified (docs-sourced)" is a permission slip to run experiments; "confirmed" with evidence builds credibility.

## Context

**Project:** vir (Claude Code session distiller → Obsidian vault)  
**Category:** feature  
**Date:** 2026-08-13, 00:19:47.634Z – end of session

**Releases shipped:**
- **v0.16.0** (commit ee1d550, npm latest): retrieval logging (queries.jsonl + JSONL rotation), `vir queries` report with dead-weight analysis, `SearchOutcome.candidates` + `.provider` provenance, 504 tests green, published + tarball-verified.
- **v0.17.0** (commit e080cc3, npm latest): claude-cli provider (shell out to `claude -p`; zero credential, zero dollars; subscription quota), limit halt (non-retryable, with reset time), 25-session batch cap, `estimated_cost_usd: null` (never $0.00), schema-enumerated re-init survival guard, 534 tests green, published + tarball-verified.

**Both releases:**
- Built from clean (`npm run build` after `rm -rf dist`).
- Full test suite passing (504 → 534 tests added and green).
- `tsc --noEmit` clean.
- Commits pushed to main with annotated tags verified on the remote.
- Published to npm `@djolex999/vir-cli` and verified byte-for-byte against published tarballs.
- User config untouched (still `provider: "anthropic"`, all other values preserved).

**Key decisions:**
- Retrieval logging is additive telemetry (candidates count, provider {name, model, dim} | null) and call-site gated on `cfg.logQueries` (default true, but opt-out available).
- Dead-weight analysis suppresses the list below 20 logged queries to avoid presenting sampling noise as signal.
- claude-cli is an OPTION, not a replacement — Anthropic stays the default. Init wizard offers all three providers honestly (one line each, no ranking).
- The subscription-limit regex is unverified by design — first real hit will test and potentially correct it; meanwhile, the fail-safe (halt, never retry) and evidence logging make it safe to ship.
- The survival-guard test is the permanent solution to the class of silent-drop bugs that shipped four times in this codebase.

**Outstanding:** 
- Your Anthropic API credit balance is empty (affects your default-provider distills + `vir query` synthesis, but not the new claude-cli path). Top up when you're ready.
- `docs/APP-ATLAS.md` and `docs/atlas.html` are untracked and left untouched; they predate this session.

## Related

- [silent-failure class unfinished](/vault/gotchas/silent-failure-class-unfinished-7bfa9706/)
- [thesis-as-launch-launchpad](/vault/decisions/thesis-as-launch-launchpad-395d2f80/)
- ollama-probe-null-breaks-inference
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- [active-learning-review-loop](/vault/patterns/active-learning-review-loop-f41385ca/)

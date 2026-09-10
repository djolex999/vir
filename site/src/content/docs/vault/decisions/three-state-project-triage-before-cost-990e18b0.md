---
title: "three-state project triage before cost"
description: "Decision distilled by vir from a Claude Code session on 2026-07-30. Session drove a multi-stage TDD build in the `vir` distillation pipeline, adding three layers of transcript filtering (p"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `990e18b0` · 2026-07-30 · classifier confidence 0.95
:::

## Summary
Session drove a multi-stage TDD build in the `vir` distillation pipeline, adding three layers of transcript filtering (per-project include/exclude, nested workflow/sidechain transcripts, and SDK-launched agent transcripts) after empirical audits proved the free heuristic filter's real problem was population composition, not threshold placement. Shipped as v0.14.0, published to npm, and synced to project docs.

## What Was Learned

- **Classify transcripts by launcher signature, not activity metrics or turn count.** The one field that safely separates human sessions from SDK-launched agent harnesses is the *first user line's* `entrypoint` (starts with `"sdk"`). `promptSource` is contaminated on desktop-launched sessions (would have misclassified the single most valuable transcript in the audit), and turn-count rules would kill single-prompt autonomous runs. Verify any new classifier against the highest-value known-good case before shipping it.
- **Any new skip/filter category must never overwrite a row already holding a distilled note.** Forward-only filtering means guarding every DB record call site (`isDistilledRow` check), not just the new code path — the first implementation of both the project filter and transcript-category filter would have silently hidden ~141 already-distilled notes by flipping `skipped=1`. This must be enforced by a test, not a review comment.
- **Blind-sample the population before tuning a threshold.** A scoring cutoff that looks arbitrary may be fine — the real defect can be *who's in the distribution* (here: 68% of transcripts were agent-internal review harnesses scoring on activity metrics like line/tool count, not real work). Measure composition first; don't assume the threshold is the lever.
- **Config-schema migrations for new tri-state fields should use `absent = undecided`, never an implicit include or exclude** — old configs migrate via a schema default (e.g. `{}`), forcing an explicit visible triage state rather than silently auto-including or auto-excluding existing data.
- **Structural detection (path-based) should always have a content-level backstop** (e.g. checking `isSidechain`/`entrypoint` fields during full parse) for when layout changes evade the fast scan-time check — both should gate before any paid LLM call.
- Daemon/automated paths should never interactively prompt; gate via dependency injection (an `onUndecidedProjects`-style callback the daemon simply never passes) so prompt-free behavior is provable by test, not just convention.

## Context (project: vir, category: decision, date: 2026-07-30T17:28:50.095Z)
Decision: extend vir's distillation pipeline with three additive, reversible filtering layers (per-project decisions, nested workflow/sidechain transcripts, SDK-launched agent transcripts) rather than adjusting the existing heuristic filter's threshold — based on real-machine audit evidence that filter threshold was not the source of noise. Shipped as `@djolex999/vir-cli@0.14.0`, all work done RED→GREEN per session's TDD convention, 431 tests green, `tsc` clean, verified against the real `~/.claude/projects` transcript set before and after release.

## Related

- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- [tool-output-bounding-strategy](/vault/decisions/tool-output-bounding-strategy-7eef1373/)
- [cost-recording-retry-safety](/vault/patterns/cost-recording-retry-safety-agent-ae/)
- [thesis-as-launch-launchpad](/vault/decisions/thesis-as-launch-launchpad-395d2f80/)
- [time-window selection resolves schema tension](/vault/decisions/time-window-selection-resolves-schema-tension-3745b31b/)

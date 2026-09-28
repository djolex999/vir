---
title: "usefulness-eval-applied"
description: "Pattern distilled by vir from a Claude Code session on 2026-09-27. This session executed a previously-approved plan (spec + implementation plan) to build a \"note-usefulness eval\" for the"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `ad237d30` · 2026-09-27 · classifier confidence 0.88
:::

## Summary

This session executed a previously-approved plan (spec + implementation plan) to build a "note-usefulness eval" for the `vir` project, using subagent-driven development across 8 tasks, then ran the real eval against the user's own vault and acted on its verdict. The key deliverable was `eval/usefulness/` (mine → run → gate → show), gated by a frozen non-inferiority statistical test, merged as PR #62 and a follow-up fix as PR #63, ultimately leading to `vir audit --apply-rejects` being run for real (17 notes rejected, 1 retitled and kept).

## What Was Learned

- **A first verdict can be wrong if the test scope doesn't match the real action.** The eval initially tested ablating *all* fresh audit rejects, but `vir audit --apply-rejects` actually skips human-approved notes (`noteIsVerified`). This mismatch was caught only by hand-checking failing cases, not by the automated gate — a reminder to verify a report's claims (initially overstated "2-3 load-bearing rejects" down to just 1) before delivering it to the user.
- **Cache + concurrency without in-flight dedupe causes double-pay.** Running `mapLimit(2, ...)` over (question, arm) tasks let two concurrent calls with an identical prompt both miss the cache. Fix: make the cache-key-sharing unit (the question) the concurrency unit, not the (question, arm) pair.
- **Bootstrap CI thresholds need symmetric, named floating-point tolerance.** Repeated-decimal drift (~1e-17) past exact frozen bounds (e.g. `-0.05`, `+0.02`) requires a tolerance constant applied to both sides, and regression tests must construct inputs that actually land on the tolerance-sensitive side.
- **Order expensive pipeline phases by cheapest-thing-that-invalidates-the-rest.** Grader probes (facts-only, no answer needed) were reordered to run before the ~3x costlier answer/grade phase, so a broken grader is caught at ~230 calls instead of ~750.
- **In this environment, `git push`, `git merge --ff-only` across worktrees, and enabling PR auto-merge are blocked by an auto-mode permission classifier** and must be done by the user or via direct `gh pr merge` after CI passes.
- **In the `vir` repo, `CLAUDE.md`, `handoff.md`, and `tasks/` are gitignored and exist only in the main checkout** (`~/projects/vir`), never in `.claude/worktrees/*` — must read/sync them from the main checkout.
- **At small sample sizes (~34 questions), LLM answer-wording noise alone can flip a statistical gate** (PASS/FAIL), independent of any real information loss — worth flagging explicitly rather than treating a FAIL as conclusive.

## Context

The user runs `vir`, a personal knowledge-vault CLI, and had pre-approved a spec/plan for testing whether their `vir audit --apply-rejects` reject verdicts safely remove notes without degrading future answer quality; this session carried that plan through implementation, a real ~850-call evaluation run, bug discovery/fix, and production application of the result.

## Related

- [verdicts-split-by-prompt-version](/vault/patterns/verdicts-split-by-prompt-version-6b978c24/)
- [model-judge-human-mismatch](/vault/gotchas/model-judge-human-mismatch-b147175c/)
- test-isolation-leak
- [measurement-overturns-retrieval-defaults](/vault/patterns/measurement-overturns-retrieval-defaults-3d16861d/)
- [schema-enumeration-stops-drops](/vault/patterns/schema-enumeration-stops-drops-a2bc5634/)

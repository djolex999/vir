---
title: "verdicts-split-by-prompt-version"
description: "Pattern distilled by vir from a Claude Code session on 2026-09-25. This session on the `vir` project (an Obsidian-vault knowledge-distillation CLI) ran a full quality audit of the user's"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `6b978c24` · 2026-09-25 · classifier confidence 0.9
:::

## Summary

This session on the `vir` project (an Obsidian-vault knowledge-distillation CLI) ran a full quality audit of the user's 337-note vault, then built and shipped a `vir audit` command (v0.20.0 → v0.22.0) that has a model grade every note keep/verify/merge/reject and feeds `vir review`, with a strictly reversible `--apply-rejects` path. The most important thing established: **verdicts from an LLM judge (even Opus) are only trustworthy when split by which distill-prompt version produced the underlying notes** — 271 of 337 audited notes predated a 2026-09-18 prompt fix and scored far worse (14% keep) than the 25 notes written after it (44% keep), so the first audit's "vault is mostly bad" headline was really "the old prompt was bad, already fixed."

## What Was Learned

- **Calibrating a model judge against human agreement can silently fail.** A 20/20 "human check" passed the frozen release gate for `vir audit`, but the user later revealed he'd agreed by deference to the model rather than independently checking — so the gate technically passed without substantively validating anything. Chosen: ship anyway (all `--apply-rejects` moves are confirmed + reversible) and record the caveat honestly in the changelog, rather than treat the deferred 20/20 as real confirmation.
- **The stronger long-term gate is behavioral, not opinion-based**: measure whether a note actually improves Claude's answers to real later-session questions (with/without-note ablation, fact-checklist grading), not "ask an LLM if the note is good." A full spec + implementation plan for this was written (`docs/superpowers/specs/2026-09-26-note-usefulness-eval-design.md`, `docs/superpowers/plans/2026-09-26-note-usefulness-eval.md`, branch `feat/usefulness-eval`) but not yet executed.
- **Two model judges (or one model on two prompt versions) agree on individual verdicts only ~45-52% of the time** — this repeats an earlier 09-18 finding (model rubric disagreed with the user 8/9 times) and is why every model-judge feature in this project routes only to human-reviewed queues, never direct action, except for the one narrow reversible exception (`--apply-rejects`, gated by its own frozen calibration rule).
- **A verdict-storage design should be DB-authoritative and content-hash-gated** (mirroring the existing `pruned_at`/`rejected_at` pattern), never stored only in the file, so it can't silently leak through read paths (`listDistilled`, `getStats`, embedding sweep) the way an earlier `vir review` reject bug did.
- **Any command that acts on a model verdict must re-check the current human verdict at act time, not just at judgment time** — the final whole-branch review (not per-task reviews) caught that `--apply-rejects` could override a note the user had since approved or restored; per-task review alone missed this cross-cutting risk.
- **`npm publish`'s browser login step only works from an actual interactive terminal pane**, not a chat-relayed command input — repeated failures (misleading `E404`) were actually `401 Unauthorized`/no login, fixed by running `npm login && npm publish` directly in the Terminal tab.
- **Git worktree file-guards in this harness are tied to a fixed worktree path**, not the branch — reusing the same worktree directory across unrelated branches (audit fixes → vir-audit feature → usefulness-eval spec) was necessary to avoid Write-tool path-guard errors.

## Context

The user runs `vir` as a personal tool that distills Claude Code session transcripts into an Obsidian vault, which is then queried by other Claude sessions via MCP; a noisy or stale vault directly degrades those sessions, which motivated building automated (but human-gated) quality control rather than trusting model judgment outright.

## Related

- [model-judge-human-mismatch](/vault/gotchas/model-judge-human-mismatch-b147175c/)
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- test-isolation-leak
- [note-path-not-identity](/vault/gotchas/note-path-not-identity-d15e2d02/)
- [schema-enumeration-stops-drops](/vault/patterns/schema-enumeration-stops-drops-a2bc5634/)

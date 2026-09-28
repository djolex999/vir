---
title: "tdd-preflight-implementation"
description: "Pattern distilled by vir from a Claude Code session on 2026-09-24. This session built and released v0.18.2 of the vir CLI, which surfaces provider preflight failures to users through desk"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `ed02ce7d` · 2026-09-24 · classifier confidence 0.88
:::

## Summary

This session built and released v0.18.2 of the vir CLI, which surfaces provider preflight failures to users through desktop notifications and a doctor row. The key implementation was writing failing tests first (TDD), then the minimal code to pass them: recording failures to `~/.vir/provider-preflight.failed`, sending one notification on daemon runs, and showing a provider preflight check in doctor.

## What Was Learned

- **Preflight is structurally separate from the error loop.** The provider probe aborts before the distill loop, so it records no per-session error rows and never triggers `failureNotice` or doctor's distill-failures row. That's intentional (one outage is one fact, not N failures), but it meant a daemon dying on expired Claude Code auth left only a stack trace in `daemon.log`. The marker file pattern (`~/.vir/claude-cli-limit.confirmed` already existed) isolates this environmental fact.
- **TDD is load-bearing for this scale.** Seventeen test cases written first caught the difference between "notify on daemon only" vs. "never notify on interactive" (a behavior that feels optional until you write the test), the 2-day cutoff for fail vs. warn in doctor, and the marker being cleared on success. Watching each fail in red before the code validated that each test measured something real.
- **Worktrees are creating a project explosion.** `decodeProjectName` resolves every Claude Code worktree to its leaf name (the worktree folder name), not its parent repo, so 26 worktree sessions across vir, pripremi.rs, popis, and others are each their own undecided project. Transcripts expire in ~30 days, so these age out. The fix (rolling worktree cwd to parent repo name in decode) is a separate task now running.

## Context

A daemon run on 2026-09-23 failed on `Failed to authenticate: OAuth session expired and could not be refreshed`, and the only signal was a stack trace in `daemon.log`. The preflight runs before the loop and throws synchronously, so no per-session error rows exist for the usual failure reporting to find. The release shipped the marker, notification, and doctor row pattern; npm published 0.18.2 and the v0.18.2 tag was pushed. Eighteen new project worktrees (Claude Code isolated sessions for branches and experiments) are now visible as undecided projects in `vir projects` because they're treated as separate projects from their parent repos.

## Related

- test-isolation-leak
- vir-audit-subagent-development
- [schema-enumeration-stops-drops](/vault/patterns/schema-enumeration-stops-drops-a2bc5634/)
- prerequisite-validation-blocks-launch
- [model-judge-human-mismatch](/vault/gotchas/model-judge-human-mismatch-b147175c/)

---
title: "worktree-sessions-inherit-parent"
description: "Pattern distilled by vir from a Claude Code session on 2026-09-25. Fixed how vir categorizes Claude Code worktree transcripts: instead of treating each worktree as its own project, a work"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `0541c25d` · 2026-09-25 · classifier confidence 0.9
:::

## Summary

Fixed how vir categorizes Claude Code worktree transcripts: instead of treating each worktree as its own project, a worktree session now inherits its parent repository's include/exclude decision. The fix decodes only the path prefix before `--claude-worktrees-`, so deleted worktrees still map to their parent repo, and classifies sessions under the parent's name instead of the raw encoded directory.

The two PRs (djolex999/vir#51 and #52) resolved 26 of 32 undecided projects from the machine, moved 17 worktree sessions from stale `project-pending` status into processing, and ensured their notes are filed under vir, pripremi.rs, popis, lucid, growthq or growthq_us — not under ephemeral worktree names.

## What Was Learned

- **Encode markers as path anchors, not strings:** when a filesystem path encodes segments (e.g. `/.claude/worktrees/` → `--claude-worktrees-`), use the marker as a boundary for prefix decoding. Resolve only the parent side so a deleted child still maps home; fall back to full decode if the parent is gone. This is safer than guessing.

- **Centralize naming decisions:** vir's project name comes from `decodeProjectName`, used by grouping, filtering, cost decisions, and classification. When one of those (classification) got out of sync, 27 sessions had misleading project hints. Extract the logic once (`projectNameFor`) and feed it everywhere; every call site that touched the name needed updating.

- **Test filesystem-dependent code against real paths, not mocks:** the test I wrote for deleted worktrees builds a real temp repo and deletes it, then verifies the decoder still finds the parent. A mocked `readDir` would have hidden the fallback path.

- **Pass decoded names through function signatures where they're used:** `parseSession` took a `projectSlug` parameter (was always `basename(dirname(path))`). Making it optional and passing the real name from callers was cleaner than adding a second parameter like `projectsDir` and decoding inside.

## Context

The 26 worktree projects stalled processing: their sessions were marked `project-pending` because vir saw each worktree as a separate, undecided project. As Claude Code's ~30-day transcript pruning kicked in, sessions were lost. The fix collapses worktree projects into their parent repos and reactivates ~46 old stale sessions once the parent is included — so a real run after the fix processes them and files them correctly.

## Related

- [schema-enumeration-stops-drops](/vault/patterns/schema-enumeration-stops-drops-a2bc5634/)
- claude-code-execution-workflow
- [hybrid-model-routing](/vault/decisions/hybrid-model-routing-376a7c67/)
- session-storage-hook-management
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)

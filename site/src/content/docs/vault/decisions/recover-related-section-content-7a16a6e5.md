---
title: "recover-related-section-content"
description: "Decision distilled by vir from a Claude Code session on 2026-09-25. This session worked in the `vir` repo (TypeScript, vitest). It stopped a rewrite from dropping content that pre-0.12.0 n"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `7a16a6e5` · 2026-09-25 · classifier confidence 0.87
:::

## Summary
This session worked in the `vir` repo (TypeScript, vitest). It stopped a rewrite from dropping content that pre-0.12.0 notes stored under `## Related`, and restored `## Archived Duplicates` sections that earlier rewrites had deleted from `vir dedupe` winners. The fix is `vir lint --legacy-related [--fix]` in `src/lint/legacyRelated.ts`. It changes the stored content in the DB and moves content bullets under a new `## Details` section, chosen over teaching the writer to render them. It shipped as PR #59 on top of #58 in v0.21.0.

## What Was Learned
- **Decision: migrate the stored content (option a), not the writer (option b).** Since #58, `vir dedupe` also strips Related from the notes it merges. A writer-only rendering fix would still lose the content on a merge. Migrating in the DB fixes it for every code path and every writer version.
- **Bare topic names are dropped by a conservative classifier.**
  - A bullet is dropped only if it is plain words, at most 8 of them, with no code span, path, colon, dash separator, parentheses, second sentence or verb like "is" or "must".
  - Bare wikilinks are dropped too. A bullet with nested lines, or a non-bullet line, is always kept.
  - The rule errs toward keeping. A dropped claim is lost for good, while a kept topic name costs one line.
  - It was checked against a copy of the real DB before use.
- **The migration covers pruned and rejected rows, not only serving ones.** `StateDb.listStoredContent()` returns every non-archived row with a `serving` flag from `servingGate()`. A later `vir prune --restore` or `vir review --restore` would otherwise bring back unmigrated text. Archived dedupe losers are left alone.
- **Idempotency comes from the shape of the result.** A migrated row has no Related section, so a second pass selects nothing. `--fix` holds the pipeline lock. `db.updateContent` clears the row's embedding because `## Details` is now part of the embedded text, and the rewrite re-embeds.
- **Real-vault results:**
  - 340 of 430 stored notes had a Related section, and 336 of them held content.
  - 1,313 bullets were kept and 146 topic names dropped.
  - 129 serving notes were re-rendered, with no files added or removed compared with the backup.
  - A second `lint --legacy-related` reports none.
- **The "47 of 49 lost archive sections" premise was too broad.** Only 13 files in `~/Vir/vir/archived/` are dedupe losers (`archived=1` in the DB). The other 36 are old copies of retitled notes that `vir lint --strays --fix` moved there.
- **The vault's nightly backup git history (`~/Vir/.git`) records the exact winner of a merge.** It gave the winner for 12 of 13 losers, so the sections were restored from it (12 live notes now carry the section; the other 2 restored links went to rejected notes). This was better than inferring from similarity. The restore was a one-off script and is not in the repo.
- **Embedding similarity is not a reliable merge record.**
  - It ranked the true winner first for all 12 recorded pairs, but one margin was only 0.008.
  - It was used for exactly one unrecorded loser, `json-mode-fallback-poisoning-f9887a43`. It was linked to `json-mode-fallback-injection-108849fd` (cosine 0.937 vs 0.847 for the next note), and a sibling loser is recorded as merged into that same note.
  - That winner is in `.rejected/`, so `vir prune`'s `isMergeWinner` check is unaffected.
- **Operational constraints found on the way:**
  - A daemon `vir run` holds the pipeline lock for its whole backlog (20+ minutes). SIGTERM is safe, because the lock names a dead PID and `acquireLock` reclaims it, and the interrupted session is redone next run.
  - `npm publish` here uses browser web-auth, not an OTP flag. It has to be started in the user's terminal, and any earlier waiting publish must be closed first.
  - The installed 0.20.0 lacked #58, so a `--rewrite-only` with it would have wiped the restored archive sections. That is why 0.21.0 was released and installed right after.
- **Repo conventions followed:**
  - Stacked PR #59 on #58's branch, then retargeted to `main` after #58 merged.
  - Merge commits, not squash.
  - Changelog entries under Unreleased, then a dated `0.21.0` section.
  - README lint table and test count updated.
  - The release commit went straight to `main` with a tag, like 0.20.0.
  - 841 tests pass and `tsc --noEmit` is clean.
- **Safety steps taken:**
  - `sqlite3 .backup` of `vir.db` plus a tar of the vault, taken before touching real data (`~/.vir/vir.db.backup-20260925-legacy-related-2` and the matching tar).
  - A read-only dry run before applying.
  - A file-set diff against the backup afterwards.

## Context
The task was to keep content that the 0.12.0 writer discards, and to check whether merge winners could be inferred safely. The work ran in a `vir` worktree against the user's real `~/.vir/vir.db` and `~/Vir` vault. It ended with the release published to npm and context files synced. The main open item was the 17 undecided sessions in 8 projects, whose oldest transcript is past the roughly 30-day Claude Code retention.

## Related

- vir-audit-subagent-development
- [schema-enumeration-stops-drops](/vault/patterns/schema-enumeration-stops-drops-a2bc5634/)
- trailing-path-delimiter-cwd-search
- [json-output-contract](/vault/decisions/json-output-contract-7bcca3cb/)
- uncommitted-work-collision-risk

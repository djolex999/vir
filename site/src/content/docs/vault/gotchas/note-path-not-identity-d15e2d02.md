---
title: "note-path-not-identity"
description: "Gotcha distilled by vir from a Claude Code session on 2026-09-11. This session took the `vir` CLI (`@djolex999/vir-cli`, an LLM-wiki tool that distills Claude Code transcripts into an Ob"
editUrl: false
---

:::note[Written by vir, not by a human]
**Gotcha** · session `d15e2d02` · 2026-09-11 · classifier confidence 0.8
:::

## Summary

This session took the `vir` CLI (`@djolex999/vir-cli`, an LLM-wiki tool that distills Claude Code transcripts into an Obsidian vault) from a status review through a run of fixes and features, ending at v0.17.8. The main lesson is that vir's state was split between files and SQL: a note's path, `.rejected/` moves, and Related links were all derived from mutable topic slugs or file locations, so many DB-backed read paths and rewrites silently lost or resurrected data. `writer.ts` `locateBySession()` and the `pruned_at` DB gate are the fixes that carry this.

## What Was Learned

- **A note's path is not its identity.** `makeSlug(topic, sessionId)` in `src/pipeline/slug.ts` derives the filename from the topic, and the distiller retitles on purpose (0.9.1). Anything that recomputed the path from the current topic missed the existing note. That lost the `verified` flag and its +0.2 retrieval boost (bug-hunt #12), left duplicates, and undid rejection (#9). 0.17.3 replaced this with `locateBySession()`, which indexes files by the 8-char session suffix.
- **The suffix is only a hint.** `makeSlug` truncates the session id to 8 chars, so two sessions can collide, and a match authorises deleting the old file. The first draft deleted the colliding note, and a collision test caught it. Every hit is now confirmed against the full `session_id` in frontmatter. A collision degrades to an orphaned duplicate, never a deletion.
- **A file move is not a retrieval gate.** `vir review` rejects by moving a note to `.rejected/`, which SQL cannot see. It leaks through eight DB-backed paths: `listDistilled` and everything downstream of it, `getStats`, and the embedding sweep. Search only excludes rejected notes by accident, because the moved file reads as empty content. The review leak was filed, not fixed.
- **Prune state is DB-authoritative.** `vir prune` uses `pruned_at` and `prune_reason` on the sessions row, chosen over two alternatives:
  - `skipped`, which repeats the 0.14.0 semi-prune.
  - Frontmatter, which SQL cannot see.
  - Every serving query carries `prunedGate()`, a no-op when the column is absent so the read-only MCP path doesn't break.
  - A gate at the paid boundary in `run.ts` stops `--full` re-billing pruned sessions.
  - `--restore` is byte-exact because content, embedding and hash are kept.
- **Classification had to be pure and zero-I/O.** 396 of 411 distilled transcripts are already deleted from disk, and `entrypoint` is NULL on 376 of 411 rows because it was never backfilled. So the stored path (`subagents/`, `wf_`) does the work.
  - `unclassifiable` (231 rows) and `merge-winner` (12 rows) are reported and never pruned.
  - Live result: 132 demoted, 268 serving.
- **A rewrite with no embedder used to wipe every Related section.** `neighborLinks` needs a vector. With no provider it computes zero neighbours, which renders the same as a note that has none. 0.17.6 makes `write()` fall back to `preservedRelatedSection`. Dangling links after a prune clear by regenerating with `vir run --rewrite-only`, which needs a working embedder. That took 177 dangling links to 0 in live notes.
- **Stray files are TF-IDF-retrievable.** Pre-0.17.3 retitle debris (32 files) is skipped by the embedding path but indexed by the TF-IDF walk, which skips only `summaries`, `.rejected` and `archived`. So one session can be cited twice when the embedder is down. `vir lint --strays` finds them.
  - The check asks whether any non-pruned row can produce the filename, and ignores the `content` column.
  - A session awaiting `vir reconcile` has empty content while its file is the only copy. A content-based test flagged that live note as debris.
- **Silent recorded failures are invisible ones.** 14 sessions died in one `fetch failed` window on 2026-06-11 and were found months later, after Claude Code deleted the transcripts. 0.17.8 adds two things:
  - A desktop notification at the end of any errored run (`failureNotice`).
  - A doctor `distill failures` row whose severity keys on recoverability (transcript still exists), not count.
  - Human table only; the 8-field `doctor --json` contract is unchanged.
- **Audit-backlog fixes (0.17.4):**
  - #17: a garbled classify response no longer buries a session. `parseClassification` marks `unparsed` and `run()` throws `ClassifyParseError`, so the row goes through `recordError` and stays retryable, bounded by `MAX_DISTILL_ATTEMPTS`.
  - #13: `applyPlan` in the CLAUDE.md updater is now fence-aware and refuses unbalanced markers. An orphan START used to arm a later deletion of user prose.
  - #14: a pricing override for a model missing from `DEFAULT_PRICING` used to log $0.
  - #19: the MCP server reported a hardcoded `0.1.1` and 4 of 6 tools, and `getStats` crashed on an un-migrated DB.
- **Verification traps hit this session.** All three were caught by checking the result:
  - Changing a function's return type to an object made a refusal print as a success tick, because an object is truthy, and `tsc` was fine with it.
  - A `sed` that bumped the test count no-opped because the target number had already moved.
  - A test that assumed Ollama was absent broke once Ollama ran. It now sets `embeddingProvider: "none"`.
- **Ollama wasn't auto-starting.** The `.app` login item was disabled, `brew services` was unregistered, and two installs coexisted. `brew services start ollama` fixed it, and the `.app` login item should stay off so two servers don't race for port 11434.
- **Release process.**
  - `npm publish` needs a 2FA one-time password, so the publish itself was left to the user. The registry sat at 0.17.1 while `main` and the tags were seven releases ahead.
  - A tag was force-moved to match `main` before publishing, and it is worth verifying that alignment first.
  - A repeat publish attempt returns 403 because a version number cannot be reused.

## Context

The session opened as a status and roadmap review of vir. It found the issue tracker and audit docs stale, then turned into fixing what the verification surfaced. The work followed test-first, using one PR per finding. The later steps applied the prune and rewrite to the user's live vault, with DB and vault snapshots taken first. The full-vault stray cleanup was left to the user because the auto-mode classifier blocked the mutating run.

## Related

- vir-audit-subagent-development
- test-isolation-leak
- [schema-enumeration-stops-drops](/vault/patterns/schema-enumeration-stops-drops-a2bc5634/)
- silent-database-failure-on-success-path
- trailing-path-delimiter-cwd-search

---
title: "test-setup-file-isolation"
description: "Pattern distilled by vir from a Claude Code session on 2026-09-18. This session covered promoting vir on Reddit and LinkedIn, then surfaced and fixed two critical production issues: a rec"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `6aeafebe` · 2026-09-18 · classifier confidence 0.8
:::

## Summary

This session covered promoting vir on Reddit and LinkedIn, then surfaced and fixed two critical production issues: a reconcile bug where notes were permanently stranded when transcripts were deleted, and a test suite that had been writing 14,294 lines into the real `~/.vir/daemon.log` since late July and firing real desktop notifications during `npm publish`.

The most important technical lesson: test isolation requires controlling every file path that runs at module load, not just the database mock, and pinning that constraint with a test that fails if the setup is ever removed.

## What Was Learned

- **Reconcile orphan restore pattern:** when a transcript is deleted, a row can survive with both content (from an earlier good distill) and an error (from a later failed re-distill). `listDistilled` hides it on the error flag. The fix checks for surviving content *before* skipping the missing file, and clears the stale error if content remains. Test this case explicitly so it doesn't regress.

- **Test isolation requires setup files, not just mocks:** paths like `~/.vir/daemon.log`, `vir.lock`, and the claude-cli cwd are derived from `os.homedir()` at module load, which happens after the test runner starts but before individual test files run. Setting `$HOME` to a temp directory in `vitest.setup.ts` (not in individual tests) controls all of them at once. The mock database in the test isn't enough—filesystem and notification function also need isolation.

- **Guard tests prevent setup removal:** a dedicated test that checks the isolation is active (e.g., `homedir().startsWith(tmpdir())` and `notify` is mocked) fails loudly if the setup file is ever removed, rather than silently letting the suite escape.

- **Identify test noise by fixture paths and scan size:** test runs left logs like `/t/projects/demo/...` and `scanned 2 jsonl files`, real runs use `~/` paths and `scanned 734 jsonl files`. With timestamps and a 5-second merge window, you can separate test windows from real activity and clean only test lines.

- **Publish gap hidden until visibility added:** 0.17.1 was live on npm while 0.18.0 (with prune, failure notifications, and the distill A/B result) existed only in git. No one noticed because the changelog and README are in the repo. 0.18.1's publish surfaced this by running tests, which had been silently leaking into `~/.vir` for months and only became visible when a new feature (the notification) started reading that log.

- **Promotion strategy differs per platform:** r/ClaudeCode wants the loss-and-recovery angle (transcripts deleted, notes rescued). r/ClaudeAI wants the A/B test surprise. r/ObsidianMD wants the graph and plaintext story. The same content pasted across subs signals low effort to mods and veterans, who notice and downvote. Use different stories, every comment in the first 2 hours.

## Context

The session started as a request to write Reddit and LinkedIn posts about vir's public launch. The work uncovered that npm only had 0.17.1 published while main had months of features, and that `npm publish` was triggering the test suite, which had been writing test fixtures into the developer's real `~/.vir` since late July and firing real macOS notifications. The bug fix for the stranded-note case and the test isolation fix both became essential before publishing 0.18.1.

## Related

- test-isolation-leak
- test-isolation-via-injection
- [schema-enumeration-stops-drops](/vault/patterns/schema-enumeration-stops-drops-a2bc5634/)
- [note-path-not-identity](/vault/gotchas/note-path-not-identity-d15e2d02/)
- vir-audit-subagent-development

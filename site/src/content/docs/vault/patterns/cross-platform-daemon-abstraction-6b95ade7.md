---
title: "cross-platform-daemon-abstraction"
description: "Pattern distilled by vir from a Claude Code session on 2026-05-22. This session implemented cross-platform daemon support for the `vir` CLI tool (v0.3.0–0.3.2), adding Linux scheduling vi"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `6b95ade7` · 2026-05-22 · classifier confidence 0.92
:::

## Summary

This session implemented cross-platform daemon support for the `vir` CLI tool (v0.3.0–0.3.2), adding Linux scheduling via systemd user timers with a cron fallback. A mid-release incident where a corrupted `AGENTS.md` shipped to npm led to replacing the `.npmignore` denylist with a `package.json` `files` allowlist. A follow-up patch (0.3.2) addressed a WSL/container edge case where `systemctl` is on PATH but the user bus is unreachable.

## What Was Learned

**Platform router pattern for daemon backends**
`src/daemon/index.ts` dispatches on `process.platform` to launchd (macOS), systemd (Linux, preferred), or cron (Linux fallback). Each backend throws typed errors (`SystemdNotAvailableError`, `SystemdUserBusUnavailableError`) so the router can fall back without pre-probing. The cron fallback is triggered by either error type. ExecStart and cron commands always use resolved `node + cli.js` paths — never a hardcoded binary path like `/usr/local/bin/vir`, which breaks for npm-global installs.

**Probe before writing — the WSL/container systemd trap**
`systemctl` being on PATH does not mean the systemd user bus is reachable. On WSL and containers, `systemctl --user is-system-running` exits with "Failed to connect to bus." The fix: probe first, throw a distinct typed error (`SystemdUserBusUnavailableError`), and fall back to cron. If a later step fails after files are written, clean up the unit files before re-throwing so retries and cron don't start from a dirty state.

**npm publishes the working tree, not the git index**
`npm publish` packs whatever is on disk — untracked and gitignored files included. A `.npmignore` denylist is fragile; any stray root file ships. A `package.json` `"files"` allowlist (`dist`, `assets`, `README.md`, `LICENSE`) is the correct fix. Always run `npm pack --dry-run` and verify the file list before publishing.

**Annotated vs lightweight git tags and `--follow-tags`**
`git push --follow-tags` only pushes annotated tags (created with `git tag -a`). Lightweight tags (`git tag v0.3.x`) require an explicit `git push origin v0.3.x`. Prefer annotated tags for releases.

**Async CLI actions with commander**
When a CLI action calls `await`, the `.action()` callback must be declared `async`. Commander supports async action handlers via `program.parseAsync()` (not `program.parse()`). Both were already in use; the status and schedule commands were updated to `async () =>` to match.

## Context

- **Project:** vir
- **Category:** pattern
- **Date:** 2026-05-22T22:38:38.619Z
- Files changed: `src/daemon/index.ts` (new), `src/daemon/systemd.ts` (new), `src/daemon/cron.ts` (new), `src/daemon/cron.test.ts` (new), `src/daemon/systemd.test.ts` (new), `src/cli.ts`, `src/pipeline/run.ts`, `package.json`, `README.md`
- Versions: 0.3.0 (feature), 0.3.1 (npm tarball fix), 0.3.2 (WSL user-bus fix)

## Related

- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- [fetch-timeout-safety](/vault/patterns/fetch-timeout-safety-2140b459/)
- [llm-wiki-ingestion](/vault/patterns/llm-wiki-ingestion-0393252f/)
- security-audit-patch
- [mcp-config-path-mismatch](/vault/gotchas/mcp-config-path-mismatch-547b6bfb/)

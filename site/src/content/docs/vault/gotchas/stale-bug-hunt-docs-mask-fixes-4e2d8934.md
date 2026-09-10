---
title: "stale-bug-hunt-docs-mask-fixes"
description: "Gotcha distilled by vir from a Claude Code session on 2026-07-30. Two repos (`vir` CLI at 0.12.0 local / 0.11.2 npm; `vir-obsidian` plugin at 0.2.0) audited in parallel with comprehensiv"
editUrl: false
---

:::note[Written by vir, not by a human]
**Gotcha** · session `4e2d8934` · 2026-07-30 · classifier confidence 0.78
:::

## Summary

Two repos (`vir` CLI at 0.12.0 local / 0.11.2 npm; `vir-obsidian` plugin at 0.2.0) audited in parallel with comprehensive evidence-based reporting. The CLI has a critical unfixed data-integrity bug (dry-run flag ignored during rewrite), four previously-suspected "still-open" bug-hunt items confirmed already-fixed, and 34 open todo items (mostly thesis chapters + npm publish action). The plugin is versionally-coherent and release-ready with 9 open items (mostly housekeeping + GH Actions overdue by 8 weeks). Minor type-contract drift persists (`project` nullability and error kind typing), but no breaking changes. Highest blast radius: CLI finding #4 (rewrite-only mutates vault despite dry-run flag) — unverified in prior audits, now confirmed live.

## What Was Learned

- **Evidence-based auditing catches stale docs.** The CLI's `bug-hunt-2026-07.md` claims 9 high-severity unfixed items; four were already resolved in 0.11.2/0.12.0 but the doc wasn't updated. Cross-referencing commit messages and CLAUDE.md conventions against git log proved these fixes real.
- **Type contracts diverge silently at JSON boundaries.** The CLI's `src/output/json.ts` and plugin's `src/types.ts` are hand-mirrored with three specific mismatches (`project` nullability, `date` optionality, `ollama.model` nullability, `kind` typing). All runtime-safe but fragile; a shared npm package would be better than manual synchronization.
- **Dry-run is a dangerous flag to implement conditionally.** The `--rewrite-only --dry-run` combination completely ignores the dryRun guard (line 229 checks only apply to other phases, rewriteOnly block at :157–207 has no dryRun gate). The flag's entire value proposition is "don't mutate," and it silently breaks for this subcommand.
- **Obsidian plugins use a different distribution model.** No npm registry, no `package-lock.json` equivalence; instead, versioning via manifest.json/versions.json and distribution through GitHub releases + community plugin list. The audit needed to verify three separate version sources (package.json, manifest.json, versions.json) all agree.
- **Lightweight tags are a hygiene debt but safe if already-remote.** Both repos have a few lightweight tags (`0.1.2`, `v0.1.0-rc.1`); they should be annotated per convention but pose no release risk since they're already pushed — cosmetic cleanup only.
- **Overdue GH Actions versions are rising-probability time bombs.** The plugin's `release.yml` is pinned to `@v4` (due for bump to `@v5` since 2026-06-02, ~8 weeks ago). The automation still works but could break silently on the next tag-push when GitHub deprecates Node versions — caught before it causes an actual release failure.

## Context
- **project:** vir
- **category:** gotcha
- **date:** 2026-07-30T10:46:40.305Z

## Related

- [silent-failure class unfinished](/vault/gotchas/silent-failure-class-unfinished-7bfa9706/)
- [parser-fallback-robustness](/vault/decisions/parser-fallback-robustness-67301cf4/)
- [time-window selection resolves schema tension](/vault/decisions/time-window-selection-resolves-schema-tension-3745b31b/)
- security-audit-patch
- [search-result-filtering](/vault/gotchas/search-result-filtering-01e12b99/)

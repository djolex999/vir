---
title: "thesis-as-launch-launchpad"
description: "Decision distilled by vir from a Claude Code session on 2026-07-06. Extended debugging/hardening session on the vir CLI and Obsidian plugin: full codebase audits, parallel bug-hunt agents,"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `395d2f80` · 2026-07-06 · classifier confidence 0.92
:::

## Summary
Extended debugging/hardening session on the vir CLI and Obsidian plugin: full codebase audits, parallel bug-hunt agents, and TDD'd fixes for real data-corrupting bugs (slug drift, dead wikilinks, scrubber false positives, config-wipe on re-init), released as v0.11.2 and v0.12.0. Also produced a fresh strategic roadmap (thesis-as-launchpad sequencing) and closed the session with a full `/sync` bookkeeping pass.

## What Was Learned
- **Slug/path reconstruction must have one source of truth.** Any module that independently rebuilds a derived filename (from topic+sessionId, etc.) will drift from the module that originally wrote it — even if copied byte-identical, it will silently diverge over time. Fix pattern: extract to one dependency-free module (e.g. `pipeline/slug.ts`) that all consumers import.
- **LLM-guessed cross-references are structurally dead links.** Asking a model to name "related" items it cannot see about content outside its context window produces near-100% unresolvable references. Any model-emitted pointer to an external entity (file, note, ID, URL) needs a resolution/grounding step against real data before being persisted — e.g., replace LLM-guessed wikilinks with embedding-neighbor lookups against the actual index.
- **"No row" and "dead row" look identical from outside a filtered query.** Before concluding a record is orphaned/missing, query the raw table unfiltered — a row may exist in an error/empty state that live-data filters correctly exclude, and repairing it in place is far cheaper (and safer) than assuming it needs full re-processing (which can cost real money via paid API calls).
- **Fresh live metrics beat cached assumptions before big strategic docs.** Re-measuring actual npm downloads/GitHub stars revealed the previous roadmap's traction numbers were stale/inflated; always re-verify before committing to a repositioning strategy.
- Parallelizing multiple read-only audit/bug-hunt subagents across independent code areas, then personally re-verifying every high-severity claim against source before reporting, caught issues faster and avoided false positives from any single agent's analysis.
- End-of-session `/sync` (CLAUDE.md diff+confirm, overwritten handoff.md, mutable todo.md, append-only lessons.md) is a reusable discipline for keeping multi-session agentic work legible.

## Context (project: vir, category: decision, date: 2026-07-06T19:44:43.613Z)
Session covered: saving a strategy doc, brainstorming and writing a new thesis-aware roadmap (v6), full CLAUDE.md-vs-code and VirQueryResult drift audits, a four-agent parallel bug hunt with independent verification, TDD fixes for slug drift / dead wikilinks / scrubber false positives / init config wipe (shipped as v0.11.2), a follow-up embedding-neighbor Related-links redesign (shipped as v0.12.0, unpublished to npm pending manual `npm publish`), live-vault data repair (deleted 5 stale duplicate notes, adopted 2 orphaned-row notes), and a full `context-sync` pass updating CLAUDE.md, handoff.md, todo.md, and lessons.md.

## Related

- [readme-restructure-badges](/vault/decisions/readme-restructure-badges-b71e2ae1/)
- [exit-code-propagation-strategy](/vault/decisions/exit-code-propagation-strategy-1d4fa0af/)
- [mcp-tools-architecture](/vault/decisions/mcp-tools-architecture-953519c3/)
- [active-learning-review-loop](/vault/patterns/active-learning-review-loop-f41385ca/)
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)

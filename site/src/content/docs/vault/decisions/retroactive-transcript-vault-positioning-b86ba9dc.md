---
title: "retroactive-transcript-vault-positioning"
description: "Decision distilled by vir from a Claude Code session on 2026-09-02. This session designed and shipped a complete marketing/docs site for the \"vir\" CLI tool, driven through the full brainst"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `b86ba9dc` · 2026-09-02 · classifier confidence 0.92
:::

## Summary
This session designed and shipped a complete marketing/docs site for the "vir" CLI tool, driven through the full brainstorming → spec → plan → execution → finishing workflow, followed by extensive live iteration (branding, animation, dark mode, docs, deployment) directly on production. Key durable outcomes: a positioning strategy built from competitive research, an Astro+Preact site architecture with strict JS/quality budgets, and a set of hard-won operational lessons about worktrees, test scoping, and Vercel deployment quirks.

## What Was Learned

**Positioning & competitive research**
- Surveyed 8 AI-memory competitor sites (plur.ai, mem0.ai, letta.com, basicmemory.com, supermemory.ai, getzep.com, cognee.ai, byterover.dev) before finalizing positioning.
- Basic Memory (not plur.ai) is vir's real competitor — nearly identical stack (markdown/Obsidian/MCP/open-source), differentiated only by direction: Basic Memory writes forward, vir reads retroactively.
- "No benchmark here" as an explicit stance (rather than a gap) is more credible than fake/inflated metrics — state real, small, honestly-caveated numbers instead.
- Naming a strong competitor accurately and positively (not a teardown) is cheap credibility — visitors who know that competitor will otherwise leave to check.
- Kie.ai (an LLM provider) should be framed as a cheap testing/calibration option, never as the recommended path for production data — this became a cross-cutting documentation rule.

**Technical/architecture decisions**
- Astro + Preact islands (not React) for a mostly-static marketing page: React runtime alone was 57KB gz vs Preact's ~8KB, for identical component code — swap is a near-zero-cost decision when JS budget matters.
- Build-time data fetches (npm downloads, GitHub stars) must degrade to `null`/omitted on failure, never fail the build.
- Real measured numbers (test counts, session counts, costs) should be derived from actual system state (SQLite DB queries, `npm test`, `vir cost`) at ship time, not copied from stale docs — the README's own numbers were stale relative to reality.
- A build-time layout script (d3-force run once, JSON committed) can deliver a "live-looking" real-data graph with zero client-side simulation JS.
- When sampling real user data for public display (e.g., a vault-derived graph), explicitly filter out sensitive-sounding content (security-finding topic names) even if technically anonymous — screenshots by competitors/customers are a real risk.

**Process/workflow**
- Root-level test suites in a monorepo must explicitly exclude subproject dirs (`site/`) and worktree copies (`.claude/worktrees/`) or test counts silently balloon/drift.
- `site/node_modules` and lockfile state don't automatically exist across worktrees/checkouts — always verify `npm ci` succeeded before trusting local test/build results.
- Vercel: Root Directory must be set explicitly for subdirectory deploys; Analytics requires enabling in-dashboard AND a fresh deploy to activate; domain "Connect to environment" direction (apex vs www) must match the site's actual canonical convention.
- Touch/hover UI states (mouseenter + click both firing) is a classic double-tap-to-activate bug — build touch handling so first tap always activates, not toggles.
- `--force-with-lease` + rebase is the correct recovery path when a PR branch's now-superseded early commits conflict with an already-merged PR.

## Context (project: vir, category: decision, date: 2026-09-02T15:13:51.747Z)
Site shipped to production at **virwiki.dev**, including a `/docs` section (Starlight-based, 12 pages) and the marketing landing page, with brand assets updated (whirlpool → graph-spiral logo) across the CLI README, npm package, Obsidian plugin, and site. Spec: `docs/superpowers/specs/2026-09-02-website-design.md`. Related decisions: dark mode was added post-v1 (spec originally excluded it); Kie.ai provider documentation was retroactively reframed as testing-only across all docs surfaces.

## Related

- [queryable-retrieval-audit-trail](/vault/patterns/queryable-retrieval-audit-trail-a2bc5634/)
- [embedding-model-tradeoff-bundleable](/vault/decisions/embedding-model-tradeoff-bundleable-2608f39e/)
- [silent-failure class unfinished](/vault/gotchas/silent-failure-class-unfinished-7bfa9706/)
- ollama-probe-null-breaks-inference
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)

---
title: "retroactive-transcript-archaeology-differentiator"
description: "Decision distilled by vir from a Claude Code session on 2026-09-02. This session designed and shipped a full marketing/docs site for `vir` (an Obsidian-vault distillation tool for Claude C"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `b86ba9dc` · 2026-09-02 · classifier confidence 0.92
:::

## Summary
This session designed and shipped a full marketing/docs site for `vir` (an Obsidian-vault distillation tool for Claude Code sessions), positioned against competitors like Basic Memory and PLUR through brainstorming, spec-writing, and iterative implementation. It also rebranded the project's logo (whirlpool → vortex → graph-spiral), added dark mode, Starlight-based docs, and published a domain (virwiki.dev) and npm release — all within the same `vir` monorepo under `site/`.

## What Was Learned

**Positioning & content strategy**
- Competitive research (8 sites: plur.ai, mem0.ai, letta.com, basicmemory.com, supermemory.ai, getzep.com, cognee.ai, byterover.dev) revealed vir's real competitor is **Basic Memory**, not plur.ai — both are markdown/Obsidian/MCP tools, but vir is retroactive (reads existing transcripts) vs. Basic Memory's forward-only agent writes. This became vir's core differentiator.
- "There is no benchmark here" (stating measured, honest numbers instead of leaderboard claims) is a stronger trust signal than fake benchmarks; numbers must be *measured*, not estimated, before shipping a claim.
- Naming a strong competitor accurately and positively (not attacking) is cheap credibility — visitors who know the competitor will check anyway.
- Kie.ai should be framed as a cheap testing/calibration provider only, never as recommended for a production vault (third-party proxy risk).

**Technical decisions for the site**
- Stack: Astro (static) + Preact islands (not React — React added 50KB+ gzip vs. Preact's ~12KB total for the same components/hooks) + Tailwind 4 (CSS `@theme`, no `tailwind.config.ts`) + Starlight for docs, all inside `site/` in the main repo (not a separate repo) so it can read source-of-truth files like `package.json` version and `pipeline/writer.ts` frontmatter shape directly.
- Astro 7 requires Node ≥22.12; local dev needed `PATH=/opt/homebrew/bin:$PATH` since nvm's default was Node 20.
- Root `vitest.config.ts` needed explicit excludes (`site/**`, `.claude/**`) — otherwise the CLI's root test suite silently picked up the site's tests and stale worktree copies, corrupting reported test counts.
- Vercel deploy: set **Root Directory to `site/`**; framework auto-detects Astro; no monorepo tooling needed since `package.json#files` already whitelists only `dist` for npm.
- Wikilinks in vir's vault resolve by **file basename**, not by the `aliases` frontmatter field — important for any tooling that parses `links`.
- Build-time external stats (npm downloads, GitHub stars) should always have a try/catch fallback to `null` so a flaky API never breaks the build.
- Sample/demo content pulled from a real user vault must be scre

## Related

- [embedding-model-tradeoff-bundleable](/vault/decisions/embedding-model-tradeoff-bundleable-2608f39e/)
- [queryable-retrieval-audit-trail](/vault/patterns/queryable-retrieval-audit-trail-a2bc5634/)
- ollama-probe-null-breaks-inference
- [silent-failure class unfinished](/vault/gotchas/silent-failure-class-unfinished-7bfa9706/)
- [mirrored-sweep-for-new-entity-type](/vault/patterns/mirrored-sweep-for-new-entity-type-7415aa64/)

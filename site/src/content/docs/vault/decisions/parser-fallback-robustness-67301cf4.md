---
title: "parser-fallback-robustness"
description: "Decision distilled by vir from a Claude Code session on 2026-05-28. This session implemented `vir compose`, a new CLI command for the vir tool (v0.7.2) that synthesizes topic pages from re"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `67301cf4` · 2026-05-28 · classifier confidence 0.85
:::

## Summary

This session implemented `vir compose`, a new CLI command for the vir tool (v0.7.2) that synthesizes topic pages from related vault notes using embedding search and an LLM. The session followed strict TDD (RED→GREEN) throughout, and a live smoke test caught and fixed a latent bug: the Kie API provider returns errors as HTTP 200 with an in-body `{code, msg}` rather than a non-2xx status, causing silent empty notes and false cost records.

## What Was Learned

**`vir compose` architecture**: Pure builders (`composeSlug`, `composeRelPath`, `buildComposePrompt`, `parseComposeResponse`, `buildComposeFrontmatter`) live in `composer.ts` alongside orchestrators (`gatherSources`, `composeFromSources`). The orchestrators route through the existing `callLLM` cost chokepoint in `distiller.ts`. A separate `topics` SQLite table mirrors the `articles` table pattern. `writer.writeTopic` files the page; `buildQueryResults` filters topic notes from `vir query --json` for plugin enum compatibility.

**Kie in-body error contract**: Kie returns errors (402 insufficient credits, 429 rate limit, etc.) as **HTTP 200 with `{code, msg}` in the response body**, not a non-2xx status. `response.ok` is insufficient. The fix exports `kieResponseError(data)` which inspects the body and throws an `HttpError(code)` before reading `content`. The thrown 429 stays retryable via `isRetryable`. Without this guard, the pipeline silently produces empty notes and logs false costs.

**Empty-content guard**: After parsing LLM output, `composeFromSources` throws if `parsed.content.trim().length === 0`, preventing hollow topic pages from being filed when a provider returns nothing usable.

**Live testing reveals provider-contract bugs that mocked test suites can't catch**: All 147 tests passed and the dry-run worked, yet the first real compose produced an empty note. Only a real API call exposed the Kie 200+in-body-error pattern.

**Annotated tags on push**: Use `git push --follow-tags` to ride annotated tags to the remote. Verify with `git ls-remote --tags origin | grep <tag>` — the `^{}` dereference line confirms it's an annotated (not lightweight) tag.

**`config.topicsDir`**: Added with `z.string().min(1).default("topics")` so existing configs get the default without migration. `VaultWriter` uses `cfg.topicsDir ?? TOPICS_SUBDIR` and creates the directory on construction.

## Context

- project: vir
- category: decision
- date: 2026-05-28T01:46:27.572Z

## Related

- [tool-output-bounding-strategy](/vault/decisions/tool-output-bounding-strategy-7eef1373/)
- [exit-code-propagation-strategy](/vault/decisions/exit-code-propagation-strategy-1d4fa0af/)
- [mcp-tools-architecture](/vault/decisions/mcp-tools-architecture-953519c3/)
- [search-result-filtering](/vault/gotchas/search-result-filtering-01e12b99/)
- force-model override injection

---
title: "mcp-tools-architecture"
description: "Decision distilled by vir from a Claude Code session on 2026-05-20. This session made a series of incremental improvements to the `vir` CLI tool — a Claude Code session distiller — coverin"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `953519c3` · 2026-05-20 · classifier confidence 0.92
:::

## Summary

This session made a series of incremental improvements to the `vir` CLI tool — a Claude Code session distiller — covering a README rewrite, MCP server implementation, publish pipeline setup, and reliability/testing improvements. Work was shipped across versions `0.2.0` through `0.2.5`.

## What Was Learned

**MCP server implementation pattern:**
- `@modelcontextprotocol/sdk` v1.x uses `registerTool(name, { description, inputSchema }, cb)` where `inputSchema` is a Zod raw shape object, not a `z.object(...)` wrapper.
- In a stdio MCP server, **stdout is the JSON-RPC channel** — any `console.log` or UI output corrupts the protocol. All logs must go to `process.stderr`. Audit every module on the call path before reuse.
- `SearchHit` does not carry `category`/`project` metadata. These must be derived by parsing each note's YAML frontmatter from `hit.content`.
- `StateDb` opened with `{ readonly: true }` skips WAL pragma and migrations (both are writes) and requires `fileMustExist: true`. Suitable for the MCP server path.

**Provider-aware LLM client allocation:**
- Introduce `maybeAnthropicClient(cfg)` returning `Anthropic | null` — returns `null` when `provider === 'kie'`, since that path uses native fetch and never touches the SDK. Apply to all LLM callers, not just the distiller.
- `callLLM` should accept `Anthropic | null` with a guard before the Anthropic branch.

**Retry strategy scoping:**
- On the Kie path (`HttpError`), retry `429` plus transient `5xx` (`500/502/503/504`).
- On the Anthropic SDK path, retry `429` only — the SDK already retries `5xx` internally; adding it again causes double-retry.
- `isRetryable` should be exported so it can be unit tested.

**Vitest setup in a NodeNext TypeScript project:**
- Exclude `src/**/*.test.ts` from `tsconfig.json` so `tsc`/`npm run build` never emit test files to `dist/`.
- Import the unit under test with a `.js` extension (`./distiller.js`). Vitest resolves `.js` → `.ts` correctly.
- Vitest discovers tests via its own glob independently of `tsconfig`.

**npm publish with passkey 2FA:**
- Classic "Publish" tokens and the account-level "require 2FA for writes" toggle still throw `EOTP`.
- A **granular access token** with both "Read and write" permission **and** "Bypass two-factor authentication" checked is required for non-interactive publish from a shell.

**git tags and `--follow-tags`:**
- `git push --follow-tags` only pushes **annotated** tags (`git tag -a v0.2.x -m "message"`). Lightweight tags (`git tag v0.2.x`) are silently skipped.

**`npm pkg fix` warnings:**
- Two persistent publish warnings (`bin[vir]` name, `repository.url` normalization) are silenced by running `npm pkg fix` once and committing the result.

**Flexible project path resolution:**
- `sync-claude`'s `projectClaudePath(slug)` should check `~/projects/<slug>`, `~/projects/<slug>-*` (glob), `~/code/<slug>`, `~/dev/<slug>` in order, first existing wins. The resolved path should flow through to the dry-run plan heading so it's visible.

**Semantic search degradation:**
- `search()` checks `isOllamaAvailable()` live at query time. If Ollama is down, it silently falls back to TF-IDF. Diagnose by source scores: `~0.04` = TF-IDF, `~0.5+` = embeddings. Running `vir embed` is not enough — Ollama must be up when queries are made.

**MCP `claude mcp` registration:**
- `vir mcp install` should shell out to `claude mcp add --scope <scope> vir vir mcp` via `spawnSync` with an arg array (never shell string).
- The registered command (`vir mcp`) must resolve to the actual installed binary — `npm link` or publish + global reinstall is required for the MCP registration to use the latest code.
- `claude mcp list` shows health status; `✓ Connected` confirms the full handshake, not just registration.

## Context

- **Project:** vir
- **Category:** decision
- **Date:** 2026-05-20T05:52:05.767Z

## Related

- [tool-output-bounding-strategy](/vault/decisions/tool-output-bounding-strategy-7eef1373/)
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- security-audit-patch
- [cross-platform-daemon-abstraction](/vault/patterns/cross-platform-daemon-abstraction-6b95ade7/)

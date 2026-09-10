---
title: "api-provider-abstraction"
description: "Pattern distilled by vir from a Claude Code session on 2026-05-19. A complete `vir` CLI tool was built from scratch to distill Claude Code session transcripts into an Obsidian knowledge v"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `ef978932` · 2026-05-19 · classifier confidence 0.92
:::

## Summary

A complete `vir` CLI tool was built from scratch to distill Claude Code session transcripts into an Obsidian knowledge vault. The project went from empty directory to a published npm package (`@djolex999/vir-cli@0.1.1`) with 11 commands, a SQLite state cache, optional Ollama embeddings, and a macOS launchd daemon.

## What Was Learned

**Architecture pattern: two-model pipeline with confidence gate**
Use a fast/cheap model (Haiku) to classify and score sessions, then only call the expensive model (Sonnet) for sessions above a confidence threshold (`> 0.6`). This keeps costs proportional to signal density.

**SQLite additive migrations via `PRAGMA table_info`**
SQLite has no `ADD COLUMN IF NOT EXISTS`. The idiomatic equivalent: read `PRAGMA table_info(table)`, build a set of existing column names, then `ALTER TABLE ADD COLUMN` only for missing ones. Run this in every constructor call — it's safe and idempotent on existing DBs.

**Kie.ai API is Anthropic-SDK-compatible via `baseURL` override**
The Anthropic SDK accepts a `baseURL` constructor option. For Kie.ai: `new Anthropic({ apiKey: kieApiKey, baseURL: 'https://api.kie.ai', defaultHeaders: { Authorization: 'Bearer ...' } })`. Model names must have the trailing `-YYYYMMDD` date suffix stripped; a canonical-prefix collapse (`startsWith('claude-haiku-4-5')`) is more robust than a date-regex.

**Model normalization: canonical-prefix collapse beats date-strip regex**
A stale config value like `claude-haiku-4-5-v1messages` (endpoint fragment leaked in) would survive a date-strip regex. A prefix-collapse that forces anything starting with a known canonical model string back to the bare ID handles all corruption cases, with date-strip as a fallback for anything else.

**Rate-limit handling: sequential + delay + exponential retry**
Avoid `Promise.all` on LLM calls. Use `for...of` with `await`, a 2s post-distill `setTimeout`, and a `withRateLimitRetry()` wrapper that catches `status === 429` and retries with `[60s, 120s, 240s]` backoff. Wrap both the classify and distill calls.

**`--rewrite-only` flag: store content in SQLite to enable free re-renders**
Persist `content`, `category`, `topic`, `project`, `confidence`, `startedAt` alongside the file hash. A `--rewrite-only` flag can then re-render all notes from SQLite with zero API calls — valuable whenever you change the writer (wikilink format, frontmatter shape, etc.).

**Writer-injects wikilinks; model writes plain text**
The distiller prompt asks for Related items in plain English. The writer's `wikilinkRelated()` function post-processes the `## Related` section, converting each `- item` to `- kebab-item`. This keeps the prompt simple and avoids model drift on wikilink syntax.

**Single `kebab()` source of truth for slugs**
Every slug — file names, wikilink targets, project index keys — must derive from the same `kebab()` function. A copy in `db.ts` (named `kebabLite`) avoids an import cycle with `writer.ts`, but must stay byte-identical to the exported one.

**Ollama availability probe should be process-cached**
A naive probe on every `write()` call would ping `/api/tags` hundreds of times during a `--full` run. Cache the result in a module-level variable after the first check (`isOllamaAvailableCached`). Embedding failures must never fail the write — always `try/catch` and swallow.

**ANSI codes break naive `string.length` in box-drawing**
A box drawn with `'─'.repeat(width - visible_content_length)` is wrong when `visible_content_length` is calculated via `.length` on a chalk-colored string. Strip ANSI escape sequences before measuring: `/\x1b\[[0-9;]*m/g`.

**Cost confirmation belongs after scan, before API calls**
The `onConfirm` callback fires after `scanSessions` and `isProcessed` filtering, so it receives the accurate new-session count. Placing it before the scan would require scanning twice; placing it inside the loop would prompt per-session.

**`spawnSync` over `exec` for all system calls**
`exec('launchctl load ' + plistPath)` is a shell-injection risk if path contains spaces or metacharacters. Use `spawnSync('launchctl', ['load', plistPath], { stdio: 'ignore' })` — no shell, no injection surface. Same for `osascript`: escape `\` then `"` for AppleScript string literals, pass as a single `-e` argument.

**`npm link` doesn't overwrite across a package name change**
Renaming from `vir-cli` to `@djolex999/vir-cli` left the old symlink at `~/.nvm/.../bin/vir`. `npm link` errored with `EEXIST`. Fix: `npm unlink -g vir-cli` first, then `npm link`.

**Scoped npm packages need `--access=public` on first publish**
`npm publish` on a scoped package (`@scope/name`) defaults to private access. Without `--access=public` on the first publish, npm returns `402 Payment Required`. Subsequent publishes inherit the access level and don't need the flag.

**`npm view` reflects CDN cache, not registry truth**
After publishing `0.1.1`, `npm view @scope/pkg version` still returned `0.1.0` for several minutes. Bypass with `npm view @scope/pkg@0.1.1 version --registry=https://registry.npmjs.org/`.

## Context

- **Project:** vir
- **Category:** pattern
- **Date:** 2026-05-19T00:18:09.961Z

## Related

- server-auth-boilerplate
- parallel-data-fetching
- multi-api-integration-architecture
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- [parser-fallback-robustness](/vault/decisions/parser-fallback-robustness-67301cf4/)

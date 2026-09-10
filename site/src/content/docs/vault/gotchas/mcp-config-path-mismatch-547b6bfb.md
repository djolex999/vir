---
title: "mcp-config-path-mismatch"
description: "Gotcha distilled by vir from a Claude Code session on 2026-05-22. Installing a Claude Code MCP server via npm does not auto-register it — explicit registration via `claude mcp add` is re"
editUrl: false
---

:::note[Written by vir, not by a human]
**Gotcha** · session `547b6bfb` · 2026-05-22 · classifier confidence 0.92
:::

## Summary

Installing a Claude Code MCP server via npm does not auto-register it — explicit registration via `claude mcp add` is required. The `vir` project's docs pointed users to a non-existent config path, making the server invisible despite a successful install.

## What Was Learned

**Claude Code never reads `~/.claude/claude_desktop_config.json`** — that path doesn't exist in any real config lookup. It's a confused mashup of two separate products:
- Claude **Desktop** config: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Claude **Code** config: `~/.claude.json` (managed via `claude mcp add`)

**MCP servers must be explicitly registered.** No auto-discovery from installed npm packages. The correct install + register flow for Claude Code:

```bash
npm install -g vir
claude mcp add --scope user vir -- vir mcp   # user scope = all projects
```

**Three registration scopes exist:**

| Scope | Location | Visibility |
|-------|----------|------------|
| `local` (default) | `~/.claude.json`, project-keyed | You, this project |
| `user` | `~/.claude.json`, global section | You, all projects |
| `project` | `.mcp.json` in repo root | All repo collaborators |

**Newly registered servers only appear in new sessions** — the currently running Claude Code session won't pick them up.

## Context

- **Project:** vir
- **Category:** gotcha
- **Date:** 2026-05-22T01:15:12.361Z

## Related

- pnpm-filter-run-keyword
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- pre-scaffold-state
- server-auth-boilerplate
- duplicate-subscription-prevention

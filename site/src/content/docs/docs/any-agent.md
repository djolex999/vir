---
title: Any agent
description: Install the vir skill so Claude Code, Codex, Cursor and other skill-aware agents check your notes before they work.
---

vir ships an [Agent Skills](https://agentskills.io) skill. It teaches an agent to look up what you already decided before it starts: search your notes, cite the ones it uses, and check them against the current code.

```bash
npx skills add djolex999/vir
```

It works with any tool that supports the Agent Skills standard, including Claude Code, Codex and Cursor.

## What the agent does with it

It uses the first of these that works:

1. **The MCP server**, if registered (`vir mcp install`, or `vir mcp install --target codex` for Codex). It calls `vir_query` with `synthesize: false`, so there's no LLM cost; the agent reads the matching notes itself.
2. **The CLI**: `vir query "<question>" --json --limit 5`. Retrieval only, no LLM call.
3. **Your notes folder**, read directly, using the path in `~/.vir/config.json`.

If none is available, it says vir isn't set up and carries on.

## What it won't do

The skill is read-only. It never writes, edits or deletes notes, never runs commands that cost money or change state (`vir run`, `vir connect`, `vir sync-claude`, `vir review` and the like) unless you ask, and never installs vir on its own; it shows you the install commands instead.

A test in the vir repo checks every command, flag and MCP tool the skill names against the real CLI, so a renamed flag fails CI instead of breaking installed copies. Source: [`skills/vir/SKILL.md`](https://github.com/djolex999/vir/blob/main/skills/vir/SKILL.md).

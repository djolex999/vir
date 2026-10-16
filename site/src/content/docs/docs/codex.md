---
title: Codex
description: Distill Codex sessions alongside Claude Code, optionally on your ChatGPT plan with no API key, and let Codex query your notes over MCP.
---

Since 0.26, vir reads Codex sessions too: the CLI, the IDE extension and the desktop app all write rollouts to `~/.codex/sessions/`. They go through the same filter, classify and distill steps as Claude Code sessions and land in the same notes.

## Turn it on

```bash
vir init
```

The wizard asks which coding agents you use and pre-checks the ones whose sessions it finds. Tick Codex and accept `~/.codex/sessions`. On an existing install you can instead add one key to `~/.vir/config.json`:

```json
{ "codexSessionsDir": "~/.codex/sessions" }
```

New Codex projects start **undecided**, so nothing is spent until you include them. Codex sessions run larger than Claude Code's; look at the estimate first:

```bash
vir run --dry-run
vir projects include <name>
```

## What vir reads, and what it skips

Codex stores its own context as if you'd typed it: environment details, AGENTS.md, open IDE tabs, attached files, browser state. vir strips that and keeps only your request. When an IDE or file wrapper carries `## My request for Codex:`, only the text after it counts.

| Skipped as | What it is |
| --- | --- |
| `sidechain-transcript` | Subagent threads and review (guardian) threads |
| `agent-transcript` | Headless `codex exec` runs, including vir's own if any ever got through |
| `project-pending` / `project-excluded` | Projects you haven't included, or excluded |

**Projects** are named by the folder the session started in, exactly as for Claude Code, so a repo you use from both agents is one project. Worktrees under `<repo>/.claude/worktrees/` count as the repo. Desktop chats started outside a repo (`~/Documents/Codex/…`) are grouped as one `codex-scratch` project.

**Archived threads are not read.** vir reads `~/.codex/sessions/` only, and archiving a thread moves it to `~/.codex/archived_sessions/`. Codex doesn't prune its rollouts, so there's no deadline like Claude Code's 30 days.

## Distill on your ChatGPT plan: `codex-cli`

With `provider: "codex-cli"` vir distills through your installed `codex` binary on your ChatGPT login: no API key, no per-session dollars. It's **experimental**. Every distill uses your Codex usage limits, so the same rules as `claude-cli` apply: at most 25 sessions per run, an immediate halt at a usage limit, and calls logged with cost marked not-applicable.

Codex picks the model; `vir init` sets `models.classify` and `models.distill` to `"default"`. Put a model id there to pin one. Each call carries about 16–19k tokens of Codex's own preamble, which counts against your limits.

A distill prompt carries transcript text vir doesn't control, and `codex exec` is an agent with tools. So every call runs:

- **read-only and ephemeral**, so no rollout is written and vir never distills its own calls;
- **with Codex's tools switched off**: no shell, no web search, no apps or plugins, no MCP servers, no subagents;
- **from a neutral folder** (`~/.vir`), so no project's AGENTS.md is loaded. Your global `~/.codex/AGENTS.md` still is, the same way `claude-cli` loads `~/.claude/CLAUDE.md`.

These switches are checked against codex-cli 0.160.1. A Codex version that doesn't recognize one of them makes the call fail with a "run `codex update`" message instead of running with tools vir hasn't checked. `vir doctor` checks `codex login status`.

## Let Codex query your notes (MCP)

```bash
vir mcp install --target codex
```

vir never edits Codex's config itself. This prints the block to add to `~/.codex/config.toml`:

```toml
[mcp_servers.vir]
command = "vir"
args = ["mcp"]
```

Or run `codex mcp add vir -- vir mcp`. Restart Codex. It asks before each vir tool call; choose "Always allow" to stop the prompts. The tools are the same six as for Claude Code ([Retrieval and MCP](/docs/retrieval/#mcp-your-agent-asks-the-vault-itself)). Headless `codex exec` never approves tool calls, so the tools only work in interactive Codex.

## AGENTS.md

`vir sync-claude` also writes the vir block into AGENTS.md files that already exist: `~/.codex/AGENTS.md` and project roots. See [Keeping it current](/docs/keeping-it-current/#back-into-claudemd-and-agentsmd).

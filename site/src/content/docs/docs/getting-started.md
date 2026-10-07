---
title: Getting started
description: Install vir, point it at your vault, and turn months of Claude Code and Codex history into notes in one run.
---

vir reads the transcripts Claude Code and Codex already keep on your disk and writes typed markdown notes into a folder you own. This page gets you from nothing to a populated vault.

## Prerequisites

- macOS or Linux. Windows is not supported yet.
- Node.js 20 or newer.
- Claude Code (sessions under `~/.claude/projects/`), Codex (sessions under `~/.codex/sessions/`), or both.
- A folder for the notes. `vir init` suggests your Obsidian vault if it finds one, otherwise `~/notes`. The output is plain markdown either way; Obsidian is where the graph and the plugin live.
- One distill provider (you choose during `vir init`):
  - **Anthropic API key** — predictable per-session cost, no effect on your Claude Code limits.
  - **Your Claude Code subscription** (`claude-cli`) — free and keyless; distills consume your Claude Code usage quota.
  - **Kie.ai API key** — a third-party proxy at roughly 28% of Anthropic list price. Used for cheap testing and calibration runs; not recommended for your real vault.
  - **Your ChatGPT plan** (`codex-cli`, experimental) — keyless, through the Codex CLI; distills consume your Codex usage limits. See [Codex](/docs/codex/).

Semantic search is optional. Without an embedding provider vir falls back to keyword search and says so.

## Install

```bash
npm install -g @djolex999/vir-cli
vir init
```

`vir init` is an arrow-key wizard: which coding agents you use, provider, models, vault path. It also shows you every project it found, with session counts, and asks which to include. Undecided projects stay visibly undecided — vir never silently includes or excludes.

## First run

Preview the cost before spending anything:

```bash
vir run --dry-run
```

This scans, filters, and prints a per-session estimate, then exits before any API call. When the number looks right:

```bash
vir run
```

vir asks for confirmation if more than 20 new sessions are queued. To start small, `vir run --since 14d` processes only the last two weeks; a later plain `vir run` backfills the rest. The first pass over a few months of history typically costs $1–$5 on the Anthropic API, or nothing on a Claude subscription.

## What you'll see

Open your vault. Under `<vault>/vir/` you'll find:

```
vir/
  index.md       # catalog of every note
  log.md         # what each run did
  patterns/      # reusable approaches worth repeating
  gotchas/       # bugs, footguns, edge cases
  decisions/     # architecture decisions with rationale
  tools/         # per-tool knowledge
```

Every note has frontmatter (`topic`, `category`, `project`, `session_id`, `date`, `confidence`), wikilinks to its project and category, and a `## Related` section linking to its nearest neighbors. Open Obsidian's graph view — the notes are already connected.

## Keep it current

When the output looks good, register the daemon:

```bash
vir schedule install
```

On macOS this loads a launchd agent; on Linux a systemd user timer, or a crontab entry if systemd isn't available. It runs `vir run` every 3 hours (configurable) and never prompts.

## Next

- [How it works](/docs/how-it-works/) — what gets filtered, what a note is made of.
- [Retrieval and MCP](/docs/retrieval/) — ask the vault, or let your agent ask it mid-session.
- [Providers and cost](/docs/providers-and-cost/) — the four providers and what they cost.
- [Codex](/docs/codex/) — Codex sessions, the keyless `codex-cli` provider, and Codex over MCP.

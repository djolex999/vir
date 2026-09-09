---
title: vir documentation
description: Everything about vir — installing it, what it writes, how retrieval works, what it costs, and every command.
tableOfContents: false
---

vir reads the Claude Code transcripts already on your disk, filters out what isn't yours, and writes typed markdown notes into an Obsidian vault. It's a CLI, an MCP server, and an Obsidian plugin. Nothing is hosted.

New here? **[Getting started](/docs/getting-started/)** takes about five minutes.

## Start

| | |
| --- | --- |
| **[Getting started](/docs/getting-started/)** | Prerequisites, install, your first run, and what appears in the vault |
| **[How it works](/docs/how-it-works/)** | The pipeline, what gets filtered and why, the anatomy of a note, and the quality controls |
| **[Inputs](/docs/inputs/)** | The three sources: Claude Code sessions, clipped web articles, PDFs |

## Use it

| | |
| --- | --- |
| **[Retrieval and MCP](/docs/retrieval/)** | `vir query`, embedding providers, and letting Claude Code consult the vault mid-session |
| **[Keeping it current](/docs/keeping-it-current/)** | The daemon, `sync-claude`, review, lint, dedupe, and syntheses |
| **[Commands](/docs/commands/)** | Every subcommand, with what it costs |

## Configure it

| | |
| --- | --- |
| **[Providers and cost](/docs/providers-and-cost/)** | The three distill providers, measured spend, hybrid routing, and every cost control |
| **[Configuration](/docs/configuration/)** | Every key in `~/.vir/config.json`, with defaults |
| **[Obsidian plugin](/docs/obsidian-plugin/)** | The sidebar: recent notes, related notes, daemon health |

## When something's off

| | |
| --- | --- |
| **[Troubleshooting](/docs/troubleshooting/)** | Start with `vir doctor`, then the failures people actually hit |
| **[Privacy](/docs/privacy/)** | What leaves your machine, what stays, and what you can turn off |
| **[Changelog](/docs/changelog/)** | Every release, newest first |

## Elsewhere

[GitHub](https://github.com/djolex999/vir) · [npm](https://www.npmjs.com/package/@djolex999/vir-cli) · [Obsidian plugin](https://github.com/djolex999/vir-obsidian) · [Report an issue](https://github.com/djolex999/vir/issues)

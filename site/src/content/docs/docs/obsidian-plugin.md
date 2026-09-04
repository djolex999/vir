---
title: Obsidian plugin
description: vir-obsidian brings the vault into Obsidian's sidebar — recent notes, related notes for what you're editing, and a daemon health dot.
---

[vir-obsidian](https://github.com/djolex999/vir-obsidian) is a separate, open-source plugin. The CLI works without it; the plugin makes the vault feel native.

## What it does

- **Status bar** — a health dot for the daemon: healthy, stale, down, or CLI not found. Click it to open settings.
- **Recent tab** — every vir-distilled note in the vault, newest first, color-coded by category: patterns, gotchas, decisions, tools, articles, PDFs, topic pages.
- **Related tab** — runs `vir query` against the note you're editing and surfaces what's relevant, so the right note finds you while you're writing.
- **Search** — a command palette entry for `vir query` with results as clickable notes.
- Low-confidence notes render dimmer.

## Install

The plugin shells out to the `vir` binary, so install the CLI first.

1. Obsidian → Settings → Community plugins → Browse → search **Vir**, or install manually from the [releases page](https://github.com/djolex999/vir-obsidian/releases).
2. Enable it. If the status dot says *CLI not found*, set the binary path in the plugin settings (`which vir` prints it).

Desktop only — the plugin needs a shell, which Obsidian mobile doesn't provide.

## How it talks to vir

Two stable JSON contracts: `vir query --json` for results and `vir doctor --json` for health. Both are versioned with the CLI; a CLI upgrade never breaks a plugin render without a matching plugin release.

---
title: Privacy
description: What leaves your machine, what stays, and what you can turn off.
---

## What leaves

**Transcript content goes to your distill provider.** Classification and distillation are model calls, so the text of a session — after scrubbing — is sent to whichever provider you configured:

- `anthropic` → Anthropic's API, under your key and their data policy.
- `claude-cli` → your own Claude Code subscription, through the `claude` binary, same as an interactive session.
- `kie` → Kie.ai, a third-party proxy. It's supported for cheap test runs; for a vault you rely on, prefer `anthropic` or `claude-cli` so transcripts go only to Anthropic.

Before sending, vir strips API keys, bearer tokens, absolute filesystem paths, and email addresses. It cannot recognize every secret; if a session contains something you'd never paste into a chat, exclude that project.

**Clipped articles and PDFs** likewise go to the provider when their phase runs.

## What stays

- The vault. Plain markdown on your disk.
- `~/.vir/vir.db` — hashes, note content, embeddings.
- `~/.vir/cost.log`, `daemon.log`, `queries.jsonl`.
- Embeddings, when you use `ollama` or `local` — computed on your machine.

vir has no server, no account, and no telemetry. Nothing phones home. Uninstall it and the vault is still yours.

## What you control

| Concern | Knob |
| --- | --- |
| Which projects are ever read | `vir projects exclude <name>`, or `--only` / `--exclude-project` per run |
| Tooling transcripts (subagents, workflows, SDK agents) | Excluded by default |
| Retrieval logging | `"logQueries": false` |
| Desktop notifications | `"notifications": false` |
| What reaches CLAUDE.md | Nothing without a diff and your confirmation (`vir sync-claude`) |
| MCP exposure | Read-only server; `vir mcp uninstall` removes it |

## The website

virwiki.dev runs Vercel's cookie-less Web Analytics and nothing else. The graph on the landing page is a sample of the author's own vault — topic names only.

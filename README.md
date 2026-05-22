<p align="center">
  <img src="assets/vir_whirlpool_logo.svg" width="200" height="200" alt="vir logo">
</p>

<h1 align="center">vir</h1>

<p align="center">
  Distills Claude Code sessions into a compounding knowledge vault.
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/@djolex999/vir-cli" alt="npm version">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license">
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="platform">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="node">
</p>

## Demo

<!-- add terminal screenshot here -->

## What it does

Every Claude Code session produces patterns, gotchas, and architecture
decisions — and 95% of it sits in JSONL transcripts you never open again.

Vir is a local macOS daemon that runs on a schedule, distills your sessions
into structured markdown in your Obsidian vault, and feeds that knowledge back
into your `CLAUDE.md` files. Every future session starts sharper than the last.

Inspired by Andrej Karpathy's LLM Wiki pattern and Uros Pesic's KB Brain concept.

## Why Vir?

Vir (вир) is the Serbian word for whirlpool — the place where a river pulls
everything in and concentrates it. That is exactly what this tool does.
Sessions flow in, Vir pulls out what matters, and deposits it somewhere
permanent.

The name felt right for a tool whose job is to take the chaos of a Claude Code
session and find the still point at the center.

## The loop

```
Claude Code sessions
      ↓
     vir
      ↓
Obsidian vault
      ↓
  CLAUDE.md
      ↓
better sessions
      ↓
     ...
```

## After one night

Real output from the author's first run across 226 Claude Code sessions.

| Metric | Value |
|---|---|
| Sessions scanned | 226 |
| Notes distilled | 126 |
| Avg confidence | 0.91 |
| High signal (≥0.8) | 121 of 126 |
| Projects covered | 8 projects |
| Knowledge breakdown | 54 patterns · 47 decisions · 23 gotchas · 2 tools |

Example query against the distilled vault:

```bash
$ vir query "what gotchas should I know about my auth implementation"
```
Based on the notes, here are the key auth gotchas:

JWT dual-token setup needs silent refresh on mount — access tokens
expire in 15 min. Without a mount-time refresh check, users hit
401s on first load after a break.
Middleware runs before the session is hydrated — do not read
session data in middleware to gate routes. Check the JWT directly
from the cookie instead.
Password reset tokens must be single-use and hashed at rest —
storing raw tokens in the DB leaks them if the DB is compromised.
Hash with bcrypt before storing, compare on redemption.
OAuth callback URLs must be registered exactly — trailing slashes,
http vs https, and localhost port mismatches all cause silent
redirect failures with no useful error message.
Logout must clear both the access token cookie and the refresh
token — clearing only one leaves the session partially alive and
causes confusing re-auth loops.

sources 4  ·  via embedding  ·  searched 126

## Prerequisites

- macOS (launchd daemon)
- Node.js 18+
- Claude Code (sessions at `~/.claude/projects/`)
- Obsidian vault
- Anthropic API key **or** Kie.ai API key (~72% cheaper, same models)
- Optional: Ollama + `nomic-embed-text` for semantic search

## Install

```bash
npm install -g @djolex999/vir-cli
```

## Quick start

```bash
vir init
# ✓ guided setup wizard — pick provider, models, vault path, cadence
# ✓ writes ~/.vir/config.json

vir run
# scanning ~/.claude/projects … 214 files found · 0 cached · 214 new
# ✓ distilled 38 sessions → 51 notes written to your vault

vir schedule install
# ✓ launchd agent registered — vir now runs every 3h
```

## First run cost

Vir processes all historical Claude Code sessions on first run. Cost varies by
session depth:

- Simple sessions: ~$0.02 each
- Deep code reviews: up to ~$0.10 each
- Typical first run (200 sessions): $1–5 one-time

All subsequent runs process only new sessions: ~$0.05 per run.

> **Tip:** Use Kie.ai as provider during `vir init`
> for 72% cheaper API calls on the same Claude models.

Pass `--yes` to skip the cost confirmation prompt.

## Commands

| Command | Cost | Description |
|---|---|---|
| `vir init` | free | Interactive setup |
| `vir run` | cheap | Process new sessions |
| `vir run --full` | $$ | Reprocess all sessions |
| `vir run --rewrite-only` | free | Reformat notes, no API calls |
| `vir run --yes` | cheap | Skip cost confirmation |
| `vir query "<question>"` | cheap | Semantic search your vault |
| `vir summarize <project>` | cheap | Cross-session project synthesis |
| `vir summarize --all` | $$ | Summarize all projects |
| `vir lint` | cheap | Find orphans, stale notes, contradictions |
| `vir lint --orphans` | free | Orphan check only |
| `vir lint --stale` | free | Staleness check only |
| `vir lint --contradictions` | cheap | Contradiction check (Haiku) |
| `vir dedupe` | cheap | Interactive duplicate detection |
| `vir sync-claude` | free | Inject top knowledge into CLAUDE.md |
| `vir sync-claude --dry-run` | free | Preview changes, no writes |
| `vir sync-claude --force` | free | Apply without confirmation |
| `vir embed` | free | Generate embeddings for semantic search |
| `vir embed --force` | free | Regenerate all embeddings |
| `vir schedule install` | free | Register launchd daemon |
| `vir schedule uninstall` | free | Remove launchd daemon |
| `vir status` | free | Knowledge heatmap + daemon status |

## Semantic search (optional)

Vir uses TF-IDF by default. For semantic search via embeddings:

```bash
brew install ollama
ollama pull nomic-embed-text
ollama serve
```

Then in a new terminal:

```bash
vir embed
vir query "how do I handle rate limiting in Next.js"
```

Falls back to TF-IDF automatically if Ollama is not running.

## MCP server (Claude Code integration)

Vir runs as an MCP server, letting Claude Code consult your vault mid-session
instead of relying on static CLAUDE.md content.

Register Vir with Claude Code:

```bash
vir mcp install
```

Restart Claude Code. The vault is now queryable mid-session via four tools:
`vir_query`, `vir_status`, `vir_recent_notes`, `vir_project_summary`.

To unregister:

```bash
vir mcp uninstall
```

## Config reference

Located at `~/.vir/config.json`.

| Field | Default | Description |
|---|---|---|
| `vaultPath` | — | Absolute path to Obsidian vault |
| `outputDir` | `vir` | Subdir inside vault |
| `claudeProjectsDir` | `~/.claude/projects` | Claude Code sessions |
| `cadenceHours` | `3` | Daemon run frequency (hours) |
| `provider` | `anthropic` | `anthropic` or `kie` |
| `anthropicApiKey` | — | Required if `provider=anthropic` |
| `kieApiKey` | — | Required if `provider=kie` |
| `filterThreshold` | `0.4` | Heuristic pre-filter (0..1) |
| `models.classify` | `claude-haiku-4-5-20251001` | Classify model |
| `models.distill` | `claude-sonnet-4-6` | Distill model |

## Vault structure

```
vault/vir/
  index.md       # full catalog of every note Vir has written
  log.md         # chronological append log of each run
  patterns/      # reusable approaches worth repeating
  gotchas/       # bugs, footguns, and edge cases
  decisions/     # architecture decisions with their rationale
  tools/         # per-tool knowledge and usage notes
  projects/      # cross-session project summaries
  archived/      # deduplicated notes (kept, never deleted)
```

## State & logs

```
~/.vir/config.json   — configuration
~/.vir/vir.db        — SQLite (hashes, embeddings, content)
~/.vir/daemon.log    — daemon run log
```

## How it compares

| | Vir | mem0 | Manual notes |
|---|---|---|---|
| Source | Claude Code sessions | Any conversation | You |
| Output | Typed markdown vault | Key-value store | Anything |
| CLAUDE.md injection | ✓ | ✗ | Manual |
| Local / private | ✓ | ✗ | ✓ |
| Semantic search | ✓ (Ollama) | ✓ | ✗ |
| Cost | ~$0.05/run | Subscription | Free |

## Roadmap

- [ ] Windows/Linux support (cron fallback)
- [ ] GUI installer for non-developers
- [ ] Obsidian plugin for in-vault queries
- [ ] Export to anchor-plugin skill format
- [ ] Support for Cursor and other AI editors

## Contributing

PRs welcome. Open an issue first for large changes. Built with TypeScript
strict — run `npm run build` to check before submitting.

## Development

```bash
git clone https://github.com/djolex999/vir
cd vir
npm install
npm run build
npm test
```

Tests use Vitest. Run with `npm test` or `npm test -- --watch` for watch mode.

## License

MIT

## Author

Built by Djordje Marković / GrowthQ Lab DOO

[GitHub](https://github.com/djolex999) ·
[LinkedIn](https://www.linkedin.com/in/djmarkovic/) ·
[npm](https://www.npmjs.com/~djolex999) ·
[GrowthQ Lab](https://growthqlab.com)

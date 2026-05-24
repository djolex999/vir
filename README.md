<p align="center">
  <img src="assets/vir_whirlpool_logo.svg" width="200" height="200" alt="vir logo">
</p>

<h1 align="center">vir</h1>

<p align="center">
  An LLM Wiki for Claude Code, in your Obsidian vault.
</p>

<!--
GitHub topics (add manually: repo → About → ⚙ → Topics):
claude, claude-code, ai-memory, obsidian, knowledge-base, llm,
developer-tools, mcp, local-first, cross-platform, llm-wiki
-->

<p align="center">
  <a href="https://www.npmjs.com/package/@djolex999/vir-cli"><img src="https://img.shields.io/npm/v/@djolex999/vir-cli?color=7c6af7&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@djolex999/vir-cli"><img src="https://img.shields.io/npm/dw/@djolex999/vir-cli?color=4fd1a0" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22d3ee" alt="license"></a>
  <a href="#project-status"><img src="https://img.shields.io/badge/tests-79%20passing-22c55e" alt="tests"></a>
  <a href="#project-status"><img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-lightgrey" alt="platforms"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-server-c084fc" alt="mcp"></a>
  <a href="#"><img src="https://img.shields.io/badge/local--first-yes-f59e0b" alt="local-first"></a>
  <a href="https://github.com/djolex999/vir"><img src="https://img.shields.io/github/stars/djolex999/vir?style=social" alt="stars"></a>
</p>

## The pattern

Recently, Andrej Karpathy described a pattern he calls the **LLM Wiki** — AI work
that feeds back into itself through a persistent, curated, structured artifact,
instead of resetting at the end of every session. He ended his post with: _"I
think there is room here for an incredible new product instead of a hacky
collection of scripts."_

Vir is one implementation of that pattern, with Obsidian as the frontend.

> Vir reads two input sources today: Claude Code session transcripts (`.jsonl`)
> and web articles (markdown clipped via Obsidian Web Clipper). Both get
> distilled into the same vault. Future versions will add PDFs, code repos, and
> images — matching the full LLM Wiki pattern.

[Karpathy's post →](https://x.com/karpathy/status/2039805659525644595)

## Why this exists

Every Claude Code session produces patterns, gotchas, and architecture decisions.
Almost all of it ends up in `~/.claude/projects/**/*.jsonl` — transcripts you
open once and never again. The knowledge is real; the storage is a graveyard.

Vir reads those transcripts, distills the durable knowledge into typed markdown
notes in your Obsidian vault, and feeds the best of it back into your `CLAUDE.md`
files — so every future session starts sharper than the last. It's a concrete
implementation of [the pattern above](#the-pattern).

<p align="center">
  <img src="assets/demo.gif" width="800" alt="vir distilling Claude Code sessions into notes in an Obsidian vault">
</p>

## Quality controls

Auto-distilled notes can be wrong. The most common concern from early users:
_"if your distillations are wrong, Claude treats them as truth and you get worse
results, not better."_ Fair. Vir addresses it in layers:

- **Confidence scores on every note**, written into the frontmatter
  (`confidence: 0.xx`). A cheap heuristic pre-filter drops low-signal sessions
  before any LLM call; classification then scores what survives, and anything at
  or below `0.6` is dropped _before_ the more expensive distill step. Only
  high-confidence notes reach the vault.
- **Opt-in `CLAUDE.md` sync.** Nothing vir generates touches your prompt context
  automatically. `vir sync-claude` shows a diff and waits for your confirmation —
  you decide what reaches Claude.
- **Plain markdown output.** Every note is a file in your Obsidian vault. Read
  it, edit it, delete it. Nothing is hidden in a compressed database you can't
  inspect.
- **Lint and dedupe.** `vir lint` flags contradictions and stale notes;
  `vir dedupe` merges similar notes that have drifted apart.
- **Active learning** via `vir review`. Walk through new distillations and
  approve, edit, or reject each one. Verified notes get retrieval priority over
  unverified ones (in `vir query` and the MCP server). Rejected notes are moved
  to `.rejected/` — recoverable, not deleted.
- **MMR-diverse retrieval**. Queries return notes covering different aspects of
  the topic, not 5 similar duplicates. The retrieval algorithm balances
  relevance against diversity automatically.

The bet: with these controls, signal-to-noise stays high enough that the vault
is a net positive. If your discipline is strong enough to maintain `CLAUDE.md`
and `lessons.md` by hand, you may not need this. If — like most of us — you let
those files drift after the first week, Vir catches what slips through.

## How it works

Vir reads your transcripts from `~/.claude/projects/**/*.jsonl`, runs each
session through a cheap heuristic filter, classifies the survivors with Haiku,
and distills durable knowledge with Sonnet. Before distillation it **filters tool
calls** — preserving intent (file paths, commands, search patterns, errors, short
results) while truncating large embedded content (file writes, long bash logs,
big grep dumps) to keep token cost bounded (tunable via `filterToolCalls`).
Results are written as typed notes — patterns, gotchas, decisions, tools —
cross-linked with wikilinks and indexed. State lives in local SQLite; content
hashes make reruns idempotent. Optional Ollama embeddings power semantic search,
and an MCP server exposes the whole vault to Claude Code mid-session.

Web articles saved to a `raw/` directory (e.g. via Obsidian Web Clipper) flow
through a **parallel pipeline** with its own taxonomy — `concept`, `technique`,
`reference`, `opinion` — filed under `articles/` in the same vault, embedded and
indexed alongside session notes, and queryable through the same MCP tools.
Articles always keep their source URL in frontmatter for backlinks; distillation
paraphrases and never reproduces more than a short quote.

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

## How Vir compares

The AI memory space has grown fast. An honest comparison to the options worth
knowing about:

|                                     | Vir                             | claude-mem              | claude-memory              | mem0              |
| ----------------------------------- | ------------------------------- | ----------------------- | -------------------------- | ----------------- |
| Reads existing Claude Code sessions | ✓                               | from install forward    | from install forward       | n/a               |
| Markdown output (Obsidian-native)   | ✓                               | ChromaDB                | LanceDB                    | various backends  |
| MCP server                          | ✓                               | ✓                       | ✓                          | n/a               |
| Setup complexity                    | `npm install -g`                | Bun + Python + ChromaDB | pnpm + LM Studio + LanceDB | API/cloud setup   |
| Cross-platform daemon               | mac launchd, linux systemd/cron | mac, linux              | mac, linux                 | n/a               |
| Open source license                 | MIT                             | Apache 2.0              | MIT                        | open core + cloud |

**Different tools for different needs:**

- Want a heavyweight memory plugin with real-time capture and vector storage?
  Use **claude-mem**.
- Want sophisticated retrieval (MMR diversity, web dashboard, multi-phase
  maintenance)? Use **claude-memory**.
- Building AI applications that need to remember users long-term? Use **mem0** —
  it's infrastructure for apps.
- Want your Claude Code sessions distilled into markdown notes you can browse,
  edit, and own in Obsidian? Use **Vir**.

These aren't all competitors. mem0 is a different layer of the stack entirely.
claude-mem and claude-memory share the same input data as Vir but take different
opinions on storage and integration.

## Real-world results

Real output from the author's first run across 226 Claude Code sessions.

| Metric              | Value                                             |
| ------------------- | ------------------------------------------------- |
| Sessions scanned    | 226                                               |
| Notes distilled     | 126                                               |
| Avg confidence      | 0.91                                              |
| High signal (≥0.8)  | 121 of 126                                        |
| Projects covered    | 8 projects                                        |
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

sources 4 · via embedding · searched 126

## Prerequisites

- macOS or Linux (systemd or cron)
- Node.js 20+
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
vir init                 # guided wizard: provider, models, vault, cadence,
                         # and an optional web-articles (raw/) folder
vir run                  # one pass over your sessions → notes in your vault
vir schedule install     # register the daemon (runs every 3h by default)
```

`vir init` asks whether you save web articles to a folder (e.g. Obsidian Web
Clipper). Point it at that `raw/` directory and Vir distills those articles into
the same vault. Leave it blank to keep Vir session-only.

`vir schedule install` works on Linux too: systemd is preferred, with cron used
as a fallback when `systemctl` isn't available.

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

## Platform support

| Platform        | Daemon             | Notifications | Status       |
| --------------- | ------------------ | ------------- | ------------ |
| macOS           | launchd            | osascript     | Stable       |
| Linux (systemd) | systemd user timer | notify-send   | Experimental |
| Linux (cron)    | crontab            | notify-send   | Experimental |
| Windows         | Not supported      | —             | Planned      |

Linux support is **experimental and untested** — `vir schedule install` prefers
a systemd user timer and falls back to a crontab entry when systemd is absent.
Please report issues at
[github.com/djolex999/vir/issues](https://github.com/djolex999/vir/issues)
with your distro, init system, and Node version.

## Commands

| Command                     | Cost  | Description                               |
| --------------------------- | ----- | ----------------------------------------- |
| `vir init`                  | free  | Interactive setup                         |
| `vir run`                   | cheap | Process new sessions                      |
| `vir run --full`            | $$    | Reprocess all sessions                    |
| `vir run --rewrite-only`    | free  | Reformat notes, no API calls              |
| `vir run --articles-only`   | cheap | Distill only web articles, skip sessions  |
| `vir run --yes`             | cheap | Skip cost confirmation                    |
| `vir query "<question>"`    | cheap | Semantic search your vault                |
| `vir summarize <project>`   | cheap | Cross-session project synthesis           |
| `vir summarize --all`       | $$    | Summarize all projects                    |
| `vir lint`                  | cheap | Find orphans, stale notes, contradictions |
| `vir lint --orphans`        | free  | Orphan check only                         |
| `vir lint --stale`          | free  | Staleness check only                      |
| `vir lint --contradictions` | cheap | Contradiction check (Haiku)               |
| `vir dedupe`                | cheap | Interactive duplicate detection           |
| `vir review`                | free  | Walk new notes: approve/edit/reject       |
| `vir review --project <s>`  | free  | Review one project's notes                |
| `vir review --all`          | free  | Re-review, including verified notes        |
| `vir sync-claude`           | free  | Inject top knowledge into CLAUDE.md       |
| `vir sync-claude --dry-run` | free  | Preview changes, no writes                |
| `vir sync-claude --force`   | free  | Apply without confirmation                |
| `vir embed`                 | free  | Generate embeddings for semantic search   |
| `vir embed --force`         | free  | Regenerate all embeddings                 |
| `vir schedule install`      | free  | Register the background daemon            |
| `vir schedule uninstall`    | free  | Remove the background daemon              |
| `vir status`                | free  | Knowledge heatmap + daemon status         |
| `vir doctor`                | cheap | Diagnose installation issues              |

## MCP server (Claude Code integration)

Vir runs as an MCP server, letting Claude Code consult your vault mid-session
instead of relying on static CLAUDE.md content.

Register Vir with Claude Code:

```bash
vir mcp install
```

Restart Claude Code. The vault is now queryable mid-session via five tools:
`vir_query`, `vir_status`, `vir_recent_notes`, `vir_recent_articles`,
`vir_project_summary`. `vir_query` takes a `type` filter
(`session` | `article` | `all`) so Claude can scope a search to your dev
sessions or your saved articles. Human-verified notes (approved via
`vir review`) are ranked first; pass `verified_only: true` to `vir_query` or
`vir_recent_notes` to see only those.

To unregister:

```bash
vir mcp uninstall
```

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

Vir uses MMR (Maximum Marginal Relevance) reranking to balance relevance and
diversity in query results. Instead of returning 5 notes that all say similar
things, you get 5 notes covering different aspects of the topic. Tunable via
`retrievalDiversity` in config (default 0.3, range 0.0–1.0; higher = more
diverse).

## Config reference

Located at `~/.vir/config.json`.

| Field               | Default                     | Description                                                |
| ------------------- | --------------------------- | ---------------------------------------------------------- |
| `vaultPath`         | —                           | Absolute path to Obsidian vault                            |
| `outputDir`         | `vir`                       | Subdir inside vault                                        |
| `claudeProjectsDir` | `~/.claude/projects`        | Claude Code sessions                                       |
| `cadenceHours`      | `3`                         | Daemon run frequency (hours)                               |
| `provider`          | `anthropic`                 | `anthropic` or `kie`                                       |
| `anthropicApiKey`   | —                           | Required if `provider=anthropic`                           |
| `kieApiKey`         | —                           | Required if `provider=kie`                                 |
| `filterThreshold`   | `0.4`                       | Heuristic pre-filter (0..1)                                |
| `articlesDir`       | _(unset)_                   | `raw/` dir for web articles. Unset → article ingestion off |
| `distillArticles`   | `true`                      | Distill articles alongside sessions (needs `articlesDir`)  |
| `filterToolCalls`   | `moderate`                  | Tool-output filtering: `aggressive` \| `moderate` \| `off` |
| `retrievalDiversity`| `0.3`                       | MMR diversity (0..1): 0.0 = pure relevance, 1.0 = pure diversity |
| `models.classify`   | `claude-haiku-4-5-20251001` | Classify model                                             |
| `models.distill`    | `claude-sonnet-4-6`         | Distill model                                              |

## Vault structure

```
vault/vir/
  index.md       # full catalog of every note Vir has written
  log.md         # chronological append log of each run
  patterns/      # reusable approaches worth repeating
  gotchas/       # bugs, footguns, and edge cases
  decisions/     # architecture decisions with their rationale
  tools/         # per-tool knowledge and usage notes
  articles/      # web articles distilled from your raw/ folder
  projects/      # cross-session project summaries
  archived/      # deduplicated notes (kept, never deleted)
```

## State & logs

```
~/.vir/config.json   — configuration
~/.vir/vir.db        — SQLite (hashes, embeddings, content)
~/.vir/daemon.log    — daemon run log
```

## Project status

|                |                                           |
| -------------- | ----------------------------------------- |
| Tests          | 79 passing                                |
| Platforms      | macOS (launchd), Linux (systemd/cron)     |
| Node           | 20+                                       |
| First-run cost | $1–5 (Kie.ai recommended for 72% savings) |
| Ongoing cost   | ~$0.05 per run                            |

## Roadmap

- [x] Linux support (systemd timer + cron fallback) — experimental
- [x] Active learning — `vir review` to approve, edit, or reject distillations, with verified notes prioritized in retrieval
- [x] Web article ingestion — distill markdown clipped via Obsidian Web Clipper into the same vault (the LLM Wiki pivot)
- [ ] More input sources — PDFs, code repos, images (the full LLM Wiki pattern)
- [ ] Windows support
- [ ] GUI installer for non-developers
- [ ] Obsidian plugin for in-vault queries
- [ ] Export to anchor-plugin skill format
- [ ] Support for Cursor and other AI editors

## Contributing

PRs welcome. Open an issue first for large changes. Built with TypeScript
strict — run `npm run build` to check before submitting. See
[CONTRIBUTING.md](CONTRIBUTING.md) for development setup and how to regenerate
the demo GIF.

```bash
git clone https://github.com/djolex999/vir
cd vir
npm install
npm run build
npm test
```

## License

MIT

## Author & credits

Built by Djordje Marković / GrowthQ Lab DOO.

Vir (вир) is the Serbian word for _whirlpool_ — the place where a river pulls
everything in and concentrates it. Sessions flow in, Vir pulls out what matters,
and deposits it somewhere permanent.

Inspired by Andrej Karpathy's LLM Wiki pattern and Uros Pesic's KB Brain concept.

[GitHub](https://github.com/djolex999) ·
[LinkedIn](https://www.linkedin.com/in/djmarkovic/) ·
[npm](https://www.npmjs.com/~djolex999) ·
[GrowthQ Lab](https://growthqlab.com)

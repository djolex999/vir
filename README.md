# vir

Distills Claude Code sessions into a compounding knowledge vault.

## What it does

Every Claude Code session produces patterns, gotchas, and architecture
decisions. 95% sits in JSONL transcripts you never open again.

Vir is a local macOS daemon that runs every 4 hours, distills sessions
into structured markdown in your Obsidian vault, and feeds knowledge back
into CLAUDE.md so every future session starts sharper.

The loop: sessions → vir → vault → CLAUDE.md → better sessions.

Inspired by Andrej Karpathy's LLM Wiki pattern and Uros Pesic's KB Brain concept.

## Prerequisites

- macOS (launchd daemon)
- Node.js 18+
- Claude Code (sessions at `~/.claude/projects/`)
- Obsidian vault
- Anthropic API key OR Kie.ai API key (~72% cheaper, same models)
- Optional: Ollama + `nomic-embed-text` for semantic search

## Install

```bash
npm install -g vir-cli
```

## Quick start

```bash
vir init              # interactive setup (~2 min)
vir run               # process historical sessions
vir schedule install  # daemonize at configured cadence
```

## First run cost

Vir processes all historical Claude Code sessions on first run. Cost
varies by session depth:

- Simple sessions: ~$0.02 each
- Deep code reviews: up to ~$0.10 each
- Typical first run (200 sessions): $1–5 one-time

All subsequent runs process only new sessions: ~$0.05 per run.

Use Kie.ai as provider for 72% discount on same Claude models. Pass
`--yes` to skip the cost confirmation prompt.

## Commands

| Command | Description |
|---|---|
| `vir init` | Interactive setup |
| `vir run` | Process new sessions |
| `vir run --full` | Reprocess all sessions |
| `vir run --rewrite-only` | Reformat notes, no API calls |
| `vir run --yes` | Skip cost confirmation |
| `vir query "<question>"` | Semantic search your vault |
| `vir summarize <project>` | Cross-session project synthesis |
| `vir summarize --all` | Summarize all projects |
| `vir lint` | Find orphans, stale notes, contradictions |
| `vir lint --orphans` | Orphan check only (free) |
| `vir lint --stale` | Staleness check only (free) |
| `vir lint --contradictions` | Contradiction check (Haiku) |
| `vir dedupe` | Interactive duplicate detection |
| `vir sync-claude` | Inject top knowledge into CLAUDE.md |
| `vir sync-claude --dry-run` | Preview changes, no writes |
| `vir sync-claude --force` | Apply without confirmation |
| `vir embed` | Generate embeddings for semantic search |
| `vir embed --force` | Regenerate all embeddings |
| `vir schedule install` | Register launchd daemon |
| `vir schedule uninstall` | Remove launchd daemon |
| `vir status` | Knowledge heatmap + daemon status |

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

## Config reference

Located at `~/.vir/config.json`.

| Field | Default | Description |
|---|---|---|
| `vaultPath` | — | Absolute path to Obsidian vault |
| `outputDir` | `vir` | Subdir inside vault |
| `claudeProjectsDir` | `~/.claude/projects` | Claude Code sessions |
| `cadenceHours` | `4` | Daemon run frequency (hours) |
| `provider` | `anthropic` | `anthropic` or `kie` |
| `anthropicApiKey` | — | Required if `provider=anthropic` |
| `kieApiKey` | — | Required if `provider=kie` |
| `filterThreshold` | `0.4` | Heuristic pre-filter (0..1) |
| `models.classify` | `claude-haiku-4-5-20251001` | Classify model |
| `models.distill` | `claude-sonnet-4-6` | Distill model |

## Vault structure

```
vault/vir/
  index.md       # full catalog of all notes
  log.md         # chronological append log
  patterns/      # reusable approaches
  gotchas/       # bugs, footguns, edge cases
  decisions/     # architecture decisions with rationale
  tools/         # per-tool knowledge
  projects/      # cross-session project summaries
  archived/      # deduplicated notes (not deleted)
```

## State & logs

```
~/.vir/config.json   — configuration
~/.vir/vir.db        — SQLite (hashes, embeddings, content)
~/.vir/daemon.log    — daemon run log
```

## License

MIT

## Author

Built by Djordje Marković / GrowthQ Lab DOO

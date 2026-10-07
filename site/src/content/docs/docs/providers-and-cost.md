---
title: Providers and cost
description: The four distill providers, what a run costs, and every knob that controls spend.
---

vir makes two model calls per session: a cheap classify (Haiku) and a distill (the main cost). Which provider handles them is one config key.

## Providers

| `provider` | Auth | Cost model | Notes |
| --- | --- | --- | --- |
| `anthropic` (default) | `anthropicApiKey` | Per-token, Anthropic list price | Predictable; no effect on Claude Code limits |
| `claude-cli` | none — uses the installed `claude` binary | $0; consumes your Claude Code subscription quota | Capped at 25 sessions per run; halts cleanly at a subscription limit with the reset time |
| `codex-cli` (experimental) | none — uses the installed `codex` binary and your ChatGPT login | $0; consumes your Codex usage limits | Same 25-session cap and halt-at-limit as `claude-cli`; Codex picks the model unless you pin one. See [Codex](/docs/codex/#distill-on-your-chatgpt-plan-codex-cli) |
| `kie` | `kieApiKey` | Per-token, ~28% of Anthropic | Third-party proxy. Kept for cheap testing and calibration runs, not recommended for your real vault; `kieTopUpTier: "high"` applies the 10% bonus-credit discount |

**Which one?** `anthropic` for predictability, `claude-cli` if you already pay for Claude and don't mind distills sharing its quota, `codex-cli` likewise for a ChatGPT plan. Kie exists because it's cheap enough to burn through hundreds of sessions while calibrating prompts — that's what it's used for in vir's own development. It routes your transcripts through a third party, so it isn't the right choice for the vault you actually rely on.

`claude-cli` always runs with `--no-session-persistence` and a neutral working directory, so vir never writes transcripts into `~/.claude/projects` (no self-scanning) and no project's CLAUDE.md leaks into distill context. `codex-cli` does the same with `--ephemeral`. Both run with **no tools**: the distill prompt carries transcript text vir doesn't control, so `claude -p` gets `--tools "" --strict-mcp-config` (no built-in tools, no MCP servers or connectors) and `codex exec` runs read-only with its shell, web search, apps, plugins, MCP servers and subagents switched off. Calls on both are logged with cost marked not-applicable — never a fake $0.00.

## Measured cost

From the author's machine, six months, Anthropic API:

| | |
| --- | --- |
| Sessions distilled | 297 |
| Total | $25.85 |
| Median per session | $0.004 |
| 90th percentile | $0.14 |

Long sessions with hundreds of tool calls are the tail. vir strips large tool outputs and oversized skill loads before distilling; on one 517-tool-call session that cut input from ~217k to ~95k tokens without losing signal.

## Hybrid routing

Haiku captures routine and tool-heavy sessions as well as Sonnet at about a third of the cost; it only misses higher-order lessons on decision-heavy or very large sessions. When `models.distillFast` is set, each session routes after classification:

- `category === "decision"` → `models.distill`
- input tokens > `models.distillThreshold` (default 100,000) → `models.distill`
- otherwise → `models.distillFast`

`vir init` enables this by default. Existing installs are untouched on upgrade: with `distillFast` unset, `models.distill` handles everything as before.

## Cost controls

```bash
vir run --dry-run              # per-session estimate, exit before any call
vir run --force-model haiku    # override the distill model for this run
vir run --since 14d            # only recently active sessions; older ones wait
vir cost                       # actuals from ~/.vir/cost.log: total, median, p90
vir cost --since 30d --top 10
vir cost --by-session
```

`vir run` asks before proceeding with more than 20 new sessions (`--yes` skips). Every recorded cost is real token usage when the provider reports it, else a chars/4 estimate, and the record says which. Pricing is provider-aware and overridable under `pricing` in config.

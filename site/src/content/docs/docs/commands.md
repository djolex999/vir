---
title: Commands
description: Every vir subcommand with what it costs.
---

`free` = no model call. `cheap` = a few small calls. `$$` = a full distill-sized call per item. Every command takes `--help`.

## Ingest

| Command | Cost | |
| --- | --- | --- |
| `vir init` | free | Setup wizard: provider, models, vault, project triage |
| `vir run` | cheap–$$ | One pass over new sessions (what the daemon runs) |
| `vir run --dry-run` | free | Per-session estimate, exit before any call |
| `vir run --full` | $$ | Ignore the cache, reprocess everything |
| `vir run --rewrite-only` | free | Re-render notes from stored content, no scan, no calls |
| `vir run --articles-only` | $$ | Only the article phase |
| `vir run --pdfs-only` | $$ | Only the PDF phase |
| `vir run --yes` | | Skip the >20-sessions confirmation |
| `vir run --force-model haiku\|sonnet` | | Override the distill model this run |
| `vir run --only <project>` / `--exclude-project <p>` | | Scope one run; records nothing |
| `vir reconcile` | $$ | Retry sessions that failed; `--force` includes parked ones. `--dry-run`, `--yes` |
| `vir calibrate <sessionId>` | $$ | Distill one session to stdout, write nothing. `--model` |

## Triage

| Command | Cost | |
| --- | --- | --- |
| `vir projects` | free | Per-project decisions, counts, pending cost. `--json` |
| `vir projects include <name>` / `exclude <name>` | free | Change one decision |
| `vir review` | free | Approve / edit / reject new notes. `--all`, `--project`, `--limit` |
| `vir review --restore <note>` | free | Put one rejected note back out of `.rejected/` |
| `vir audit` | cheap | A model judges every note: keep / verify / merge / reject. `--project`, `--limit`, `--all`, `--model` |
| `vir audit --dry-run` | free | Notes, batches and estimated cost, no model call |
| `vir review --audited` | free | Walk the notes `vir audit` flagged, worst first, with its reason |
| `vir review --json` | free | Non-interactive review for the Obsidian plugin: `--audited` lists the queue; `--approve`, `--reject`, `--restore` act on one note |
| `vir audit --apply-rejects` | free | Move fresh reject verdicts to `.rejected/`, asks first, reversible |
| `vir lint` | free–cheap | Orphans and stale are free; `--contradictions` calls Haiku |
| `vir lint --strays` | free | Note files with no live DB row. `--fix` moves them to `archived/` |
| `vir lint --legacy-related` | free | Pre-0.12.0 notes whose Related holds content a rewrite drops. `--fix` |
| `vir dedupe` | cheap | Interactive duplicate detection and merge |
| `vir prune` | free | Dry run: agent-derived notes to demote. `--apply`, `--restore` |

## Retrieve

| Command | Cost | |
| --- | --- | --- |
| `vir query "<question>"` | cheap | Search + synthesize. `--json`, `--limit` |
| `vir queries` | free | Retrieval report: method split, dead-weight notes. `--json`, `--top` |
| `vir compose "<topic>"` | $$ | Topic page from related notes. `--dry-run`, `--limit`, `--model` |
| `vir summarize <project>` / `--all` | cheap | Per-project synthesis |
| `vir summarize --week [N]` / `--month [N]` | cheap | Period digest |
| `vir embed` | free | Embed notes with the detected provider. `--force` re-embeds all |
| `vir embed --setup` | free | Install the local embedding provider |
| `vir mcp install` / `uninstall` / `status` | free | Register with Claude Code. `install --scope user\|project` |
| `vir mcp` | free | Run the MCP server over stdio |

## Sync and operate

| Command | Cost | |
| --- | --- | --- |
| `vir sync-claude [project]` | free | Diff, confirm, write between VIR markers. `--dry-run`, `--force`, `--global` |
| `vir schedule install` / `uninstall` | free | Daemon. `--run-now` |
| `vir status` | free | Knowledge base breakdown + daemon state |
| `vir doctor` | cheap | 13–20 install/config checks. `--json` |
| `vir notifications` | free | Allow vir's macOS notifications and send a test |
| `vir cost` | free | Actual spend from cost.log. `--since`, `--top`, `--by-session` |

`vir query --json` and `vir doctor --json` are stable contracts consumed by the [Obsidian plugin](/docs/obsidian-plugin/). Other `--json` outputs are for scripting and may change.

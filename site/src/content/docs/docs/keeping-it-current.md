---
title: Keeping it current
description: The daemon, syncing back into CLAUDE.md, and the maintenance commands that keep a vault trustworthy.
---

## The daemon

```bash
vir schedule install            # register
vir schedule install --run-now  # register and run once immediately
vir schedule uninstall          # remove
vir status                      # is it running, when did it last run
```

| Platform | Mechanism | Notifications | Status |
| --- | --- | --- | --- |
| macOS | launchd agent (`~/Library/LaunchAgents/com.github.djolex999.vir.plist`) | osascript | Stable |
| Linux | systemd user timer (`~/.config/systemd/user/`) | notify-send | Experimental |
| Linux without systemd | crontab entry | notify-send | Experimental |

Cadence is `cadenceHours` in config (default 3). The daemon path never prompts: with more than 20 new sessions it proceeds; with an undecided project it notifies and skips those transcripts as `project-pending` until you decide.

Distill runs are serialized by a lockfile (`~/.vir/vir.lock`), so a manual `vir run` and the daemon can't collide. A session that fails three times in a row is parked until `vir reconcile --force`.

## Back into CLAUDE.md

```bash
vir sync-claude              # diff, then confirm
vir sync-claude --dry-run    # diff only
vir sync-claude <project>    # one project
vir sync-claude --global     # only ~/.claude/CLAUDE.md
```

vir writes only between `<!-- VIR:START -->` and `<!-- VIR:END -->` markers. The rest of the file is preserved byte-for-byte; if there's no block yet, one is appended. Nothing is written without you seeing the diff, unless you pass `--force`.

Project paths resolve flexibly: `~/projects/<slug>`, `~/projects/<slug>-*`, `~/code/<slug>`, `~/dev/<slug>`.

## Review

```bash
vir review                 # walk new notes: approve / edit / reject / skip
vir review --project <p>   # one project
vir review --all           # include already-verified notes
```

Approve stamps `verified: true` + `reviewed_at` into the note's frontmatter. Verified notes rank first in `vir query` and MCP. Reject moves the note to `.rejected/` — recoverable, never deleted.

## Lint and dedupe

```bash
vir lint                    # orphans + stale + contradictions
vir lint --orphans          # free
vir lint --stale            # free
vir lint --contradictions   # a Haiku call per pair
vir dedupe                  # interactive near-duplicate merge
```

Dedupe losers go to `archived/`. Merge winners are re-embedded so retrieval matches their new content.

## Syntheses

```bash
vir compose "<topic>"          # one topic page from related notes → topics/
vir summarize <project>        # per-project summary → projects/
vir summarize --week [N]       # period digest → summaries/ (never indexed)
vir summarize --month [N]
```

All take `--dry-run` (sources + cost, no call) and `--yes`.

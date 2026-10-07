---
title: Keeping it current
description: The daemon, syncing back into CLAUDE.md and AGENTS.md, and the maintenance commands that keep a vault trustworthy.
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
| macOS | launchd agent (`~/Library/LaunchAgents/com.github.djolex999.vir.plist`) | Vir.app, shown as "vir" (osascript until allowed; run `vir notifications`) | Stable |
| Linux | systemd user timer (`~/.config/systemd/user/`) | notify-send | Experimental |
| Linux without systemd | crontab entry | notify-send | Experimental |

Cadence is `cadenceHours` in config (default 3). The daemon path never prompts: with more than 20 new sessions it proceeds; with an undecided project it notifies and skips those transcripts as `project-pending` until you decide.

Distill runs are serialized by a lockfile (`~/.vir/vir.lock`), so a manual `vir run` and the daemon can't collide. A session that fails three times in a row is parked until `vir reconcile --force`.

## Back into CLAUDE.md and AGENTS.md

```bash
vir sync-claude              # diff, then confirm
vir sync-claude --dry-run    # diff only
vir sync-claude <project>    # one project
vir sync-claude --global     # only ~/.claude/CLAUDE.md (and ~/.codex/AGENTS.md)
vir sync-claude --no-agents  # leave AGENTS.md files alone
vir sync-claude --agents-only # only AGENTS.md
```

vir writes only between `<!-- VIR:START -->` and `<!-- VIR:END -->` markers. The rest of the file is preserved byte-for-byte; if there's no block yet, one is appended. Nothing is written without you seeing the diff, unless you pass `--force`.

**AGENTS.md** (since 0.26) gets the same block, in `~/.codex/AGENTS.md` and in project roots, but only where the file already exists; a missing AGENTS.md is never created or listed. It carries the rules you approved for CLAUDE.md, never more, and `--agents-only` writes those without asking about rules.

Project paths resolve flexibly, for both files: `~/projects/<slug>`, `~/projects/<slug>-*`, `~/code/<slug>`, `~/dev/<slug>`, and, since 0.25.1, a folder in any of those whose name slugs to the project (`pripremi.rs` → `pripremi-rs`).

**Rules.** Accepted [recurring rules](/docs/recurring-rules/) go into the same block under `## Rules (from vir)`, but never in bulk: each one is shown as its own hunk with its source notes and needs its own `y`. `n` declines it for good; `s` asks again next time. Under `--force`, `--dry-run`, or without a terminal, rules are listed as awaiting approval and never added.

## Review

```bash
vir review                 # walk new notes: approve / edit / reject / skip
vir review --project <p>   # one project
vir review --all           # include already-verified notes
```

Approve stamps `verified: true` + `reviewed_at` into the note's frontmatter. Verified notes get a ranking boost in `vir query` and MCP. Reject moves the note to `.rejected/` — recoverable, never deleted. `vir review --restore <note>` puts one back.

## Audit

`vir review` walks new notes one at a time. `vir audit` looks at the whole vault at once: it batches each project's notes, so near-duplicates usually land together, and asks a model for a verdict (keep, verify, merge or reject) and a one-line reason per note.

```bash
vir audit --dry-run          # notes, batches, estimated cost — no call
vir audit                    # judge every note without a fresh verdict
vir review --audited         # walk the flagged notes, rejects first
vir audit --apply-rejects    # move fresh rejects to .rejected/
```

Verdicts are suggestions. The audit only writes to the database; `vir review --audited` shows each flagged note with the auditor's reason, and you approve, edit or reject it as usual. A verdict goes stale when the note's content changes, and a note you've approved (`verified: true`) is never audited.

`--apply-rejects` is the one shortcut, and only for rejects: it lists exactly the notes it will move, asks (default No), and stamps them `rejected_by: audit`. Notes you approved or restored are skipped. Every move is undone with `vir review --restore`.

Before trusting it, the rejects were measured: on real later-session questions, Claude answered with and without the rejected notes. Of 34 affected answers, 32 were unchanged, and every worse one traced to retrieval noise, not a lost fact. Details are in the [changelog](/docs/changelog/).

## Lint and dedupe

```bash
vir lint                    # orphans, stale, contradictions, strays, legacy Related
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

All take `--dry-run` (sources + cost, no call). `compose` and the period digests also take `--yes`.

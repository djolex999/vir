---
title: Inputs
description: Sources that feed one vault — Claude Code and Codex sessions, clipped web articles, and PDFs.
---

Sessions, articles and PDFs each have their own reader, distiller, SQLite table and vault folder. All of them embed into one vector space, so `vir query` searches across them with a `type` filter.

## Claude Code sessions

The original source, and the one that's retroactive: vir reads whatever is still under `~/.claude/projects/`. Claude Code prunes transcripts after roughly 30 days, so the first run recovers history that's about to disappear.

Sessions run through the full [pipeline](/docs/how-it-works/) and land in `patterns/`, `gotchas/`, `decisions/`, or `tools/`.

## Codex sessions

Since 0.26: set `codexSessionsDir` (`vir init` asks) and vir reads `~/.codex/sessions/` too: the Codex CLI, IDE extension and desktop app. The harness context Codex stores as user messages is stripped, subagent and review threads are skipped, and a project you use from both agents is one project. Codex keeps its rollouts, so there's no pruning deadline; archived threads are not read. Details: [Codex](/docs/codex/).

## Web articles

Clip pages into a folder — Obsidian Web Clipper works well — and point `articlesDir` at it. Each clipped markdown file is classified as `concept`, `technique`, `reference`, or `opinion` and distilled into `articles/<slug>.md` with `type: article` and `source_url` in the frontmatter.

Distillation is copyright-bounded: never more than 15 verbatim words from the source. The slug is keyed off the URL, so re-clipping the same page overwrites its note instead of orphaning it.

```json
{ "articlesDir": "/Users/you/Vault/clips" }
```

Run just this phase with `vir run --articles-only`. Leave `articlesDir` unset to keep the phase off.

## PDFs and papers

Point `pdfsDir` at a folder of PDFs. Each is classified as `paper`, `reference`, `notes`, or `other` and distilled into `pdfs/<slug>.md` with `type: pdf`, `source_path`, `source_title`, and `pages`. Same copyright bound as articles.

PDFs are the expensive source — text extraction plus a full distill per file — and the daemon has no cost gate on this phase. The recommended posture is **manual only**:

```bash
# set pdfsDir in config.json, then
vir run --pdfs-only --dry-run    # this IS the cost check — no interactive prompt
vir run --pdfs-only
# optionally unset pdfsDir again
```

## Meeting notes (Muninn)

Muninn, a macOS meeting-notes app, runs `vir ingest --source muninn <file>` after each note (meetings, ideas, moments). The note is already summarized, so vir makes no LLM call: it checks the frontmatter (`muninn: 1`), copies the summary sections into `meetings/<id>.md` with `type: meeting`, `kind`, `people`, `source_path` and a link back to the original, and embeds it with your local provider. The note's `id` is the key, so running it again or renaming the file updates the same note. The transcript callout is left out unless you pass `--with-transcript`.

## Where things land

```
vault/vir/
  patterns/  gotchas/  decisions/  tools/   # sessions (Claude Code and Codex)
  articles/                                 # web clips
  pdfs/                                     # papers
  meetings/                                 # vir ingest (Muninn)
  topics/                                   # vir compose syntheses
  projects/                                 # per-project summaries
  summaries/                                # weekly/monthly, never indexed
  archived/                                 # dedupe losers, kept
```

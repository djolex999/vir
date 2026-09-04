---
title: Inputs
description: Three sources feed one vault — Claude Code sessions, clipped web articles, and PDFs.
---

Each source has its own reader, its own distiller, its own SQLite table, and its own vault folder. All three embed into one vector space, so `vir query` searches across them with a `type` filter.

## Claude Code sessions

The original source, and the one that's retroactive: vir reads whatever is still under `~/.claude/projects/`. Claude Code prunes transcripts after roughly 30 days, so the first run recovers history that's about to disappear.

Sessions run through the full [pipeline](/docs/how-it-works/) and land in `patterns/`, `gotchas/`, `decisions/`, or `tools/`.

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

## Where things land

```
vault/vir/
  patterns/  gotchas/  decisions/  tools/   # sessions
  articles/                                 # web clips
  pdfs/                                     # papers
  topics/                                   # vir compose syntheses
  projects/                                 # per-project summaries
  summaries/                                # weekly/monthly, never indexed
  archived/                                 # dedupe losers, kept
```

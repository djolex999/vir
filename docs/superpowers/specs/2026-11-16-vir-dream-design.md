# `vir dream` design

Status: **draft for review** (2026-11-16). Designed with Fable 5.2. Every code reference was checked against `main` at `172e516`.

## Why

Anthropic's "components of agent memory" article describes **dreaming**: an offline pass that reads across many sessions to fix mistakes and build better representations. vir already has most of the parts as separate commands:

- **Per-note correction:** `audit --transcript`.
- **Link repair:** `lint --links --fix`.
- **Merging:** `dedupe`.
- **Topic pages:** `compose`.
- **Promotion into CLAUDE.md:** `sync-claude`.

Nothing reads a project's notes **together**. `vir summarize <project>` comes closest, but it has three problems:

- **Its prompt gets almost nothing:** 200-character excerpts.
- **Its output can't be traced or trusted:** prose with no sources and no trust labels.
- **On the real vault it's stale:** pages were last generated in June, and growthq's holds only a changelog of counts.

The article's evidence for a cross-session representation is specific:

- **Multi-document questions:** a wiki helped there (87% vs 73% for search alone), but not on single-document lookups.
- **Verbatim quotes:** one page per entity with quotes kept 57/57 facts, where a shared table lost 16.
- **Confirmed vs unconfirmed:** the best models kept one reference document with facts marked checked or unconfirmed.
- **Bloat:** one wiki grew to 1.77× its corpus.

## Goals, non-goals, anti-goals

- **Goal:** one reference page per project that an agent can read mid-session. Each fact on it is traceable to a note, labelled confirmed or unconfirmed, and kept small.
- **Goal:** surface cross-note conflicts and gaps that no single-session pass can see.
- **Non-goals (v1):**
  - correcting notes (that's `audit --transcript`)
  - re-reading transcripts
  - a global cross-project wiki
  - a self-improving prompt loop
  - triggering from inside a session
- **Anti-goals:**
  - The page invents or launders a claim. Every entry needs a quote the code has checked.
  - The page feeds back into itself, so errors compound.
  - The page bloats CLAUDE.md, or grows bigger than the notes it summarises.

## Approaches considered

1. **A new page that replaces `summarize <project>` (chosen).** It rebuilds `projects/<slug>.md` from notes and is served by the existing `vir_project_summary`. That gives one page, one MCP tool, no parallel system, and fixes the stale pages.
2. **Dream edits notes directly** (merges, corrections). Rejected. It's the wrong-note-propagation risk the article warns about, and vir never changes notes silently, except for link repair.
3. **Many entity/topic pages per project** (a full wiki). Deferred to M3. It's only justified if one page overflows its cap and the measurements say the page helps.

## Design

### Output and consumers
- **Agent mid-session (primary):** reads it through `vir_project_summary`, which already serves `projects/<slug>.md` (`src/mcp/server.ts`). The path and contract are unchanged.
- **Human in Obsidian (secondary):** every entry wikilinks its source note.
- **CLAUDE.md:** a one-line pointer only, in M2. The article says injected context stays small and links downward.

### Input, per project
- The `db.listDistilled()` rows for the project, full content. The real DB has 601 rows averaging about 2.8 KB each.
- **Excluded:** notes returned by `flaggedNotePaths(audits, grounds)` (`src/claude/updater.ts`), unless the note is human-verified. `sync-claude` makes the same choice.
- **Per-note status:** from `noteStatusLookup` (`src/search/noteStatus.ts`).
- **Retrieval counts:** from `buildNoteUsage(readQueryLog())`.
- **Budget:** 60k input tokens. Notes are ordered by retrieval count, then confidence, then recency. Notes past the budget go in as their topic plus their lesson, or their first 300 characters.
- **Never input:** transcripts (`ground.ts` covers them), the previous dream page, topic pages, or summaries.

### Pipeline
1. **Select rows** and compute `input_hash` over the sorted (path, content hash, status) triples. If it matches the page's frontmatter, skip the project at no cost (`--force` overrides).
2. **One LLM call** with the notes numbered `[1..N]`. The model returns JSON only:
   ```json
   {"overview": "≤60 words",
    "sections": [{"heading": "≤6 words",
      "entries": [{"claim": "≤30 words", "source": 12,
        "quote": "exact span from note 12, ≤200 chars",
        "kind": "rule|trap|decision|how-to", "also": [3, 7]}]}],
    "conflicts": [{"a": 4, "b": 19, "about": "≤20 words"}],
    "gaps": ["≤15 words"]}
   ```
   The prompt asks the model to:
   - group by area (auth, payments, deploy), not by note category
   - write one entry per fact, folding duplicates into `also`
   - prefer facts likely to bite again
   - never state anything not in a note
   - report disagreements as conflicts, never pick a winner
3. **Validate in code.** Drop an entry when its source index is invalid, or when its quote isn't a whitespace-normalised substring of that note.
4. **Label in code** from the source note's status:
   - `verified` or `transcript-supported` → **confirmed**
   - `unchecked` or `unbacked` → **unconfirmed**
   - The model is never asked how sure it is.
5. **Apply caps** (below), render the markdown, write the file, and keep the existing changelog tail.
6. **Print a report:** entries kept and dropped, coverage (cited notes / input notes), the size ratio, confirmed share, and conflicts.

**Done in code, not by the model:**
- labels
- `[[noteRef]]` links
- "retrieved N×" badges
- ordering: confirmed first, then most-retrieved
- caps
- frontmatter: `project`, `generated`, `sessions`, `kind: dream`, `input_hash`, `notes`, `entries`, `confirmed`, `ratio`, `model`
- the changelog

### CLI, config, MCP
- **CLI:** `vir dream [project]` with `--all`, `--dry-run` (cost estimate), `--yes`, `--model`, `--force`, `--min-notes <n>` (default 5). It holds the pipeline lock like `summarize`.
- **`vir summarize <project>|--all`** becomes an alias for dream. `--week` and `--month` are unchanged.
- **Config:** none in M1. M2 adds an optional `dream: { auto?, minChangedNotes? (5), maxPerPass? (1) }`.
- **MCP:** `vir_project_summary` adds `entries`, `confirmed_entries` and `stale_notes` (live notes newer than `generated`). The missing-page hint becomes `vir dream <slug>`, and the tool description mentions the labels and the links.
- **Cost log:** stage `dream`. No new DB table.

## Safety rules
1. **One write only.** Dream never edits, moves or deletes notes; it writes `projects/<slug>.md` and nothing else.
2. **Dream output is never a source** for dream, search, audit, check, dedupe or compose.
   - **Correction to Fable's draft:** the TF-IDF fallback in `src/search/retriever.ts` *does* index `projects/` today, because its `SKIP_DIRS` holds only `summaries`, `.rejected`, `archived` and `journal`. M1 adds `projects` and a test. The embedding path already leaves it out.
3. **Errors can't compound.** Every run rebuilds from notes, so fixing or rejecting a note fixes the next page.
4. **No entry without a code-checked verbatim quote.**
5. **Labels come only from check data and human verification.**
6. **Contradicted and audit-flagged notes never reach the prompt.**
7. **Conflicts are listed under "Needs review"** on the page and in the CLI, and never resolved automatically.
8. **Caps:** 40 entries or 12 KB per page, and page/source ratio ≤ 0.35. Overflow drops unconfirmed, least-retrieved entries first.

## Plan

### M1: manual command (about 1–2 days)
1. **`src/dream/select.ts`:** `selectDreamNotes` and `dreamInputHash`.
   - Tests: flagged notes excluded, verified overrides the flag, the budget demotes the tail, the hash changes when a status changes.
2. **`src/dream/prompt.ts`:** `buildDreamPrompt` and `parseDreamResponse`, as tolerant as `parseGroundResponse`.
   - Tests: malformed JSON, bad indices.
3. **`src/dream/validate.ts`:** the quote check, labels, caps and ratio.
   - Tests: a made-up quote is dropped, whitespace is tolerated, the label for each status, overflow order.
4. **`src/dream/render.ts`:** the page. Export `readExistingChangelog` from `src/pipeline/summarizer.ts`.
   - Tests: a snapshot, and every entry has a wikilink.
5. **`src/dream/run.ts`:** `dreamProject(cfg, db, slug, deps)` with `llm` injected.
   - Tests: skip on the same hash, `--force`, the write path.
6. **`src/cli/dream.ts`,** modelled on `src/cli/audit.ts`. Register it in `src/cli.ts`; `src/cli/summarize.ts` hands the project path to dream.
7. **`src/mcp/server.ts`:** new fields, hint and description, plus tests.
8. **`src/search/retriever.ts`:** add `projects` to `SKIP_DIRS`, plus a test.
9. **Check it:** tsc, the full suite, then `--dry-run` and a real run on `vir` and `growthq`; read both pages by hand. README and CHANGELOG.

### M2, only if the measurement below shows a gain
- **Daemon step** after the transcript check: at most one project per pass, when at least 5 of its notes changed, most-retrieved project first. Off by default.
- **Conflicts go to `vir review --audited`** as `verify`, with the reason `dream: conflicts with [[x]]`.
- **`sync-claude`:** a pointer line in each project block, and lesson lines link back to their note again.

### M3, only if the data justifies it
- A project that overflows the cap is split into area pages, with the project page as their index.
- A "likely stale" marker for entries whose sources are old and never retrieved.

## Measuring whether it helps
- **Every run (free):** dropped-quote rate, coverage, ratio and confirmed share are printed and stored in frontmatter. A dropped-quote rate over about 10% means the prompt is wrong.
- **One-off eval:** about 20 questions mined from real `queries.jsonl` for two projects, tagged single-note or multi-note. Three arms are compared: `vir_query` top-8, the page alone, and both. Grade them with the existing `eval/` grader and record context tokens. M2 ships only if multi-note accuracy rises, or tokens fall at equal accuracy.
- **Ongoing:** log `vir_project_summary` calls to `queries.jsonl`, so `vir queries` shows whether agents open the page at all.

## Cost (Sonnet, $3/$15 per 1M; about 710 tokens per note; about 3k output tokens per page)
| Run | Cost |
|---|---|
| 80-note project | ~$0.22 |
| 30-note project | ~$0.11 |
| `--all` (~15 projects with ≥5 notes) | ~$1.30 |

Unchanged projects cost nothing on reruns. With the `claude-cli` provider this is subscription quota, not dollars.

## Decisions for the owner (recommendation first)
1. **Replace `summarize <project>`, with `summarize` as an alias** — or add dream alongside it. *Recommend replace:* the existing pages are stale and nearly empty.
2. **Show unconfirmed entries, labelled and sorted last** — or confirmed only. *Recommend show them:* most notes are unchecked, so confirmed-only would be nearly empty.
3. **Model: `models.distill` (Sonnet)** — or Haiku. *Recommend Sonnet:* exact quotes matter, and the hash skip keeps runs rare.
4. **Daemon auto-dream (M2) off by default** until the eval shows a gain.

## Left to the builder
- Wording of the prompt, the exact page layout, and the section order within the caps.
- How the over-budget notes are shown in the prompt.
- Where the eval harness code lives inside `eval/`.

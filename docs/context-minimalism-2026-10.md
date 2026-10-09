# Context minimalism: sync-claude block + global CLAUDE.md trim (2026-10-09)

Source: Anthropic, "The new rules of context engineering for Claude 5 generation models"
(claude.dev blog). Takeaways that drove this work:

- CLAUDE.md loads every session: keep it light, spend tokens on codebase-specific gotchas,
  skip anything the model can see or already does.
- Progressive disclosure: put the rest somewhere it can be pulled when relevant.
- Manual memory routines are obsolete (auto-memory); conflicting instructions cost reasoning.

## What was wrong

`vir sync-claude` wrote top-5 notes per category, across every project, into every
CLAUDE.md including the global one, as `- gotcha/slug (conf 0.95) — slug`. The text after
the dash was the slug again, so each line said only "a note exists", in every session of
every unrelated project.

## Change 1: the VIR block (src/claude/updater.ts)

- Project CLAUDE.md: that project's top 5 **gotchas** only (confidence, ties to newest,
  duplicate lessons dropped). Patterns, decisions and tools stay in the vault.
- Each line is the lesson, from `extractLesson`. It reuses the connect pass's parser
  (`extractLessonTexts`), prefers the first of a note's first three points that reads as a
  gotcha (must / never / only / fails…), then: a claim-shaped bold lead is used as is; a
  label lead ("**Gate-field mismatch**:", title case) keeps the sentence after it; bold
  opening a running sentence is read straight through. Falls back to plain bullets / Key
  Points, the Summary, then the topic. One line, `ruleText`-sanitized, clipped at 200
  with backticks kept balanced.
- No confidence scores and no per-line markers in the file: the diff keys on lesson text
  (a reworded lesson shows as one out, one in). Old-format lines are still parsed, so the
  first sync shows them as removals.
- Global CLAUDE.md / AGENTS.md: no notes, only one pointer (`vir_query` MCP tool or
  `vir query "<topic>"`) and promoted global rules. Project blocks don't repeat it.
- `DiffResult.upgraded` (confidence deltas) is gone; `removed` now carries the lesson.

Checked against a copy of the real DB: most lessons read as real lessons. The rest come
from notes whose early points are background or audit findings, not gotchas
("Codebase structure: 304 TypeScript source files…"). The ceiling is the note, not the
extractor; the durable fix is a one-line `lesson:` written at distill time, with
`extractLesson` as the fallback for old notes (follow-up, not done).

Tests: src/claude/updater.block.test.ts.

## Change 2: global ~/.claude/CLAUDE.md (6.6 KB → 1.8 KB, applied 2026-10-09; backup at ~/.claude/CLAUDE.md.bak)

Kept: who the user is, stack defaults, non-default code style (named exports, no barrels,
error-handling layer), ask-first rules, the "done means verified" bar.
Removed: planning/communication rules the model follows by default, the tasks/lessons.md
self-improvement loop (auto-memory, `learn`, `context-sync` cover it), the project-layout
tree (the `new-project` skill owns it), the Active projects table (stale, duplicates
per-project files), and the slug-list VIR block.

## Review

Each step reviewed by a fresh Fable 5.1 agent.

Updater (no blockers). Applied: reuse `extractLessonTexts` instead of a second parser;
mid-sentence bold no longer becomes "Never: trust…"; `e.g.` doesn't end a sentence;
clipping keeps backticks balanced; dropped the `<!-- vir-note:slug -->` marker (a quarter
to a third of each line's tokens) and diff on lesson text; pointer only in the global
block; removed entries print as lessons. Prefer gotcha-cue points over background.
Deferred: distill-time `lesson:` field (the real fix for weak notes).

Global CLAUDE.md. Applied: restored a session-start pointer to `handoff.md` /
`tasks/lessons.md` (nothing else reads lessons.md: `learn` and `context-sync` only write
it); kept `.env` as a hard never; kept "stop and re-plan when something breaks";
"Don't explain basics" instead of the ambiguous "Skip basics"; "Supabase (Postgres)".
Not applied: the `tasks/todo.md` checklist habit (the built-in todo tool covers in-session
tracking; `/sync` keeps the file).

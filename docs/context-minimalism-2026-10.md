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
`extractLesson` as the fallback for old notes (done, see Change 4).

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

## Change 3: skills (2026-10-09)

- `~/.claude/skills/built-md`: added the missing frontmatter (it listed as "SKILL: built-md"
  and couldn't trigger reliably). Original at `~/.claude/skills-backup/built-md-SKILL.md.bak`.
- `codebase-architect`: the local copy (Oct, Archify) is a superset of the claude.ai-synced
  one; remove the claude.ai copy in claude.ai skill settings.
- `learn`: **not a duplicate.** The claude.ai `learn` is Anthropic's tutoring skill; the
  local one is the `/learn` correction-capture skill that `new-project` relies on. It was
  moved out by mistake and restored unchanged after the Fable review caught it.
- `mattpocock-skills` kept (1.2.3, latest after a marketplace refresh): most of its skills
  list by name only and run when called, so their per-turn cost is small; only
  `domain-modeling`, `codebase-design`, `resolving-merge-conflicts` and `grilling` carry
  a full description.
- Not done, by choice: scoping the Cloudflare plugin to `growthqLabDoo` / `sterija`,
  dropping the superpowers SessionStart hook.

Follow-ups from review: `/shipped` and built-md's update mode describe the same append
step twice; codebase-architect Phase 6 calls `present_files`, which Claude Code doesn't have.

## Change 4: distill-time lesson (src/pipeline/distiller.ts)

- After `retitle`, a gotcha gets one more call on the classify model over the finished
  note (`buildLessonPrompt`, stage `lesson` in cost.log): one sentence, ≤ 160 chars,
  phrased as the rule, or `NONE`. `parseLesson` strips wrappers and rejects NONE,
  empty and > 220 chars. Other categories skip the call: only gotchas reach CLAUDE.md.
- Not folded into the distill prompt: that text is byte-pinned to the blind-tested
  `eval/distill/COMBINED.md`, and its output is the note. Not folded into classify:
  classify sees the raw summary, before the note exists (the reason titles moved to
  the finished note). Same failure policy as `retitle`: a failed call keeps the note
  with no lesson; a subscription limit still halts the run.
- Stored as `lesson:` in frontmatter (JSON-escaped scalar) and the nullable `lesson`
  column. `record()` replaces it whenever it writes content (a re-distill without a
  lesson clears the stale one) and keeps it otherwise; `rewriteRow` carries it over.
  `listDistilled` selects `NULL AS lesson` on a read-only pre-migration DB.
- `selectTopEntries` uses the stored lesson (`ruleText` + clip), else `extractLesson`.
  Old notes keep the heuristic unless `vir sync-claude --backfill-lessons` runs: one
  lesson call per gotcha with `lesson IS NULL` over the stored note and title, behind
  `confirmPaidStep` and the pipeline lock, DB only (the note file gets `lesson:` on its
  next rewrite). NONE stores "" so it isn't re-asked; a failure stays NULL; a
  subscription limit stops it. Not a re-distill.
- Eval (2026-10-09/14, a copy of the real DB, the 44 gotchas sync-claude would pick):
  the first prompt beat the heuristic on ~24 of 42 answered but drifted to a side rule
  on ~7 grab-bag notes. The shipped prompt passes the title (the retitle) and asks for
  code in backticks and a rule that stays true. On Haiku 5.5: 0 errors, 4–11 s a call,
  the drift cases on topic, 5 NONE (those fall back to `extractLesson`; 3 of them had a
  usable rule, so NONE is a bit eager), 2 task-shaped answers left. 6 of 39 came back
  wrapped in backticks; `parseLesson` strips a pair that closes after the final
  punctuation, which a real code span doesn't.
- `vir run --dry-run` charges every session for the lesson call (category is unknown
  before classify), so the estimate is an upper bound.

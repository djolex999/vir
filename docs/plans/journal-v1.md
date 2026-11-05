# Journal v1

A daily record of what happened per project, built from Claude Code transcripts. No LLM calls.

## Rules

- **Evidence:** a Done line points to a commit sha or a completed task. No pointer, no line.
- **Confirmed only:** an event counts once its tool result confirms it. Rejected commits and unanswered calls do not count.
- **Projection:** `journal/YYYY-MM-DD.md` is regenerated from SQLite, which outlives the roughly 30-day transcript retention. It is excluded from retrieval and lint.
- **Days:** local calendar days in the machine's time zone, or `--tz`. Never UTC math.
- **Decisions:** wikilinks to existing Vir decision notes, on the day their session ended.

## Milestones

- **M0, done:** raw `jsonl` to typed events (`src/journal/events.ts`), covering TaskCreate, TaskUpdate, TodoWrite, the desktop app's `update_plan` (with `wrap_up` checking off the step in progress) and git commit output.
- **M1, done:** `journal_sessions` and `journal_events` tables, the daily file, and `vir journal`.
- **M2:** open loops carried across sessions.
- **M3:** `vir brief` on SessionStart from a JSON cache, and `vir hooks install`.
- **M4:** three MCP tools.

## Known limits of v1

- Claude Code only. Codex sessions are not read yet.
- Commits come from Bash output of `git commit`. Merges, rebases, cherry-picks and commits made outside an agent session are not seen.
- `git commit -q` prints nothing to read, so a quiet commit is missed.
- A task appears only on days it was touched. Carrying it forward is M2.
- `--tz` is not stored, so the time zone must be passed each run on a machine set to another zone.

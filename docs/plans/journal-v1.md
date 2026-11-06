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
- **M2, done:** open loops carried across sessions and days. Each day gets a **Carried over** section per project: tasks that were unfinished (pending, in progress or blocked) at the end of an earlier day and not touched today, each with its original `(task <suffix>#<id>)` pointer, its state and `open N days` counted in local calendar days from the day it was created. A project with carried tasks but no session that day still gets them ("no sessions"); a day with no activity at all still gets no file, so `--all` and a single-day run agree. A loop stops carrying when:
  - its task is completed or deleted. A new `items` list (update_plan) or TodoWrite snapshot already marks unfinished old steps deleted, so a replaced plan closes itself; the carry matters for sessions that ended mid-plan;
  - a task with the same subject in the same project was touched later, in any session. That is a resumed session's replayed copy, or a new session that re-planned the same step; the later copy is the live one;
  - nothing touched it for more than `CARRY_DAYS` (7) local days. Past that it is abandoned, not in flight.
- **M3:** `vir brief` on SessionStart from a JSON cache, and `vir hooks install`.
- **M4:** three MCP tools.

## Known limits of v1

- Claude Code only. Codex sessions are not read yet.
- Commits come from Bash output of `git commit`. Merges, rebases, cherry-picks and commits made outside an agent session are not seen.
- `git commit -q` prints nothing to read, so a quiet commit is missed.
- A carried loop that was really finished outside a session (or by a commit with no task update) keeps carrying until the 7-day limit.
- Same-subject matching is exact: a step reworded in a re-plan does not close the old one.
- `--tz` is not stored, so the time zone must be passed each run on a machine set to another zone.

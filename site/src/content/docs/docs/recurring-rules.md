---
title: Recurring rules
description: vir connect finds lessons you keep re-learning and proposes them as cited rules. They reach search after your review, and CLAUDE.md only with a yes per rule.
---

A note records one session. When the same lesson shows up in session after session, that's a rule you haven't written down. `vir connect` finds those and proposes them, and you decide what's true and what goes into CLAUDE.md.

```bash
vir connect --dry-run   # free: clusters, candidates, estimated cost
vir connect             # propose rules (asks before any paid call)
vir review --insights   # accept, edit or reject them
vir sync-claude         # one y/n per accepted rule
```

It needs an [embedding provider](/docs/retrieval/#search-providers) (Ollama or the local one).

## What counts as recurring

- **Lessons, not notes.** Each bolded item under a note's *What Was Learned* is one lesson, so a session that taught four things contributes four. Notes that `vir dedupe` merged still count, through their *Archived Duplicates* links.
- **At least 3 sessions, at least 7 days apart** (first to last). Three sessions on the same afternoon are one piece of work, not a lesson you keep relearning.
- **Very close in meaning.** Lessons are grouped only when their embeddings are at cosine ≥ 0.85. That cutoff comes from a labeled sample of a real 1,292-lesson vault, where every pair above it was the same lesson and almost none below it were. Expect few proposals until your vault has real repeats; precise beats plentiful here.

## What the model may and may not do

One call per candidate, at most `connectMaxCandidates` (default 10) per run. The model picks which lessons are the same and states the rule, but everything it claims is checked:

- every quote must be a verbatim substring of the note it cites, or it's dropped;
- lessons it cites must be in the group, and after dropping, the rest must still meet the 3-sessions / 7-days rule, or nothing is written;
- the scope (one project or global) comes from the sources, not the model;
- rule text is cleaned to one plain line: no control characters, no markup that could alter CLAUDE.md.

## Proposed, accepted, promoted

Rules are written to `insights/rules/` with `status: proposed`. Until you accept one, it's invisible to `vir query` and MCP.

`vir review --insights` shows each rule with its evidence. **Accept** makes it searchable (it ranks like a verified note; MCP `type: insight`). **Edit** opens it in `$EDITOR`; only the `**Rule:**` and `**Why:**` lines are kept. **Reject** keeps it out for good: vir remembers a rejection by the sessions behind it, so it survives your notes being rewritten. `vir connect --reconsider <slug>` is the only way back.

Accepting doesn't touch CLAUDE.md. `vir sync-claude` offers each accepted rule as its own hunk, with its sources, and asks `y / n / s`. A rule counts as promoted only after its CLAUDE.md write succeeds. Nothing is ever promoted under `--force`, `--dry-run`, or without a terminal.

When new sessions repeat a rule you already accepted, the next run flags the new evidence for review instead of changing the rule. `vir status` shows how many rules are proposed, accepted, and awaiting CLAUDE.md approval.

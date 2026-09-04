---
title: How it works
description: The pipeline from transcript to note — filtering, classification, distillation, and what a note is made of.
---

## The loop

```
Claude Code sessions → vir → Obsidian vault → CLAUDE.md → better sessions → …
```

Sessions become notes. `vir sync-claude` feeds the best notes back into your project's CLAUDE.md, with a diff and your confirmation. The next session starts knowing what the last one learned. A daemon keeps the loop turning.

## The pipeline

Each `vir run` does five things in order:

1. **Scan.** Walk `~/.claude/projects/**/*.jsonl` and hash every file. A session is only reprocessed if its content changed, so reruns are idempotent and free.
2. **Filter.** Drop what isn't yours before any paid call (details below).
3. **Scrub.** Strip API keys, bearer tokens, absolute paths, and emails from what's left.
4. **Classify.** A cheap Haiku call reads the prose of the session and returns `{category, topic, project, confidence, themes}`. Anything at or below `0.6` confidence is dropped here.
5. **Distill.** The full transcript — tool calls included, large outputs trimmed — goes to the distill model, which writes the note body.

Every step records its outcome in `~/.vir/vir.db`, so nothing is silently skipped.

## What gets filtered, and why

On the author's machine, 1,386 transcripts produced 410 notes. That ratio is the point: most of what Claude Code writes to disk isn't a session you drove.

| Skipped as | What it is | Reversible? |
| --- | --- | --- |
| `workflow-transcript` | Phases of a multi-agent workflow | Yes — `workflowTranscripts: "include"` |
| `sidechain-transcript` | Subagent runs nested under a session | Yes — same knob |
| `agent-transcript` | Headless SDK agents (reviewers, verifiers) | Yes — `agentTranscripts: "include"` |
| `project-excluded` | A project you excluded in `vir projects` | Yes — `vir projects include <name>` |
| `project-pending` | A project you haven't decided on | Yes — decide |
| *(no reason)* | Low-signal by heuristic, or classify confidence ≤ 0.6 | No |

Detection is structural — directory shape and the first line's `entrypoint` field — so it costs nothing and runs before the classifier. Flipping a knob re-enters the transcripts on the next run without `--full`.

## Anatomy of a note

```markdown
---
topic: "Kie.ai returns 200 with an error body"
aliases:
  - "kie-ai-returns-200-with-an-error-body"
category: gotcha
project: "growthq"
session_id: 4f2a9c31
date: 2026-06-01T09:14:22.000Z
confidence: 0.86
themes:
  - kie error handling
  - retry safety
---
Project: [[growthq]]
Category: [[gotcha]]

The Kie.ai image endpoint answers HTTP 200 even when generation fails …

## Related
- [[retry-with-backoff-on-idempotent-writes-0c91be7a|retry-with-backoff-on-idempotent-writes]]
```

- **`topic`** is the title, chosen by the classifier after the single most durable lesson in the session — that's what makes retrieval rank a pointed note above a diary.
- **`category`** is one of four: `pattern`, `gotcha`, `decision`, `tool`. It's also the folder the note lives in.
- **`confidence`** is the classifier's score. The Obsidian plugin renders low-confidence notes dimmer.
- **`session_id` + `date`** are provenance: every claim traces back to the exact session that produced it.
- **`## Related`** is built from embedding neighbors, never from the model's guesses. On a real vault, 1 in 2,261 model-suggested links resolved; neighbor links resolve by construction.
- **`aliases`** lets a bare `[[kebab-topic]]` reference resolve in Obsidian even though the filename carries a hash suffix.

## Quality controls

Auto-distilled notes can be wrong, and a wrong note that reaches CLAUDE.md makes sessions worse, not better. The controls, in the order they apply:

- Transcript and project filtering before any API call.
- The `0.6` confidence floor between classify and distill.
- `vir review` — walk new notes, approve, edit, or reject. Verified notes rank first in retrieval; rejected ones move to `.rejected/`, recoverable.
- `vir lint` flags orphans, stale notes, and contradictions; `vir dedupe` merges near-duplicates.
- `vir sync-claude` never writes without showing the diff first.
- Everything is a markdown file. Read it, edit it, delete it.

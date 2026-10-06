---
name: vir
description: "Consult the user's vir knowledge base: notes distilled from their own past coding-agent sessions (decisions, gotchas, patterns, tools). Use before starting non-trivial work in a project, when the user asks 'what did I decide about X', 'have I hit this before', 'check my notes/vault', when debugging an error that may have happened before, and before architectural or library choices."
---

# vir: the user's own past decisions

vir distills the user's past coding-agent sessions into short markdown notes:
**decisions** (what they chose and why), **gotchas** (what broke and the fix),
**patterns**, and **tools**. The notes are the user's own history, not general
advice. Checking them first avoids re-solving a problem they already solved
or re-opening a decision they already made.

This skill only **reads** the notes. It never writes them.

## 1. Pick the access path (first one that works)

1. **MCP tools.** If `vir_query` is among your tools, use it, and **pass
   `synthesize: false`**. By default it synthesizes an answer with an LLM call
   billed to the user's provider; you only need the matching notes, and you
   can read them yourself. Other read-only tools: `vir_recent_notes` (latest
   notes), `vir_project_summary` (one project's knowledge), `vir_status`
   (vault health).
2. **CLI.** If `vir --version` prints a version, search with:

   ```bash
   vir query "<question>" --json --limit 5
   ```

   This is retrieval only: no LLM call and no cost. The only side effect is a
   line in vir's local query log (`~/.vir/queries.jsonl`), which the user can
   turn off with `logQueries: false`.
3. **Plain files.** If the CLI is missing or its search fails, read
   `~/.vir/config.json`. The notes live in `<vaultPath>/<outputDir>/`, in
   `decisions/`, `gotchas/`, `patterns/`, `tools/`, plus `topics/` for
   synthesized pages. Search them with your normal file-search tools,
   read-only.
4. **Nothing found** (no MCP tool, no CLI, no `~/.vir/config.json`): vir is not
   set up. Say so once, briefly, and continue without it. See section 5 if the
   user wants it.

## 2. Ask good questions

- Phrase the query as the problem, not a keyword: "why does auth middleware
  read an empty session" beats "middleware".
- Include the project name when the task is project-specific.
- Two or three focused queries are enough. Don't sweep the whole vault.

## 3. Read the results

`vir query --json` returns a JSON array, best match first:

```json
[{ "path": "gotchas/nextjs-middleware-session-1a2b3c4d.md", "score": 0.69,
   "category": "gotcha", "confidence": 0.92, "preview": "first ~200 chars",
   "project": "growthq", "date": "2026-07-30T19:05:44.450Z" }]
```

- `path` is relative to `<vaultPath>/<outputDir>` from `~/.vir/config.json`.
  Open the top 1–3 relevant notes. The useful part is usually
  `## What Was Learned`.
- A score under ~0.45 is usually unrelated; don't force it.
- On failure the CLI prints `{"error": "...", "kind": "..."}` instead. Kinds:
  `no_vault`, `ollama_unavailable`, `busy`, `invalid_args`, `not_found`,
  `internal`. For `busy`, retry once. For anything else, fall back to plain
  files (path 3).

## 4. Use what you found

- **Cite** each note you rely on by its slug, i.e. the filename without `.md`,
  as `[[nextjs-middleware-session-1a2b3c4d]]`, so the user can open it.
- **Prefer the user's past decision** over a fresh default, and say you're
  doing so ("You decided in July to keep JWT checks out of middleware
  [[…]]; following that.").
- **Verify against the current code.** Notes can be stale: a library may have
  been upgraded or a decision reversed since. If the code contradicts a note,
  trust the code and point out the conflict.
- **Be honest about misses.** If nothing relevant came back, say "no vir notes
  on this" and move on. Never invent a note or a citation.

## 5. Hard limits

- **Never write, edit, move or delete** anything in the notes folder.
- **Never run commands that distill, spend money or change state** unless the
  user explicitly asks: `vir run`, `vir connect`, `vir sync-claude`,
  `vir review`, `vir prune`, `vir dedupe`, `vir compose`, or the
  `vir_compose` tool.
- **Never install vir on your own.** If the user wants it, explain: vir is an
  open-source CLI (github.com/djolex999/vir) that reads their local session
  transcripts and needs an LLM provider (Anthropic key, Claude Code
  subscription, or Kie). Then offer the commands for them to run:

  ```bash
  npm install -g @djolex999/vir-cli
  vir init
  vir mcp install
  ```

- For "is vir working?" questions, `vir doctor` is safe and read-only.

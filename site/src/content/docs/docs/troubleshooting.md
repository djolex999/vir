---
title: Troubleshooting
description: Start with vir doctor. Then the failures people actually hit.
---

## Start here

```bash
vir doctor
```

Twelve checks always run, plus one session check per agent you configured: config validity, a live API-key probe (`codex login status` on `codex-cli`), vault path, output directory, session discovery (Claude Code and/or Codex), project decisions, agent-transcript detection, the SQLite database, daemon state, the query log, Ollama, the embedding provider, and the `claude` binary. Up to seven more appear when they apply: MCP registration (when `claude` is installed), provider preflight, backups, distill failures, pruned notes, the claude-cli limit pattern, and notifications. Three states each — ok, warn, fail — and a non-zero exit on any hard failure.

One of them is time-sensitive and easy to miss: **project decisions**. Transcripts from a project you haven't included or excluded sit as `project-pending` and are never distilled — and Claude Code prunes them at around 30 days. Doctor tells you the age of the oldest one, because past that point the decision is moot.

## Common failures

**`vir run` finds 0 new sessions but I have plenty.**
Check the preflight line: `N files found · M cached · K new`. If `found` is 0, `claudeProjectsDir` (or `codexSessionsDir`) is wrong. If everything is `cached`, nothing changed since the last run — that's correct. Use `vir projects` to see whether transcripts are sitting in `project-pending`.

**Notes are empty or a run "succeeded" but wrote nothing.**
A provider that answers HTTP 200 with an error in the body (Kie does this). Run `vir reconcile --dry-run` to list affected sessions, then `vir reconcile` to retry them with the cache bypassed.

**The daemon isn't running.**
`vir status` shows daemon state. On macOS, `launchctl list | grep vir`. On Linux, `systemctl --user status vir.timer`; if the user bus is unreachable (WSL, containers), vir falls back to cron — `crontab -l` shows the entry. `vir schedule uninstall && vir schedule install` re-registers.

**"via tfidf (embeddings failed)" in query output.**
Different from `(no provider)`. The provider was detected but calls failed — Ollama not serving (`ollama serve`), or the model missing (`ollama pull nomic-embed-text`). Notes that missed their embedding heal on the next run.

**Query results mention excluded mismatched notes.**
Vectors from two different embedding models exist in the vault. `vir embed --force` re-embeds everything with the current provider; it states the count first.

**A session keeps failing.**
After three consecutive failures it's parked. Fix the cause (usually the provider), then `vir reconcile --force`.

**`claude-cli` or `codex-cli` runs stop early.**
By design: 25 sessions per run, and an immediate halt at a subscription limit with the reset time. The rest are picked up on the next cycle.

**`codex-cli` fails with "run `codex update`".**
vir switches off Codex's tools by feature name, and your Codex doesn't know one of them. Update Codex, or switch provider. Checked on codex-cli 0.160.1.

**Codex lists the vir tools but every call fails.**
Codex asks before each MCP tool call. In interactive Codex, approve it ("Always allow" stops the prompts); headless `codex exec` never approves, so the tools don't work there.

## Logs

```
~/.vir/daemon.log      what each run did, plain text
~/.vir/cost.log        one line per model call
~/.vir/queries.jsonl   one line per retrieval
```

## Getting help

Issues at [github.com/djolex999/vir/issues](https://github.com/djolex999/vir/issues). Include `vir doctor --json` output, your OS and Node version, and the relevant `daemon.log` lines.

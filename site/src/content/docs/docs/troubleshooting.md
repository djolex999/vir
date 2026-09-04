---
title: Troubleshooting
description: Start with vir doctor. Then the failures people actually hit.
---

## Start here

```bash
vir doctor
```

Thirteen checks: config validity, a live API-key probe, vault and output paths, session discovery, project decisions, agent-transcript detection, the SQLite schema, daemon state, backups, Ollama, the `claude` binary, MCP registration, and claude-cli limit detection. Three states each — ok, warn, fail — and a non-zero exit on any hard failure.

## Common failures

**`vir run` finds 0 new sessions but I have plenty.**
Check the preflight line: `N files found · M cached · K new`. If `found` is 0, `claudeProjectsDir` is wrong. If everything is `cached`, nothing changed since the last run — that's correct. Use `vir projects` to see whether transcripts are sitting in `project-pending`.

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

**`claude-cli` runs stop early.**
By design: 25 sessions per run, and an immediate halt at a subscription limit with the reset time. The rest are picked up on the next cycle.

## Logs

```
~/.vir/daemon.log      what each run did, plain text
~/.vir/cost.log        one line per model call
~/.vir/queries.jsonl   one line per retrieval
```

## Getting help

Issues at [github.com/djolex999/vir/issues](https://github.com/djolex999/vir/issues). Include `vir doctor --json` output, your OS and Node version, and the relevant `daemon.log` lines.

---
title: "query-logging-append-only-architecture"
description: "Pattern distilled by vir from a Claude Code session on 2026-08-13. This Claude Code session shipped two releases of the `vir` CLI (a LLM-distillation engine for building Obsidian vaults f"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `a2bc5634` · 2026-08-13 · classifier confidence 0.92
:::

## Summary

This Claude Code session shipped two releases of the `vir` CLI (a LLM-distillation engine for building Obsidian vaults from Claude Code transcripts): **0.16.0** added retrieval logging to `~/.vir/queries.jsonl`, and **0.17.0** introduced a new `claude-cli` distill provider that consumes Claude Code subscription quota instead of API spend. Both releases were built **entirely via TDD**, with minimal viable tests written first and all changes verified against a suite that grew from 502 to 534 tests. Both are now live on npm and globally installable.

## What Was Learned

1. **Schema-enumerated regression guards catch silent drops.** `buildInitConfig` had silently reset four config keys on re-init (`bug #5`, `projects`, `logQueries`, `embeddingProvider`) because carry-over relied on remembering. A test enumerating `ConfigSchema.innerType().shape` and requiring a non-default sample value for every key will fail on any future drop — non-default is load-bearing since dropped keys fall back to zod defaults. Applies to any serializer/builder mirroring a schema.

2. **Probe the binary before designing around it.** The claude-cli integration started by designing around assumed transcript pollution; a 10-minute empirical probe found `--no-session-persistence` as the solution, verified per-invocation `--model` support, and confirmed the `entrypoint: "sdk-cli"` signature. Investigation-then-build with a stop gate consistently beat building against assumptions.

3. **Unverifiable detection needs an evidence path.** The subscription-limit regex is docs-sourced and can't be reproduced on demand. The pattern: unmatched error envelopes log raw to `daemon.log` once per run (deduped); unknown failures fail toward the safe action (halt, never retry against a wall); a doctor row reports whether the pattern has ever matched, so the first real hit confirms or corrects the regex without misclassification damage.

4. **Best-effort logging must never throw into the critical path.** Retrieval logging is guarded by an outer `try/catch` so formatting or disk failures never fail a query. Failures are reported on stderr only (never stdout — the MCP JSON-RPC channel is safe) and mark `~/.vir/queries.failed` for doctor.

5. **Neutral working directories prevent context leakage.** The claude-cli provider spawns from `~/.vir`, not the project root, so distill prompts never accidentally load a project's `CLAUDE.md` into the context. This was un-omittable by making `cwd` a module constant with no injection point.

## Context (project: vir, category: pattern, date: 2026-08-13T03:38Z)

**Released:** 0.16.0 (retrieval logging) + 0.17.0 (claude-cli provider), both on npm, both tarball-verified identical to the local builds that passed 534 tests.

**0.16.0 changelog:** Retrieval logging to `~/.vir/queries.jsonl` (append-only, 5 MB rotation with one `.1` generation kept). Every `vir query` and MCP `vir_query` appends one JSONL record *after* search resolves, *before* synthesis. `SearchOutcome` gained `candidates` (pre-topK survivors) and `provider` provenance fields (null on TF-IDF). New `vir queries` command with a 20-query minimum sample before dead-weight list renders (null, never []). Config `logQueries: true` default, user-disable with `false`. Doctor check for failing query log writes.

**0.17.0 changelog:** New `claude-cli` distill provider (keyless, consumes Claude Code subscription quota). Spawns `claude -p` with `--no-session-persistence` (structurally un-omittable) from a neutral `~/.vir` cwd. Subscription limits are non-retryable walls: `ClaudeCliLimitError` halts run/reconcile with the reset time, never touching attempt counters. 25-session batch cap per run. Docs-sourced limit regex with evidence logging (raw envelopes once per run) and a doctor row reporting whether it's been confirmed. `cost.log` records `estimated_cost_usd: null` for CLI calls (never $0.00). Fixed a fourth config key (`embeddingProvider`) that was silently reset on re-init since 0.15.0.

**Outstanding thread:** Anthropic API balance is empty — irrelevant for claude-cli users, but your own default-provider distills and `vir query` synthesis will 400 until topped up.

## Related

- [silent-failure class unfinished](/vault/gotchas/silent-failure-class-unfinished-7bfa9706/)
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- ollama-probe-null-breaks-inference
- [mirrored-sweep-for-new-entity-type](/vault/patterns/mirrored-sweep-for-new-entity-type-7415aa64/)
- [json-output-contract](/vault/decisions/json-output-contract-7bcca3cb/)

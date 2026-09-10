---
title: "query-logging-as-ground-truth"
description: "Pattern distilled by vir from a Claude Code session on 2026-08-13. Extended vir with a complete Claude Code CLI distill provider and retrieval telemetry, both shipped (v0.16.0 + v0.17.0)."
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `a2bc5634` · 2026-08-13 · classifier confidence 0.95
:::

## Summary

Extended vir with a complete Claude Code CLI distill provider and retrieval telemetry, both shipped (v0.16.0 + v0.17.0). TDD throughout: 534 green tests, verified build-to-tarball-to-install chain, a new schema-enumerated config regression guard that immediately found a 4-month-old drop.

## What Was Learned

### Retrieval logging (v0.16.0)
- **Best-effort by contract beats exceptions.** `recordQueryEvent` wraps with outer try/catch — logging failures never propagate into queries. `appendQueryLog` reports to stderr once per run on failure (never stdout — MCP JSON-RPC is safe). `~/.vir/queries.failed` marks the failure for doctor.
- **Sample gates signal.** `deadWeight: null` below 20 logged queries prevents "never surfaced" from reading as "unused" when in fact it's "never asked about." The gate appears at the report boundary, not the log layer — same data, honest label.
- **Rotation by size not time.** 5 MB cap → renames to .1, keeps both generations. Simpler than cron-dependent cleanup, bounded at ~10 MB total.
- **Verified status lives where it's computed.** `isVerified` exported from retriever; no second drift-prone reimplementation in the query log.

### Claude CLI provider (v0.17.0)
- **Un-omittable options via arity.** `buildClaudeCliArgs(model)` takes only a model; `--no-session-persistence` cannot be dropped. Constant spawn cwd `~/.vir` prevents CLAUDE.md leakage. These are structural guarantees, not comments.
- **Walls are not 429s.** `ClaudeCliLimitError` is non-retryable and halts cleanly: one call made, attempt counters untouched, reset time in the message. The limit regex is docs-sourced and unverified; raw envelope logged once/run as evidence; doctor reports "unverified" until the marker exists — fail safe, not silent.
- **Batch caps are a quota problem.** The 25-session limit is reasoned (50 CLI calls ≈ a heavy session; drains 74-note backlog in 3 cycles ~12h). API providers never capped. Deferred sessions record nothing, so they re-enter naturally.
- **Null cost means null.** `estimated_cost_usd: null` (never $0.00). Excluded from total/median/p90 dollar aggregates; surfaced separately as `subscriptionCalls`. A zero silently corrupts accounting the way a missing DEFAULT_PRICING row would have.
- **Config carries through re-init.** Schema-enumerated test enumerates all keys, enforces non-default samples, catches silently-dropped keys on first occurrence. Already found `embeddingProvider` (dropped since 0.15.0) and three other pre-existing drops: `bug5`, `projects`, `logQueries`.

### Real data
- **API vs CLI note quality:** 3 real sessions distilled through both paths. Structure preserved (same headers, sections); API notes 10–35% longer. **2 of 3 classified differently** (decision→gotcha/pattern) — same Haiku model, same prompt, sampling variance not provider gap. Worth knowing before vault migrations.
- **Cost records are honest:** 3 genuine `provider: "claude-cli", estimated_cost_usd: null` landed in cost.log. No transcripts written to `~/.claude/projects` (empty project dir for `~/.vir` spawn cwd — filter never sees them).

## Context

- **project:** vir
- **category:** pattern (retrieval logging + provider abstraction)
- **date:** 2026-08-13T03:38:47Z
- **releases:** v0.16.0 (retrieval logging + schema-enum guard), v0.17.0 (claude-cli provider)
- **test count:** 502 → 504 → 534 (retrieval) + 532 (provider) = 534 total green
- **git:** e080cc3, tag v0.17.0, both pushed and verified on remote
- **npm:** published, tarball-verified byte-for-byte, installed globally from registry

## Related

- ollama-probe-null-breaks-inference
- [silent-failure class unfinished](/vault/gotchas/silent-failure-class-unfinished-7bfa9706/)
- [thesis-as-launch-launchpad](/vault/decisions/thesis-as-launch-launchpad-395d2f80/)
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)

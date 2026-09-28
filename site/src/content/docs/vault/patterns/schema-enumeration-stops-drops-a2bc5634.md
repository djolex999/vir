---
title: "schema-enumeration-stops-drops"
description: "Pattern distilled by vir from a Claude Code session on 2026-08-13. Extended the `vir` CLI (a Claude Code session distiller into Obsidian) with retrieval logging and a claude-cli provider."
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `a2bc5634` · 2026-08-13 · classifier confidence 0.8
:::

## Summary

Extended the `vir` CLI (a Claude Code session distiller into Obsidian) with retrieval logging and a claude-cli provider. Built and shipped two releases (0.16.0 retrieval logging, 0.17.0 claude-cli keyless/subscription-quota path) in a single session using TDD, both published to npm with tarball verification and comprehensive testing (534 tests green).

The single most important structural win: a schema-enumerated test that enforces config key survival across re-init by construction—caught and fixed a fourth silent-drop bug (`embeddingProvider` was reset on every `vir init` since 0.15.0) on its first run, preventing future regressions automatically.

## What Was Learned

- **Enumerate the schema in tests that must track it.** `buildInitConfig` had silently dropped a config key four separate times (bug #5, projects, logQueries, embeddingProvider) because carry-over relied on memory. The fix that ends the class: a test enumerating `ConfigSchema.innerType().shape` that fails on any key without a declared non-default survival sample—non-default is load-bearing because dropped keys fall back to the zod default. Applies to any builder/serializer that must mirror a schema key-for-key. config-mutation-risks

- **Probe the actual binary before designing around assumptions.** The claude-cli plan assumed transcript pollution and designed a defense via the agent-transcript filter. A 10-minute empirical probe discovered `--no-session-persistence`, which dissolved the problem entirely instead of managing it. Same probe verified `entrypoint: "sdk-cli"` and per-invocation `--model` pinning. Investigate-then-build (with a stop gate) beat building against constraints that never existed. Applies to any new external-tool integration.

- **Unverifiable detection gets an evidence path, not trust.** The subscription-limit regex is docs-sourced and cannot be triggered on demand. Pattern: (1) unmatched errors log raw-envelope evidence once per run for later inspection, (2) unknown failures fail toward the SAFE action (halt on limit, never retry against a wall), (3) a doctor row reports whether the pattern has ever matched. The first real hit confirms or corrects the regex without ever having misclassified. Applies to any parser for output shapes you cannot reproduce in a test. rate-limit-defensive-detection

- **Structural guarantees beat defensive coding.** Two architectural constraints became un-omittable by construction: `--no-session-persistence` hardcoded into `buildClaudeCliArgs(model)` (which takes only a model, making it impossible for a caller to drop the flag), and a fixed spawn cwd of `~/.vir` as a module constant (preventing any project's `CLAUDE.md` from leaking into distill context). Prevents the class of "this should never happen" bugs by making them unreachable. Applies to any safety-critical per-invocation flag.

- **Best-effort logging must never fail the critical path.** `recordQueryEvent` wraps both formatting and append in an outer `try { … } catch { }` that lets distills proceed even if the query log file is locked, disk full, or permissions-broken. A failing test proved this guard was missing (retry tests discovered the throw), so outer retry logic never needs to anticipate logging failures. Applies to any telemetry system attached to core operations.

- **Real-world testing revealed classification drift under different providers.** Three sessions re-distilled through claude-cli vs their stored API results showed the same section structure but 2 of 3 classified differently (`decision → gotcha`/`pattern`, with different titles). Both use the same Haiku classifier, so this is sampling variance, not quality difference—but it means provider migration requires re-distill for consistent taxonomy. Worth documenting for future work.

- **One-off guard tests pay back immediately.** The schema-enumeration test, added near the end as defensive boilerplate, caught a regression within minutes that had been silently corrupting configs for ~2 weeks. 10 minutes of test setup prevented the fourth incident in the same class from ever shipping. Applies to any mutation that must preserve a structured contract.

## Context

This project (vir) distills Claude Code transcripts into an Obsidian vault, starting with two API providers (Anthropic direct + Kie proxy); this session added a third (Claude Code CLI, keyless/subscription-quota). The retrieval logging feature enables usage analysis on both search backends; the claude-cli provider enables zero-setup distillation for Claude Code users. Both required cross-system plumbing (config, cost reporting, doctor diagnostics, init wizard, run-loop halt semantics) and complete verification against real distilled sessions. Session date: 2026-08-13, ending with commit e080cc3 on main, v0.17.0 published and verified from npm.

## Related

- trailing-path-delimiter-cwd-search
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- [json-output-contract](/vault/decisions/json-output-contract-7bcca3cb/)
- uncommitted-work-collision-risk
- defensive-null-guards-in-persistence

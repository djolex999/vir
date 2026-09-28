---
title: "hybrid-model-routing"
description: "Decision distilled by vir from a Claude Code session on 2026-05-29. A hybrid model-routing feature was added to the `vir` project's distillation pipeline. It selects between a \"smart\" (`di"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `376a7c67` · 2026-05-29 · classifier confidence 0.92
:::

## Summary

A hybrid model-routing feature was added to the `vir` project's distillation pipeline. It selects between a "smart" (`distill`) and "cheap" (`distillFast`) model based on content classification category and estimated token count. A security review confirmed no new vulnerabilities were introduced.

## What Was Learned

**Hybrid model routing pattern:**
- `selectDistillModel(classification, inputTokens, models)` picks model tier based on two signals: content category (`"pattern"`, `"gotcha"`, `"decision"`, `"tool"`) and a `chars/4` token heuristic on scrubbed content.
- A `distillThreshold` config field controls the token boundary between fast and smart tiers.
- `Distiller.modelFor` plumbs routing through; `--force-model` CLI flag short-circuits it entirely.
- `Distiller.distill()` accepts an optional `model` param, defaulting to `this.distillModel` (smart model — safe default). The sole caller `run()` always passes the routed model explicitly.

**Config schema additions:**
- `distillFast` and `distillThreshold` are optional fields in `~/.vir/config.json`.
- CLI `init` defaults `distillFast` to Haiku for new installs.

**Behavioral gotcha (re-init on existing installs):**
- Re-running `init` on an old install silently upgrades from "hybrid off" to "hybrid on with Haiku fast tier" via `existing?.models?.distillFast ?? <default>`. This contradicts the schema comment claiming existing installs keep using `distill` unchanged (that guarantee only holds via `loadConfig`, not `init`). A UX/doc inconsistency, not a security issue.

**Security posture (confirmed clean):**
- Model name strings flow from user-owned `~/.vir/config.json` (0o600) → `callKie`/`callAnthropic` request body via `normalizeModelName` canonicalization. Not attacker-controllable.
- Classification `category` is validated against a hard-coded `CATEGORIES` allowlist before reaching routing logic — junk LLM output is clamped to a wrong-tier pick at worst.
- No shell, SQL, path traversal, eval, deserialization, SSRF, or template sinks touched by this change.

## Context

- **Project:** vir
- **Category:** decision
- **Date:** 2026-05-29T14:44:41.573Z

## Details

- `src/pipeline/distiller.ts` — `Distiller.modelFor`, `Distiller.distill`, `selectDistillModel`
- `src/config.ts` — schema for `distillFast`, `distillThreshold`
- `src/cli.ts` — `init` command defaults
- `src/pipeline/run.ts` — caller of routed model, prints tip line
- Pattern: category-based routing with token-count threshold is reusable for any tiered LLM cost-optimization feature

## Related

- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- explicit-thinking-disable-on-model-upgrade
- auth-onboarding-routing
- v1-architecture-and-sequencing
- [model-judge-human-mismatch](/vault/gotchas/model-judge-human-mismatch-b147175c/)

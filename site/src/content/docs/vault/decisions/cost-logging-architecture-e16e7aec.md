---
title: "cost-logging-architecture"
description: "Decision distilled by vir from a Claude Code session on 2026-05-27. This session shipped vir 0.7.0, adding cost visibility (`src/cost/` module, `callLLM` cost-recording chokepoint, `vir co"
editUrl: false
---

:::note[Written by vir, not by a human]
**Decision** · session `e16e7aec` · 2026-05-27 · classifier confidence 0.92
:::

## Summary

This session shipped vir 0.7.0, adding cost visibility (`src/cost/` module, `callLLM` cost-recording chokepoint, `vir cost` command, `--dry-run` and `--force-model` flags) and skill-result stripping in `toolCallFilter.ts`. Post-release, a Haiku-vs-Sonnet calibration A/B (5 sessions × 2 models, `vir calibrate` command) validated pricing accuracy and quality trade-offs, informing a v0.8.0 hybrid routing spec.

## What Was Learned

**Cost recording architecture:** The single chokepoint for all cost records is `callLLM` in `distiller.ts`. It records one JSONL line per *successful* call when `opts.cost` is provided; best-effort (never throws); real tokens from Anthropic/Kie `usage` field when present, else chars/4 with `token_source: "estimated"`. Kie returns real `usage` (confirmed live) — no estimation needed in practice. The `doctor` probe intentionally omits `cost` context to avoid logging validation pings.

**Skill-result stripping placement:** The strip pass belongs in `toolCallFilter.ts` (which owns the tool-block grammar), not `filter.ts` (which is only the heuristic scorer). It runs *before* the `mode === "off"` early-return so it always applies, including in off mode. Real transcripts use `"skill"` as the field name in Skill tool_use JSON.

**Dry-run estimation calibration:** Initial constants (classify output 120 tok, distill output 700 tok, chars/4 input) produced ~5.5× underestimates. Calibrated from real data to classify 350 / distill 4500 / chars/3. Even recalibrated, the dry-run is a rough projection — code/JSON sessions tokenize denser than prose.

**Haiku vs Sonnet distill quality:** Haiku holds parity on routine and tool-heavy sessions (equal-or-more concrete detail). It degrades on decision-heavy sessions (misses higher-order judgment/meta lessons) and very large sessions (emits more tokens as exhaustive inventory; Sonnet synthesizes and says *why*). Hybrid routing — Haiku default, Sonnet on `decision` category or large sessions — recovers quality at ~$9/backfill vs $21 Sonnet-only or $7 Haiku-only.

**Kie pricing ratio:** vir's pricing table uses a uniform 28% discount (Haiku/Sonnet ratio 3.0×). Dashboard-verified at 3.0×. No pricing fix needed.

**Commander exit-code swallow:** Commander swallows the exit code when an async action handler rejects after a tool call — `process.exitCode` stays 0 even on failure. Wrap action handlers in `(async()=>{…})().catch(e=>{console.error(e); process.exit(1)})` or use `.exitOverride()`.

**Cost log purge safety:** Identifier-based purges (by session ID) are dangerous when the same session appears across multiple record categories (validation, calibration, production). Use timestamp cuts when data has temporal separation.

**Version state is conversation context, not memory:** Before suggesting a publish, verify with `npm view <pkg>@<version> version`. Version state rebuilt from conversation nearly burned a version number.

## Context

- **Project:** vir
- **Category:** decision
- **Date:** 2026-05-27T01:09:43.261Z

## Details

- `src/cost/{pricing,log,report}.ts` — the cost module (provider-aware pricing, JSONL log, pure aggregation)
- `src/pipeline/distiller.ts` — `callLLM` cost chokepoint, `resolveModelShorthand`, `Distiller` constructor `forceDistillModel` option
- `src/pipeline/toolCallFilter.ts` — skill-strip (`SKILL_PAIR_RE`, `stripSkillResults`, always-applied)
- `src/pipeline/run.ts` — `RunOptions.forceDistillModel`, `RunOptions.dryRun`, dry-run estimation branch
- `/tmp/calib/REPORT.md` — Haiku vs Sonnet calibration report (5 sessions × 2 models, 167 lines)
- v0.8.0 backlog: P0 exit-code propagation fix, P1 Kie 404 retry, hybrid model routing, `kieTopUpTier`

## Related

- [schema-enumeration-stops-drops](/vault/patterns/schema-enumeration-stops-drops-a2bc5634/)
- [model-judge-human-mismatch](/vault/gotchas/model-judge-human-mismatch-b147175c/)
- v1-architecture-and-sequencing
- documentation-code-drift-at-scale
- explicit-thinking-disable-on-model-upgrade

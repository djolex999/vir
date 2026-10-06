# Connect pass: calibration and evaluation (October 2026)

Spec: `docs/superpowers/specs/2026-10-06-connect-pass-design.md` (§2 calibration, §11 evaluation).
Vault: the owner's (`~/Vir/vir`), 206 live notes → **1,292 lessons** from 210 sessions (60 of them from archived merge losers), embedded with `nomic-embed-text` (Ollama).

## Calibration (2026-10-06)

**Pairs.** 60 cross-session lesson pairs, 15 per cosine band, seed 42. Labeled same-lesson / different by a Fable pass (strict: same problem *and* same fix or decision); the owner reviewed and approved the labels.

| Band | Same lesson | Precision |
|---|---|---|
| 0.55–0.65 | 0 / 15 | 0.00 |
| 0.65–0.75 | 0 / 15 | 0.00 |
| 0.75–0.85 | 2 / 15 | 0.13 |
| > 0.85 | 15 / 15 | 1.00 |

Spec rule (pair precision ≥ 0.9) → **`connectMinSim` = 0.85**.

**Purity.** At 0.85 the vault forms 5 clusters (sizes 4, 3, 3, 3, 3); all 5 are a single lesson. The cluster set is identical for `connectCoreSim` 0.80, 0.85 and 0.88, so the centroid guard is a backstop at this cutoff → **`connectCoreSim` = 0.85**.

| Cluster | Lesson | Sessions | Span | Qualifies |
|---|---|---|---|---|
| C1 | `spawn` argv needs `--` against argument injection | 2 | same day | no |
| C2 | Container ownership check doesn't authorize sink args | 2 | same day | no |
| C3 | Anchored MIME regex, exclude SVG | 3 | same day | no (span) |
| C4 | Ephemeral image uploads live only in `goalInputs` | 3 | 3 days | no (span) |
| C5 | Paddle tax mode is baked into prices; archive + recreate | 3 | 7 days | **yes** |

**Finding.** Lesson-level recurrence in this vault is rare at a precise cutoff. Most near-duplicates are the same lesson recorded by several sessions within a few days (parallel review agents, reruns), which the 7-day rule rejects by design. Pre-calibration baseline for comparison: provisional 0.80/0.78 gave 32 clusters / 16 candidates, most of them mixed lessons (0.75–0.85 precision 0.13).

**Decision (owner, 2026-10-06).** Ship at 0.85/0.85 — precise over plentiful. The spec's "≥ 70% of the first 20 proposals accepted" gate can't be measured on one candidate; it is tracked over time instead (below), as the vault grows.

## Evaluation log

| Date | Run | Candidates | Proposed | Accepted | Rejected | kept/total |
|---|---|---|---|---|---|---|
| 2026-10-06 | 0.25.0, 1 LLM call (claude-cli quota) | 1 | 1 | 1 | 0 | 3/3 |

**2026-10-06 run.** The one candidate (C5) became: *"After changing the Paddle account-level tax-inclusive toggle, archive and recreate all existing prices — the toggle never retroactively updates prices already created."* Scope `project:pripremi-rs`, 3 sessions (2026-05-06 → 2026-05-13), all three quotes verbatim. Accepted by the owner in `vir review --insights`. After accepting, `vir query "paddle tax inclusive prices"` returns the rule first (0.815, `insight`), ahead of the original gotcha note (0.557).

**Found during the run.** Promotion was blocked by a pre-existing `sync-claude` bug: the project folder is `pripremi.rs`, its slug is `pripremi-rs`, and `projectClaudePath` only matched exact folder names, so that project's CLAUDE.md had never received a VIR block. Fixed in 0.25.1. That package turned out to be built from pre-fix code (a merge landed one second into the publish's build), so the fix actually shipped in 0.25.2. **Promoted 2026-10-06** with 0.25.2: `vir sync-claude pripremi-rs`, `y` to the rule and `y` to the block; `~/projects/pripremi.rs/CLAUDE.md` received its first VIR block (15 entries plus the rule under `## Rules (from vir)`), existing content unchanged byte-for-byte; the row moved to `accepted | promoted` only after the write. A cosmetic issue too: a merged (archived) source cites its live winner, so the same `[[slug]]` can appear twice in the evidence list. Fixed in 0.25.3: merged sources are now marked `merged`.

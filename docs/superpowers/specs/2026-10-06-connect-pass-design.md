# Connect pass v1: recurring lessons → proposed rules (design)

Date: 2026-10-06
Status: design approved in brainstorming; spec pending owner review
Repo: `vir` (CLI 0.24.3)
Related: `tasks/vir-unboxed.md` (Follow-ups → "Connect pass")

## Goal

vir should notice when you keep learning the same lesson, and propose it as a
rule. A gotcha you hit in three sessions over two weeks should stop being three
notes and become one line in CLAUDE.md, but only after you have read it, checked
its sources, and said yes.

This is the first piece of "connect the unconnected". It produces new knowledge
that is **derived from and cited to** distilled notes, never invented
alongside them.

## Decisions made in brainstorming

| Question | Decision |
|---|---|
| What kind of new knowledge in v1 | **Recurring → rule** only |
| Later versions | v2: contradictions (decisions that conflict or went stale). Cross-project transfer goes to retrieval (cross-project search + problem-signature tags), **not** the connect pass. Auto topic pages: dropped |
| Where insights live | Their own folder, separate from distilled notes |
| Trust model | Every insight cites its source notes and goes through review before it counts |
| Approach | Embedding clusters of individual lessons → one LLM call per cluster to verify and write → proposed rule |
| Recurrence threshold | **≥ 3 distinct sessions spanning ≥ 7 days** |
| Promotion | Through the existing `sync-claude` block, **never automatic**. Each rule is its own diff hunk with its source notes. The owner approves or rejects **per rule**. Rejections are remembered. Nothing reaches CLAUDE.md without an explicit yes |
| Code | Spec only for now; implementation plan after review |

## Background: what exists today (verified 2026-10-06)

- **Notes are per session and hold several lessons.** In the owner's vault (206 live notes), 202 have a `## What Was Learned` section, holding **1,196 bolded lesson items**, about 6 per note. A gotcha note's `themes` frontmatter lists 3–4 unrelated threads. So recurrence must be detected per **lesson**, not per note.
- **`themes` tags don't line up across notes.** Only a handful repeat (`input-validation` ×6, `documentation-drift` ×4), so tag counting can't find recurrence.
- **`vir dedupe`** merges near-duplicate notes. The loser goes to `archived/` and the winner gets an `## Archived Duplicates` section linking it (12 notes today). A merge therefore hides recurrence evidence, but the link preserves it.
- **`vir lint`** already has an LLM contradiction check (`src/lint/linter.ts:156`). It ranks up to 20 note pairs by topic-token overlap. v2 will replace that ranking with this spec's lesson clusters.
- **`vir sync-claude`** (`src/cli.ts:515`, `src/claude/updater.ts`) rebuilds a `<!-- VIR:START -->…<!-- VIR:END -->` block from the DB on every run, shows a diff, and asks one y/n for all files. `--force` applies without asking.
- **Retrieval reads the whole output folder.** `loadIndex` (`src/search/retriever.ts:327`) walks every `.md` under the vir output folder, so anything written there is searchable unless explicitly excluded.
- **Similarity thresholds are per embedding model** (`src/search/thresholds.ts`). Whole-note doc-doc cosine runs p50 0.744 / p90 0.80 on nomic. Lesson-level distributions are unmeasured.

## Design

### 1. Lesson extraction

A **lesson** is one bolded item under `## What Was Learned`: a line starting `**…**` or `- **…**`, plus its continuation lines up to the next item, blank line or heading. A session note without that section yields one lesson (its `## Summary` paragraph).

Sources:
- every live session note in the category folders (`gotchas/`, `patterns/`, `decisions/`, `tools/`);
- every archived note linked from a live note's `## Archived Duplicates`. Its lessons count as evidence, but citations point to the **live winner**, because the archive is out of every read path.

Never extracted: articles, PDFs, topic pages, `insights/` (no feedback loop), `.rejected/`, archived notes nobody links.

Each lesson stores: note path, session id, note date, project, category, item index, text, a content hash, and an embedding. Re-running extraction only touches notes whose content hash changed.

### 2. Clustering

1. Embed each lesson with the active embedding provider (`resolveEmbeddingProvider`). Embeddings are cached by `(content hash, model)`.
2. Link every lesson pair with cosine ≥ `connectMinSim` (new per-model field in `thresholds.ts`), and take connected components.
3. Single-link chaining guard: drop any member whose cosine to its component's centroid is below `connectCoreSim`. Repeat once. Cap components at 20 members, keeping the closest to the centroid.
4. Without an embedding provider, fall back to TF-IDF cosine over lesson text with the same pipeline and stricter defaults. `--dry-run` and the run summary say `clustering: tf-idf (lower recall)`.

`connectMinSim` / `connectCoreSim` are **calibrated, not guessed**. The plan's first task measures lesson-level cosine distributions on the owner's vault, hand-labels about 60 pairs, and picks the values that keep labeled precision ≥ 0.9.

At ~1,200 lessons, that's ~720k pairs: an in-memory pass, no index needed.

### 3. Recurrence qualification (deterministic, before any LLM call)

A cluster becomes a **candidate** only if all of these hold:
- ≥ 3 **distinct session ids**, counting archived merge losers;
- `last_seen − first_seen ≥ 7 days`, using note dates;
- it doesn't match an existing insight that is `rejected`, or `accepted` with no new sessions (see §6, fingerprints).

Candidates are ranked by distinct sessions, then span, then project count. A run sends at most `connectMaxCandidates` (default 10) to the LLM. The rest are reported as "deferred".

### 4. Verify and write (one LLM call per candidate)

The model gets the cluster's lessons, each with an id, its project, date and text. It must return JSON:

```json
{
  "same_lesson": ["L12", "L40", "L77"],
  "rule": "Imperative one-liner a developer can follow.",
  "why": "One or two sentences on the failure it prevents.",
  "evidence": [{ "id": "L12", "quote": "verbatim substring of L12" }]
}
```

Validation (deterministic, after the call):
- `same_lesson` ⊆ the cluster's ids. Anything else is discarded.
- Every `evidence.quote` must be a whitespace-normalized substring of its lesson's text. A failed quote drops that piece of evidence.
- After dropping, the remaining lessons must still meet §3 (≥ 3 sessions, ≥ 7 days). Otherwise the candidate is logged as `unverified` and nothing is written.
- **Scope is computed, not asked:** all members in one project gives `project:<name>`; otherwise `global`.

Model: `models.distill`. Cost is logged under stage `connect`, so `vir cost` reports it. On `provider: "claude-cli"` it consumes quota like every other stage.

### 5. Output: insight notes

Path: `<outputDir>/insights/rules/<slug>.md`, where the slug is a kebab of the rule plus a short fingerprint suffix.

```markdown
---
kind: insight
insight_type: recurring-rule
status: proposed            # proposed | accepted | rejected
promotion: none             # none | promoted | declined
scope: global               # or project:<name>
fingerprint: 3f9a…
sessions: 4
projects: ["growthq", "pripremi-rs"]
first_seen: 2026-06-02
last_seen: 2026-09-21
sources:
  - "[[next16-proxy-rename-1a2b3c4d]]"
  - "[[auth-middleware-hydration-5e6f7a8b]]"
generated: 2026-10-06T12:00:00Z
model: claude-sonnet-5
---
**Rule:** <rule>

**Why:** <why>

## Evidence

- [[next16-proxy-rename-1a2b3c4d]] (growthq, 2026-06-02): "<quote>"
- …
```

The DB is the source of truth for `status` / `promotion`. Frontmatter mirrors it for Obsidian/Dataview, and is rewritten whenever the DB state changes.

### 6. State and fingerprints

New tables, using `db.ts`'s existing `CREATE TABLE IF NOT EXISTS` pattern:

- `lessons(id, note_path, session_id, note_date, project, item_index, text, content_hash, archived_via)` and `lesson_embeddings(content_hash, model, vector)`.
- `insights(fingerprint, slug, insight_type, status, promotion, scope, rule, why, member_hashes JSON, sessions, projects JSON, first_seen, last_seen, created_at, updated_at)`.

**Fingerprint** = a hash of the sorted member lesson content hashes. A new candidate **matches** an existing insight when its member set has Jaccard ≥ 0.5 with that insight's. On a match:
- `rejected`: skip silently. This is how rejected rules stay rejected.
- `proposed` / `accepted`: update the evidence (members, sessions, dates, sources). **Never rewrite `rule`/`why`**, since the owner may have edited them. Re-show it as proposed only if it was still proposed.
- `promotion: declined` stays declined (see §8).

`vir connect --reconsider <slug>` resets a rejected or declined insight to `proposed` / `none`. It's the only way back.

### 7. Serving gate and isolation

- **Retrieval** (`loadIndex`, `vir query`, MCP): skip `insights/` except notes whose DB status is `accepted`. Accepted rules are indexed as `kind: insight` and rank like verified notes.
- **Every other pass** (`dedupe`, `lint`, `audit`, `prune`, related-links, `compose`, `summarize`, stray-file lint) ignores `insights/` in v1. That's an explicit allow-list check in each, with a test per pass. An insight must never be deduped into a note, linked as Related, or pruned as a stray file.
- Lesson extraction ignores `insights/` (§1), so insights never become evidence for insights.

### 8. Review and promotion: two separate yeses

1. **Is it true?** `vir review --insights` walks `proposed` rules, newest evidence first, and shows the rule, the why, and each evidence quote with its note link. Actions:
   - **accept** → `status: accepted`; retrieval now serves it.
   - **edit** → `$EDITOR` on rule/why, then accept.
   - **reject** → `status: rejected`; the file moves to `.rejected/` like notes do, and the fingerprint is remembered.
   - **skip**.
2. **Should it go into CLAUDE.md?** `vir sync-claude` adds a `## Rules (from vir)` section to the VIR block, holding **only `accepted` + `promotion: promoted`** rules, scoped per target (global rules to `~/.claude/CLAUDE.md`, `project:<name>` rules to that project's CLAUDE.md). For each `accepted` rule with `promotion: none` that is in scope for a target:
   - it renders **as its own hunk**: the rule line as it would appear, plus its source notes (slug, project, date);
   - prompt: `add this rule to <target>? (y/n/s=skip for now)`;
   - **y** → `promotion: promoted`, so it's rendered on every future sync;
   - **n** → `promotion: declined`, remembered and never asked again (`--reconsider` resets it);
   - **s** → stays `none` and is asked next time.
3. **No path promotes a rule without an interactive yes.** Under `--force`, `--dry-run`, or a non-TTY stdin, pending rules are listed (`N rule(s) awaiting your approval: run vir sync-claude interactively`) and never added. `--force` keeps applying the existing knowledge entries as today.
4. **Demotion:** rejecting an accepted rule in `vir review --insights` sets `status: rejected` and `promotion: declined`. The next `sync-claude` shows its removal as a normal diff line.

The existing whole-block y/n still applies to the rest of the block. Per-rule answers are collected first, then the final block (with only the approved rules) goes through the usual confirm.

### 9. Command surface

```
vir connect             find recurring lessons, propose rules (paid: ≤ connectMaxCandidates LLM calls)
vir connect --dry-run   show clusters, candidates, deferred count, clustering mode and cost estimate; no LLM, no writes
vir connect --reconsider <slug>
vir review --insights   accept / edit / reject proposed rules
vir sync-claude         + per-rule promotion hunks (§8)
```

`vir connect` isn't part of `vir run` or the daemon in v1. `vir status` shows `insights: N proposed · M accepted · K awaiting CLAUDE.md approval`.

Config (all optional, defaults shown): `connectMaxCandidates: 10`. It needs a `SURVIVAL_SAMPLE` entry and re-init carry-over in `initConfig` (the schema-enumerating guard in `src/cli/initConfig.test.ts`). `connectMinSim` and `connectCoreSim` live in `thresholds.ts` per model, not in user config.

### 10. Error handling

- An LLM failure or unparseable JSON for one candidate gets logged and skipped. The candidate stays eligible next run. It's never written half-done.
- Embedding provider down mid-run → stop clustering, report it, write nothing.
- A source note that was deleted or rejected after a rule was accepted: the next `vir connect` recomputes evidence. If an accepted rule drops below §3, it's flagged `stale` in `vir review --insights` and `vir status`. `stale` is derived on each run, not a stored status. It isn't auto-demoted, and the owner decides.
- Each insight file write is atomic (temp + rename), matching the vault writer.

### 11. Testing

Unit (LLM and embeddings mocked, tmp vault fixtures):
- extraction: bold-item parsing (both `**X**` and `- **X**`, continuation lines), the summary fallback, archived-duplicate inclusion, and the exclusion of `insights/` / `.rejected/` / articles;
- clustering: threshold linking, the centroid chaining guard, the size cap, TF-IDF fallback mode;
- qualification: the 3-session / 7-day boundaries (2 sessions → no; 3 sessions over 6 days → no; 3 over 7 → yes), merge losers counted once;
- validation: ids outside the cluster dropped, a quote that isn't a substring dropped, falling below threshold after validation means no write, scope computed from projects;
- fingerprints: match at Jaccard 0.5, rejected stays skipped, accepted rule text never overwritten, `--reconsider`;
- serving gate: proposed/rejected insights absent from `loadIndex`, accepted present; each pass in §7 ignores `insights/`;
- sync-claude: a per-rule hunk renders with its sources; y/n/s persist; `--force`, `--dry-run` and non-TTY never promote; declined is never re-asked; demotion shows as removal.

Real-vault evaluation (before release, recorded in `docs/`):
- `vir connect --dry-run` on the owner's vault: count candidates and hand-label each cluster (same lesson? rule-worthy?).
- After the first real run, **≥ 70% of proposed rules accepted** in `vir review --insights` is the success bar. Below that, retune the thresholds before shipping.

## Out of scope (v1)

- Contradictions (v2, which reuses the lesson clusters and replaces `lint`'s topic-token pairing).
- Cross-project transfer (goes to retrieval: cross-project search + problem-signature tags at distill time).
- Auto topic pages (dropped).
- AGENTS.md promotion (comes with `vir update-agents-md`).
- Obsidian plugin review UI (`vir review --insights --json` contract; plugin work later).
- Running `vir connect` from the daemon.

## Open risks

- **Threshold calibration is the whole game.** Too loose and every Next.js lesson merges into one blob; too tight and nothing recurs. The plan's first task gates everything else on the labeled measurement.
- **Session-level dedupe hides evidence.** It's recovered through `## Archived Duplicates` links. A future change to the merger that drops that section would silently lower recurrence counts. A test pins the link format.
- **Rule text quality** depends on the distill model. The ≥ 70% acceptance bar is the check.

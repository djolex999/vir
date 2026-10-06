# Connect pass v1: recurring lessons → proposed rules (design)

Date: 2026-10-06
Status: **v1.1**. Design approved in brainstorming. Revised after the Fable review (`tasks/connect-pass-review.md`, 7/10, "revise"); spec pending owner review.
Repo: `vir` (CLI 0.24.3)
Related: `tasks/vir-unboxed.md` (Follow-ups → "Connect pass")

> **v1.1 changes:** accepted rules enter embedding retrieval and MCP (§7). sync-claude gets a rule entry kind, ask-before-render, and persist-after-apply (§8). Rejection memory is keyed on session ids, not content hashes (§6). An accepted rule's evidence never changes without review (§6). Exact lesson grammar + normalization (§1). Stratified calibration (§2, §11). TF-IDF fallback, moving rejected insights to `.rejected/`, per-pass code changes and per-run `stale` are cut. Added: lock, `isTTY` check, project-slug scope, scratch projects count as no project, and "never runs under `vir run` or `--force`". Review tags: **[F-1]…[F-3]** blocking, **[F]** other.

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

- **Notes are per session and hold several lessons.** In the owner's vault (206 live notes), 202 have a `## What Was Learned` section, holding **1,230 lesson items** in four shapes: bare `**X**` (554), `- **X**` (492), numbered `1. **X**` (34), and mid-line bold (12, not lessons). 247 items are bold heads whose body is sub-bullets. So recurrence must be detected per **lesson**, not per note.
- **`themes` tags don't line up across notes** (only a handful repeat), so tag counting can't find recurrence.
- **`vir dedupe`** merges near-duplicate notes. The loser goes to `archived/` and the winner gets an `## Archived Duplicates` section of `- [[slug]]` links (14 notes, all resolving to `archived/` files that keep `session_id`, `date` and `project` frontmatter).
- **`vir lint`** has an LLM contradiction check (`src/lint/linter.ts:156`) that ranks up to 20 note pairs by topic-token overlap. v2 replaces that ranking with these lesson clusters.
- **`vir sync-claude`** (`src/cli.ts:515`, `src/claude/updater.ts`) rebuilds a `VIR:START…VIR:END` block from `db.listDistilled()` on every run. `parseEntries` (`:197-220`) recognizes only `- cat/slug (conf x) — topic` lines, and `computeDiff` (`:222-248`) diffs those by slug. `buildPlan` renders the new block before any prompt. One y/n covers all files, and `--force` skips it. No `isTTY` check: `rl.question` runs on piped stdin.
- **Retrieval has two paths.** Embedding search pools DB rows only: sessions, articles, topics, PDFs (`retriever.ts:194-203`). The TF-IDF fallback `loadIndex` (`:327`) walks the output folder, skipping `summaries/.rejected/archived` (`:18`). The verified boost keys on `verified: true` frontmatter (`:62-68`). MCP `QUERY_TYPES` is `session|article|topic|pdf|all` (`server.ts:48-54`), and type inference reads `fm.type`.
- **Other passes are already isolated from new folders.** strayFiles, prune, review, the writer index and the linter scope themselves to the category dirs. audit, dedupe, embeddingSweep and summarizer are DB-driven. Only `loadIndex` and `doctor.ts:244` (a note count) walk the whole folder.
- **Similarity thresholds are per embedding model** (`src/search/thresholds.ts`). Whole-note doc-doc cosine runs p50 0.744 / p90 0.80 on nomic. Lesson-level distributions are unmeasured.

## Design

### 1. Lesson extraction

**Grammar** (inside `## What Was Learned`, ending at the next `## ` heading) [F]:
- A **lesson item** starts on a line matching `^(?:[-*]|\d+\.)?\s*\*\*` at the section's base indent (no leading whitespace beyond the list marker).
- Its **body** is every following non-blank line, including indented sub-bullets (even bold ones), up to the next item line at base indent, a blank line followed by a base-indent item, or the next heading. Nested bold sub-bullets belong to their parent and are not new lessons.
- Mid-line bold (`… **X** …` not at line start) is not an item.
- A session note without the section yields one lesson: its `## Summary` paragraph.

**Normalization** before hashing and embedding [F]: strip `**`/`__` markers and list markers, collapse whitespace, trim, and cap at the embedding provider's input limit. Trivial reformatting therefore doesn't change a lesson's hash.

**Sources:**
- every live session note in the category folders (`gotchas/`, `patterns/`, `decisions/`, `tools/`);
- every archived note linked from a live note's `## Archived Duplicates`. Its lessons count as evidence, but citations point to the **live winner**, because the archive is out of every read path.

Never extracted: articles, PDFs, topic pages, `insights/` (no feedback loop), `.rejected/`, archived notes nobody links.

Each lesson stores: note path, **session id**, note date, **project slug** (`kebab(project)`), category, item index, normalized text, a content hash, and `archived_via` (the winner's slug, or null). Re-extraction only touches notes whose content hash changed.

### 2. Clustering

`vir connect` **requires an embedding provider** and refuses without one: `clustering needs an embedding provider — run vir embed setup`. TF-IDF on 20–60-token lessons is noise. [F: cut]

1. Embed each normalized lesson with the active provider (`resolveEmbeddingProvider`). Embeddings are cached by `(content hash, model)`.
2. Link every lesson pair with cosine ≥ `connectMinSim` (new per-model field in `thresholds.ts`), and take connected components.
3. Chaining guard: centroid = mean of L2-normalized member vectors. Drop members whose cosine to the centroid is below `connectCoreSim`, recompute the centroid, and do one more drop pass. Cap at 20 members, keeping the closest to the centroid (ties → newest note date).

**Calibration** (the plan's first task, gating everything else) [F]: sample lesson pairs **stratified by cosine band** (0.55–0.65, 0.65–0.75, 0.75–0.85, > 0.85; 15 pairs each) from the owner's vault and hand-label them same-lesson / different. Pick `connectMinSim` at pair precision ≥ 0.9. Then build clusters and hand-check **purity on 20 components**, because pair precision is not cluster quality under single-link. Tune `connectCoreSim` until ≥ 18/20 components are one lesson. Record the numbers in a `thresholds.ts` comment, as the existing calibration notes do.

At ~1,200 lessons, that's ~720k pairs: an in-memory pass, no index needed.

### 3. Recurrence qualification (deterministic, before any LLM call)

A cluster becomes a **candidate** only if all of these hold:
- ≥ 3 **distinct session ids**, counting archived merge losers;
- `last_seen − first_seen ≥ 7 days`, using note dates;
- it doesn't match an existing insight (§6) that is `rejected`, or is `accepted`/`proposed` with no new sessions.

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
- Every `evidence.quote` must be a whitespace-normalized substring of its lesson's normalized text. A failed quote drops that piece of evidence. A member without valid evidence is dropped.
- After dropping, the remaining lessons must still meet §3. Otherwise the candidate is logged as `unverified` and nothing is written.
- **Scope is computed, not asked:** take the members' project slugs, ignoring "no project" ones. `codex-scratch` and empty/unknown projects count as no project. [F] One remaining slug gives `project:<slug>`; zero or several give `global`.
- The run log records `kept/total` members per candidate, which separates a loose threshold from bad rule text during evaluation. [F]

Model: `models.distill`. Cost is logged under stage `connect`, so `vir cost` reports it. On `provider: "claude-cli"` it consumes quota.

### 5. Output: insight notes

Path: `<outputDir>/insights/rules/<slug>.md`, where the slug is a kebab of the rule plus the first 8 chars of the insight id.

```markdown
---
type: insight
insight_type: recurring-rule
status: proposed            # proposed | accepted | rejected
promotion: none             # none | promoted | declined
verified: false             # true once accepted, which gives the existing retrieval boost
scope: global               # or project:<kebab-slug>
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

`type: insight` (not `kind`) is what MCP type inference reads. [F-1] The DB is the source of truth for `status`, `promotion` and `verified`. Frontmatter mirrors it and is rewritten (temp + rename) on every state change.

### 6. State, identity and rejection memory

New tables, using `db.ts`'s existing `CREATE TABLE IF NOT EXISTS` pattern:

- `lessons(id, note_path, session_id, note_date, project, item_index, text, content_hash, archived_via)` and `lesson_embeddings(content_hash, model, vector)`.
- `insights(id, slug, insight_type, status, promotion, scope, rule, why, member_session_ids JSON, member_hashes JSON, sessions, projects JSON, first_seen, last_seen, embedding, embedding_model, evidence_changed, created_at, updated_at)`.

**Identity is the member session-id set** [F-3]. Session ids are stable across note rewrites (reconcile, `run --full`, dedupe winner rewrites, review edits); content hashes are not. A new candidate **matches** an existing insight when its verified member session-id set has Jaccard ≥ 0.5 with that insight's. Ties go to the higher content-hash overlap. As a second gate, a candidate whose rule embedding has cosine ≥ `connectCoreSim` to a **rejected** rule also counts as matching it.

On a match:
- `rejected`: skip silently. This is how rejected rules stay rejected.
- `proposed`: replace evidence and members with the new validated set, and keep `rule`/`why` (the owner may be mid-edit).
- `accepted`: **never change it silently** [F]. Its members, evidence and text stay as accepted. If the new validated set adds sessions, set `evidence_changed`, store the pending additions, and show them in `vir review --insights` as "N new sessions support this rule: accept additions?". Retrieval and CLAUDE.md keep serving the accepted version until then.
- `promotion: declined` stays declined (§8).

`vir connect --reconsider <slug>` resets a rejected or declined insight to `proposed` / `none`. It's the only way back.

### 7. Serving gate and isolation

- **Embedding retrieval** [F-1]: on accept, embed `rule + why` and store it on the `insights` row, re-embedding on edit. `db.getInsightEmbeddings(root)` mirrors `getTopicEmbeddings` and returns **only `status = accepted`** rows. `retriever.ts` adds it to the pool. Accepted rules carry `verified: true`, so they get the existing boost.
- **TF-IDF fallback** (`loadIndex`, no DB handle): skip any file under `insights/` whose frontmatter `status` isn't `accepted`. That's a per-file check in the walk, since the frontmatter mirror is kept in sync by §5.
- **MCP**: add `"insight"` to `QUERY_TYPES`. `type: insight` filters to accepted rules. `vir_recent_notes`, compose and summarize are `listDistilled`-driven and never see insights.
- **Every other pass** is already category-scoped or DB-driven (see Background), so **no code changes, only tests**: one per pass (strayFiles, prune, review, writer index, linter, dedupe, audit) asserting that a file in `insights/rules/` is ignored. `doctor`'s note count will include insights; that's cosmetic and accepted.
- Lesson extraction ignores `insights/` (§1).

### 8. Review and promotion: two separate yeses

**1. Is it true?** `vir review --insights` walks `proposed` rules first, then accepted rules with `evidence_changed`. It shows the rule, the why, and each evidence quote with its note link. Actions:
- **accept** → `status: accepted`, `verified: true`, embed (§7).
- **edit** → `$EDITOR` opens the note. Only the `**Rule:**` and `**Why:**` lines are editable; they're re-parsed into the DB (the source of truth). Then accept and re-embed. Any other change to the file gets overwritten on the next state write, and the editor header says so. [F]
- **reject** → `status: rejected`, `verified: false`. The file **stays in place** [F: cut the move]. Retrieval gates on status, and the session-id identity remembers the rejection.
- **accept additions** / **keep as is** for `evidence_changed` rules.
- **skip**.
- **Stale display** (review only, not a stored status, not computed per run) [F]: if an accepted rule's current members no longer meet §3 (source notes rejected or deleted), it's marked `stale`. The owner decides.

**2. Should it go into CLAUDE.md?** [F-2] `sync-claude` gets a second entry kind:
- `Entry` becomes a discriminated union. `{ kind: "note", … }` is today's shape. `{ kind: "rule", id, rule, scope, sources }` renders as `- rule: <rule> <!-- vir-rule:<id> -->` under a `## Rules (from vir)` heading inside the VIR block. `parseEntries` learns that line shape, and `computeDiff` keys by `kind:id/slug`, so rule additions and removals diff like notes.
- Flow per run:
  1. `planRules(target)` lists `accepted` rules in scope for each target: global rules for `~/.claude/CLAUDE.md`, and `project:<slug>` rules for `projectClaudePath(<slug>)` (the kebab slug, matching `updater.ts:62,74,377`).
  2. For each rule with `promotion: none`, render **its own hunk** (the line as it would appear, plus its source notes with slug, project and date) and prompt `add this rule to <target>? (y / n / s=skip for now)`. Answers are held in memory.
  3. Render the block from note entries plus `promoted` rules plus this run's `y` answers.
  4. The existing whole-block confirm applies.
  5. **Only after `applyPlan` succeeds for that target** persist `promotion: promoted` for its `y` answers. Persist `declined` for `n` answers immediately; they don't depend on the write. A `y` followed by aborting the block leaves the rule `none`, to be asked next time. DB and file never disagree.
- **No path promotes without an interactive yes:** under `--force`, `--dry-run`, or when `process.stdin.isTTY` is false (a new check in sync-claude), rule prompts are skipped and a line reports `N rule(s) awaiting your approval: run vir sync-claude in a terminal`. `--force` keeps applying note entries and already-promoted rules as today.
- **Demotion:** rejecting an accepted rule sets `status: rejected` and `promotion: declined`. The next sync renders without it, and the diff shows it as a removed `rule:` line.

### 9. Command surface

```
vir connect             find recurring lessons, propose rules (paid: ≤ connectMaxCandidates LLM calls)
vir connect --dry-run   clusters, candidates, deferred count, kept/total preview and cost estimate; no LLM, no writes
vir connect --reconsider <slug>
vir review --insights   accept / edit / reject proposed rules; accept additions on changed evidence
vir sync-claude         + per-rule promotion hunks (§8)
```

- `vir connect` **never runs inside `vir run`, the daemon, or any command's `--force`**. It's only ever invoked by name. [F]
- It takes the vault lock (`acquireLock`, `src/pipeline/lock.ts`) for the whole run, like the writers do, so a daemon `vir run` can't race it. [F]
- `vir status` shows `insights: N proposed · M accepted · K awaiting CLAUDE.md approval`.
- Config (optional, default shown): `connectMaxCandidates: 10`. It needs a `SURVIVAL_SAMPLE` entry and re-init carry-over in `initConfig` (the schema-enumerating guard in `src/cli/initConfig.test.ts`). `connectMinSim` and `connectCoreSim` live in `thresholds.ts` per model.
- A later `vir review --insights --json` contract (for the Obsidian plugin) is keyed by **insight slug**, not session id; `reviewJson.ts` targets are session-keyed today. [F] Out of scope for v1, but noted so the contract doesn't assume session ids.

### 10. Error handling

- An LLM failure or unparseable JSON for one candidate gets logged and skipped. The candidate stays eligible next run. It's never written half-done.
- No embedding provider: refuse up front (§2). Provider down mid-run: stop, report, write nothing from this run.
- Each insight file write is atomic (temp + rename), matching the vault writer.
- The lock is held for the run; a held lock gives the standard "another vir process is running" message.

### 11. Testing

Unit (LLM and embeddings mocked, tmp vault fixtures):
- extraction: all four real shapes (bare bold, `- **`, `1. **`, mid-line bold ignored), sub-bullet bodies including nested bold, the end-of-section boundary, the summary fallback, archived-duplicate inclusion via `## Archived Duplicates` links (format pinned), exclusion of `insights/` / `.rejected/` / articles; normalization making `**X**` and `- **X**` hash equal;
- clustering: threshold linking, the centroid chaining guard with recompute, the 20-cap tie-break, refusal without a provider;
- qualification: the 3-session / 7-day boundaries (2 sessions → no; 3 sessions over 6 days → no; 3 over 7 → yes), merge losers counted once;
- validation: ids outside the cluster dropped, a quote that isn't a substring dropped, falling below threshold after validation means no write, scope from slugs with `codex-scratch` ignored;
- identity: a rejected rule stays rejected after **every member note is rewritten** (new content hashes, same session ids); Jaccard 0.5 boundary; the rejected-embedding gate; an accepted rule's text and members unchanged by a new run, with `evidence_changed` set; `--reconsider`;
- serving: `getInsightEmbeddings` returns accepted only; `loadIndex` skips non-accepted insight files; MCP `type: insight` works; one isolation test per pass in §7;
- sync-claude: `parseEntries`/`computeDiff` round-trip rule lines; a per-rule hunk renders with its sources; y/n/s; `promoted` persisted only after a successful `applyPlan` (y then abort → still `none`); `--force`, `--dry-run` and non-TTY never prompt or promote; declined never re-asked; demotion shows as a removed `rule:` line;
- lock contention.

Real-vault evaluation (before release, recorded in `docs/`):
- Calibration per §2 (stratified pairs, then component purity).
- `vir connect --dry-run` on the owner's vault: hand-label each candidate cluster.
- Success bar: **≥ 70% of the first 20 proposed rules accepted** (over about two runs), with the `kept/total` ratios recorded. Below the bar, use the ratios to decide between retuning thresholds and fixing the prompt.

## Out of scope (v1)

- Contradictions (v2, which reuses the lesson clusters and replaces `lint`'s topic-token pairing).
- Cross-project transfer (goes to retrieval).
- Auto topic pages (dropped).
- AGENTS.md promotion (comes with `vir update-agents-md`).
- Obsidian plugin review UI (the `--json` contract is noted in §9).
- Running `vir connect` from the daemon.
- TF-IDF clustering fallback (cut in v1.1).

## Open risks

- **Threshold calibration is the whole game.** It's gated by the stratified labeling in §2.
- **Archived-duplicate links are the only trace of merged evidence.** A merger change that drops the `## Archived Duplicates` section would silently lower recurrence counts. A test pins the format.
- **Rule text quality** depends on the distill model. The 70% bar plus the `kept/total` ratios are the check.

# vir — Architecture
*Generated: 2026-06-12*

## 1. Project Overview

vir is a local macOS daemon + CLI that distills Claude Code session transcripts
(and clipped web articles) into a typed Obsidian knowledge vault, then feeds that
knowledge back into Claude Code via CLAUDE.md sync and a read-only MCP server.
Single-maintainer product, published to npm as `@djolex999/vir-cli` (0.8.3, MIT),
with a companion Obsidian plugin (`vir-obsidian`, marketplace 0.1.2). It is in
active development with a stable release cadence — 184 passing tests, additive
SQLite migrations, idempotent reruns. Tech identity: Node ≥20 + strict TypeScript
CLI, better-sqlite3 state, Anthropic/Kie LLM backends, Ollama embeddings.

## 2. Technology Stack

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Language | TypeScript (NodeNext, strict) | Node ≥20 | `noUncheckedIndexedAccess` on |
| CLI | commander + @inquirer/* + chalk + ora | 12.x | every action wrapped in `runAction` |
| State | better-sqlite3 (WAL) | 11.x | synchronous by design; additive migrations only |
| Validation | zod | 3.x | config schema |
| LLM | @anthropic-ai/sdk; native fetch for Kie.ai | 0.32 | Kie path never instantiates the SDK (header conflict) |
| Embeddings | Ollama `nomic-embed-text` (localhost:11434) | — | best-effort; TF-IDF fallback |
| MCP | @modelcontextprotocol/sdk (stdio) | 1.29 | read-only facade |
| Scheduling | launchd (macOS), systemd user timer / cron (Linux) | — | Linux experimental/untested |
| Testing | vitest, colocated `*.test.ts` | — | 184 tests / 18 files; pure functions only |
| CI/CD | none (manual release checklist) | — | `prepublishOnly: build && test` is the gate |
| Distribution | npm (`files` allowlist: dist + logo) | — | src/ never ships |

## 3. Directory Structure

```
src/
  cli.ts                # commander entry — 23 subcommands, runAction-wrapped
  config.ts             # ~/.vir/config.json (zod, 0600 perms + silent heal)
  cli/                  # runAction chokepoint, reconcile, review
  pipeline/             # the core: run.ts orchestrator + scan/parse/filter/
                        # scrub/distill/write + articles, composer, embeddingSweep
  search/               # retriever (embeddings→TF-IDF), embedder, synthesizer
  state/db.ts           # SQLite: sessions / articles / topics — isolated tables
  cost/                 # provider-aware pricing, JSONL cost.log, report
  output/json.ts        # --json wire contract (CLI ↔ Obsidian plugin)
  mcp/                  # stdio server + claude-CLI registration
  daemon/               # launchd / systemd / cron platform router
  claude/updater.ts     # VIR:START/END CLAUDE.md block sync
  lint/ dedupe/ diagnostics/  # vault hygiene + vir doctor
  ui/display.ts         # the single console.log owner (convention)
```

## 4. Route Map

No HTTP routes — the surfaces are CLI commands and MCP tools.

**CLI (all via `runAction`, exit-code safe):** `init`, `run` (--full/--dry-run/
--articles-only/--rewrite-only/--force-model), `query` (--json), `compose`,
`cost`, `calibrate`, `schedule install|uninstall`, `sync-claude`, `dedupe`,
`lint`, `summarize`, `embed`, `status`, `reconcile`, `review`, `doctor`,
`mcp run|install|uninstall|status`.

**MCP tools (read-only, stdio):** `vir_query`, `vir_status`, `vir_recent_notes`,
`vir_recent_articles`, `vir_project_summary`. None spend tokens or write files.

Auth is not applicable (local-only tool); the trust boundary is the filesystem
(config 0600, scrubbing before persistence).

## 5. Module Architecture

Business logic lives in `pipeline/` with `run.ts` as the orchestrator; commands
in `cli.ts` are thin wrappers that gather config/db and call into modules.
Two deliberate chokepoints carry the invariants:

```
[cli.ts action] → runAction → [pipeline/run.ts]
  scan → parse → filter(toolCallFilter) → scrub → distill(callLLM) → write → db
```

- `callLLM` (distiller.ts) — the ONLY place LLM calls are made and costs recorded.
- `toolCallFilter.ts` — the ONLY owner of the `[tool_use]/[tool_result]` grammar.
- `ui/display.ts` — the intended only console.log site (violated ~30× in cli.ts).
- Pure builders are split from side-effectful orchestrators (composer, output/json,
  embeddingSweep) — this is what makes the test suite possible without spawning CLIs.

## 6. Data Model

SQLite at `~/.vir/vir.db`, three deliberately isolated tables:

| Table | PK / identity | Purpose |
|---|---|---|
| `sessions` | path + SHA-256 hash | processed transcripts, distilled content, embedding, error state |
| `articles` | slug from source URL | web-article notes (own taxonomy: concept/technique/reference/opinion) |
| `topics` | slug from topic text | composed topic pages; upsert preserves created_at |

Isolation is a hard convention: article/topic taxonomies must never pollute
session readers (`listDistilled`, `getStats`, rewrite). Read-only consumers (MCP)
guard every articles/topics read with a `sqlite_master` existence check because
they skip migrations. Migrations are additive-only (`PRAGMA table_info` + ADD
COLUMN). Review verdicts intentionally live in note frontmatter, not the DB.

## 7. Data Flow

**Flow: session → note (the daemon pass)**
```
~/.claude/projects/**/*.jsonl
  → scan + SHA-256 (skip if processed)
  → parse (prose/transcript split) → heuristic filter (~50% dropped free)
  → toolCallFilter (217k→95k tokens) → scrub (keys/paths/emails)
  → Haiku classify → hybrid route → Sonnet/Haiku distill   [cost recorded once]
  → vault write (frontmatter, wikilinks, verdict preservation, best-effort embed)
  → SQLite record → embedding sweep self-heals NULLs next run
```
Per-session try/catch: one bad transcript never kills the daemon; errors land in
the DB and surface via `vir run` exit code + `vir reconcile`.

**Flow: query**
```
question (CLI / --json / MCP)
  → retriever: Ollama embeddings over sessions+articles+topics pool
    (TF-IDF full-vault fallback; +0.2 verified boost; MMR diversity)
  → Claude synthesis (skipped in --json) → terminal / plugin / MCP result
```

**Flow: knowledge return**
```
vault notes → sync-claude → bytes between VIR:START/VIR:END in CLAUDE.md files
```
Flag: the updater that performs this mutation is untested (see §12).

## 8. External Services

| Service | Purpose | SDK | Credentials | Risk |
|---|---|---|---|---|
| Anthropic API | classify + distill + synthesis | @anthropic-ai/sdk | ~/.vir/config.json (0600) | Critical (one of the two providers required) |
| Kie.ai | cheaper alternate provider | native fetch, Bearer | same | High — errors tunnel via HTTP-200 bodies; guarded by `kieResponseError` + 120s timeout |
| Ollama | local embeddings | native fetch | none (localhost) | Low — best-effort by design |
| SQLite | state / idempotency | better-sqlite3 | local file | High — source of truth |
| Obsidian vault | the product output | fs | local | Medium — plain markdown, recoverable |
| launchd/systemd/cron | 4h cadence | spawnSync arg-arrays | — | Low |
| Claude Code | MCP host + plugin consumer | claude CLI | — | Low |

## 9. Authentication & Authorization

Local single-user tool: no accounts, no sessions. The security model is
(a) secrets-at-rest — config dir 0700 / file 0600 with silent permission healing
on load; (b) scrub-before-persist — API keys, bearer tokens, absolute paths, and
emails are stripped before anything reaches the vault, the DB content column, or
logs; (c) read-only MCP — zero side effects, stderr-only logging. The 2026-06-12
audit verified no key reaches console, daemon.log, or cost.log, all spawns are
arg-arrays, and all SQL is prepared statements.

## 10. Deployment

Everything runs on the user's machine. `npm install -g @djolex999/vir-cli` →
`vir init` → `vir schedule install` writes a launchd plist
(`~/Library/LaunchAgents/lab.growthq.vir.plist`) that runs `vir run` every 4h.
Build is plain `tsc` to `dist/`; `dist/` is gitignored but shipped via the npm
`files` allowlist, so a fresh build before publish is mandatory (enforced by
`prepublishOnly`). Release checklist lives in CLAUDE.md (annotated tags,
`--follow-tags`, `--access=public`). No server, no CI.

## 11. Patterns & Conventions

Specific and mostly well-held: pure-builder/orchestrator split everywhere
testability matters; single-chokepoint invariants (callLLM, toolCallFilter,
runAction); `process.exitCode` never `process.exit` (verified zero violations);
best-effort steps must record their skip (lesson learned three times — Kie-200,
null content, NULL embeddings); backward compat via opt-in fields
(`distillFast`); additive migrations; stable-identity slugs (never content
hashes). **Inconsistencies:** ~30 `console.log` sites in cli.ts (calibrate,
dedupe, lint, summarize, query/compose) violate the display.ts monopoly; the
plugin hand-mirrors the wire types and has already drifted on two fields.

## 12. Risks & Recommendations

### [DO NOW] Close the articles NULL-embedding blind spot
**Observation**: `sweepEmbeddings` + `vir embed` back-fill sessions and topics but not articles (`embeddingSweep.ts:70`); `maybeEmbedArticle` is write-time only.
**Risk**: an article clipped while Ollama is down is permanently invisible to embedding retrieval — the exact failure class that hid vir's own most-cited lesson in 0.8.2.
**Action**: mirror the 0.8.3 topic fix (`selectArticleEmbeddingTargets` + `listArticleEmbeddingTargets`, back-fill in sweep + `vir embed`), and add the skip marker per the best-effort rule. Already #1 on the roadmap — ship it next. (M)

### [DO NOW] Test `claude/updater.ts`
**Observation**: the VIR:START/END mutation path — the only code that rewrites *user-owned* CLAUDE.md files — has zero tests (190 lines).
**Risk**: a marker-parsing regression silently corrupts files outside vir's own state; unrecoverable except via git.
**Action**: unit-test the slice-replacement logic with fixture files (no block / block / malformed block / content outside markers). Pure-function extraction makes this an afternoon. (S–M)

### [DO LATER] Harden the plugin wire boundary
**Observation**: plugin `parse<T>` is `JSON.parse(...) as T` with no validation (`vir-client.ts:127`); types already drifted from the CLI contract (`project` nullability, `date` optionality).
**Risk**: the next contract change fails at render time instead of the boundary, with no error message pointing at the cause.
**Action**: align plugin types to the CLI contract and add a minimal shape check; decide later whether a shared types package is worth the publishing overhead. (S)

### [DO LATER] Sweep `console.log` out of cli.ts
**Observation**: ~30 call sites across calibrate/dedupe/lint/summarize/query/compose plus `writer.ts:362` bypass `ui/display.ts`.
**Risk**: quiet/daemon mode can't suppress them; styling drifts; the convention erodes by example.
**Action**: route through display primitives command by command — dedupe and lint first (most sites). (M)

### [DO LATER] Multi-theme note dilution
**Observation**: dense sessions distill to one grab-bag note (7–8 themes); the Kie-200 lesson ranks ~35th for a pointed Kie query.
**Risk**: retrieval quality degrades exactly where the knowledge base is richest; weakens the "one query → one named lesson" product demo.
**Action**: split dense sessions into multiple notes at distill time, or add theme-count metadata + better labels. (M–L)

### [DO IF IT BREAKS] Daemon/dedupe/lint/doctor test coverage
**Observation**: ~2,000 lines of side-effectful code (daemon lifecycle, merger, doctor, MCP server) untested.
**Risk**: regressions surface only on real machines; Linux path is explicitly experimental.
**Action**: integration harness when one of these actually bites; not before. (L)

### [DO IF IT BREAKS] TF-IDF verified-boost scale mismatch
**Observation**: the flat +0.2 boost nudges cosine but dominates TF-IDF (~0.05 scores).
**Risk**: verified-first ordering on the fallback path may be too aggressive.
**Action**: switch to proportional (`score * k`) if fallback results look skewed. (S)

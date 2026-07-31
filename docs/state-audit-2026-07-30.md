# State audit — 2026-07-30

Read-only cross-repo audit of `vir` (CLI) and `vir-obsidian` (plugin). Every
claim below is backed by a command's actual output or a file:line citation;
anything not directly verified is marked UNVERIFIED. No fixes were applied
during this audit.

## CLI — vir

**Location note:** audited `/Users/djmarkovic999/projects/vir` — `~/code/vir`
does not exist on this machine.

**Version:** local `0.12.0` (`package.json:2`) / published `0.11.2`
(`npm view @djolex999/vir-cli version`, last publish `2026-07-12T09:06:53Z`) /
**delta: local ahead, unpublished**
**Git:** branch `main`, clean (`git status --porcelain` empty), 0 ahead/0
behind origin, `v0.12.0` tag confirmed on remote and annotated
(`git cat-file -t v0.12.0` → `tag`). No unpushed tags. Old lightweight tags
(`v0.3.0`–`v0.6.1`) are historical/harmless per existing CLAUDE.md guidance.
**Build:** pass (`tsc`, no output) | **Tests:** 289 passed, 31 files passed,
0 failed, 0 skipped
**Open items:** 34 unchecked boxes in `tasks/todo.md` (thesis chapters
`todo.md:13-23`; `npm publish` for 0.12.0 `todo.md:27`; medium/low bug-hunt
backlog `todo.md:30-554`) + 19 numbered findings in
`docs/bug-hunt-2026-07.md` (9 high/10 medium/11 low, all "report only,
nothing fixed" per the doc itself).

### Bug-hunt re-verification (2026-07-30 pass)

- **#1 slug-reconstruction drift — CONFIRMED FIXED.** `db.ts:6`,
  `merger.ts:18`, `linter.ts:11`, `writer.ts:39` all import `makeSlug`/`kebab`
  from the single `pipeline/slug.ts` source. `db.ts:1204` comment notes the
  old local `kebabLite` copy was the drift source. No reimplementations
  remain.
- **#2 TF-IDF fallback surfaces `.rejected/`/`archived/` notes — CONFIRMED
  STILL LIVE.** `retriever.ts:15` `SKIP_DIRS = new Set(["summaries"])` only;
  the walk still indexes reject/archive dirs.
- **#4 `--rewrite-only --dry-run` mutates the vault — CONFIRMED STILL LIVE.**
  `src/pipeline/run.ts:157` — `if (opts.rewriteOnly)` runs unconditionally:
  calls `rewriteOne()` for every DB row (writes note files) and
  `writer.regenerateIndex()` (rewrites `index.md`), with zero check of
  `opts.dryRun` anywhere in that block (lines 157–207). The dry-run banner
  prints (`:139`) but nothing downstream honors it. **Highest-priority
  unresolved item in this audit** — a flag whose entire contract is "make no
  writes" currently rewrites the whole vault.
- **#5 re-running `vir init` destroys config — CONFIRMED FIXED.**
  `cli/initConfig.ts:36-38` — `buildInitConfig` carries over
  `kieTopUpTier`, `topicsDir`, `pricing` from `existing` config.
- **#6 scrubber false positives — CONFIRMED FIXED.** `scrubber.ts:11,17` —
  both `sk-ant-` and `sk-` patterns now have a negative lookbehind
  `(?<![A-Za-z0-9-])` anchor, so `risk-management-strategy-2026-plan` no
  longer matches. (The `Bearer` regex at `:24` is unanchored on the right
  side — out of scope for the original finding, not re-flagged.)
- **#9 orphan wikilinks — CONFIRMED FIXED.** `writer.ts:509` emits
  `-<8hex>`-suffixed, `existsSync`-guarded related links; `linter.ts:53`
  has a dedicated `topicAlias()` resolver so bare-slug references still
  resolve.

Net: 4 of the 9 "high severity" bug-hunt items are stale/resolved — the doc
itself needs an update pass. #2 and #4 are real and outstanding; #3 (`--full`
silently ignored by article/PDF phases), #5-restated (n/a, fixed), #7
(callKie timeout), #8 (`vir query --limit` ignored on human path) were not
re-verified this pass.

## Plugin — vir-obsidian

**Location note:** audited `/Users/djmarkovic999/projects/vir-obsidian` —
`~/code/vir-obsidian` does not exist.

**Version:** local `0.2.0` (package.json/manifest.json/versions.json all
agree) / not on npm (expected — Obsidian plugins ship via GitHub releases;
`E404` confirmed) / published GitHub release `0.2.0` @ 2026-06-26, matches
local — **in sync**
**Git:** branch `main`, **3 uncommitted files**: `CLAUDE.md`, `handoff.md`,
`tasks/todo.md` (doc-only edits, diffs show real substantive content already
reflecting 0.2.0/pdf work — not just whitespace). 0 ahead/0 behind
origin/main otherwise. All 6 tags on remote; `0.1.2` and `v0.1.0-rc.1` are
lightweight (should be annotated per convention, but harmless/already-remote).
**Build:** pass (`tsc` + esbuild) | **Tests:** 41 passed, 5 files passed,
0 failed, 0 skipped
**Open items:** 9 unchecked boxes in `tasks/todo.md` — marketplace listing
confirm (`:42`), stale CI run cleanup (`:43`, confirmed still failing, run
`27017762251`), **overdue GH Actions v4→v5 bump** (`:46`, confirmed still on
v4 in `release.yml:18,20`, due 2026-06-02, ~8 weeks overdue as of 2026-07-30),
attestation add (`:47`), placeholder link swap (`:49`), stale-release cleanup
(`:50`, confirmed `0.1.0`/`v0.1.0-rc.1` still live), Topics tab (`:53`),
shared wire-types (`:54`), Phase 2 roadmap (`:55`). No `docs/bug-hunt-*.md`
in this repo. No falsely-open items found.

## Drift

| Field | CLI (`src/output/json.ts`) | Plugin (`src/types.ts`) | Risk |
|---|---|---|---|
| `project` | `string \| null` (required, nullable) `:25` | `project?: string` (optional, non-null) `:18` | Low — runtime-safe either direction, but the plugin never expects an explicit `null` |
| `date` | `string` (required, non-optional) `:26` | `date?: string` (optional) `:19` | Low — plugin is more defensive than needed |
| `category` union | 7 members incl. `pdf`, `topic` `:10-17` | 7 members, `pdf` added in 0.2.0 `types.ts:1-8` | **Resolved** — category sets now match |
| `VirDoctorResult.ollama.model` | `string \| null` `:47` | `VirOllamaStatus.model: string` (non-nullable) `types.ts:24` | Medium — CLI can emit `null` (Ollama unreachable) but the plugin's type contract disallows it |
| `VirErrorPayload.kind` | `VirErrorKind` required union, 4 members `:37` | `kind?: string` optional, untyped string `types.ts:41` | Low-Medium — plugin loosened this; won't crash but loses exhaustiveness |

`project` is still divergent (nullability only — category-set drift is
fixed). Confirmed the plugin does **not** parse a `## Related` markdown
section anywhere (`grep -rn "Related" src/` — all 10 hits are the unrelated
"Related tab" UI feature), so the CLI's 0.12.0 removal of LLM-authored
`## Related` sections created no dangling consumer in the plugin.

## Deltas since handoff.md

- CLI `handoff.md` (2026-07-12) claims 0.12.0 is "staged, one `npm publish`
  away" and "289 tests" — both **confirmed true**, exact match.
- Plugin `handoff.md` (2026-06-26) claims "working tree clean; tag + release
  on remote" — **now FALSE**: 3 uncommitted doc files present (see Git line
  above). Not asserted as a bug, just a state mismatch worth naming.
- Plugin `handoff.md`'s "overdue since 2026-06-02" GH Actions bump —
  confirmed still not done, now ~8 weeks overdue rather than a few days.

## Top 3 by blast radius

1. **CLI bug-hunt #4** (`--rewrite-only --dry-run` mutates the vault,
   `run.ts:157`) — corrupts the live vault under a flag whose entire
   contract is "make no writes." Highest blast radius: direct data-integrity
   violation on the asset vir's whole pitch depends on. **Confirmed live.**
2. **CLI bug-hunt #2** (TF-IDF fallback surfaces `.rejected/`/`archived/`
   notes, `retriever.ts:15`) — **confirmed still current.** Surfaces
   explicitly-rejected/archived content back into `vir query`, undermining
   the review workflow's guarantee. User-visible, silent, no error surfaced.
3. **Plugin: overdue GH Actions `checkout@v4`/`setup-node@v4`**
   (`release.yml:18,20`, confirmed unbumped, ~8 weeks past due) — not
   corrupting anything yet, but a release-pipeline time bomb: GitHub's
   Node 20 deprecation could break the next tag-push release with no
   warning, right when a release is needed.

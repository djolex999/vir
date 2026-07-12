# Bug hunt — 2026-07-08

Whole-codebase hunt at v0.11.1 (4 parallel finders over pipeline / state+search /
CLI+config+cost / MCP+daemon+lint+dedupe), followed by an independent
verification pass on every high-severity finding. Report only — nothing fixed.
Confidence notes: **[V]** = re-verified against source (or behaviorally) by the
coordinator; **[2×]** = found independently by two finders; **[E]** =
empirically confirmed against the live vault (363 notes).

## High severity

1. **Slug-reconstruction drift — one bug, three sites, real data affected.**
   [2×][E] `writer.ts:547–551` builds filenames as `kebab(topic).slice(0, 50)`
   with a `note-<suffix>` fallback; three other modules rebuild the path with
   untruncated `kebab(topic)` and no fallback:
   - `state/db.ts:605–608` (`getEmbeddings`) — notes whose topic kebab-cases
     >50 chars get a nonexistent path → `existsSync` fails in
     `retriever.ts:119–123` → **permanently invisible to embedding search**
     despite having an embedding. **12 of 363 live vault notes affected.**
   - `dedupe/merger.ts:117–122` (`resolveNotePath`) — merge on an affected
     pair: `archiveFile` returns a fictional path without moving anything;
     `rewriteWinnerBody` **creates a frontmatter-less ghost note** at the wrong
     path; DB still records merged/archived.
   - `lint/linter.ts:286–291` + cli `noteRefOf` — lint output prints paths
     that don't exist (display-only).
   Fix direction: export writer's `makeSlug` as the single source of truth.

2. **TF-IDF fallback surfaces `.rejected/` and `archived/` notes.** [2×]
   `retriever.ts:15` `SKIP_DIRS = new Set(["summaries"])`; the walk
   (`:291–310`) indexes everything else, including the reject destination
   (`cli/review.ts:116–118`) and the dedupe archive dir. With Ollama down,
   `vir query` / MCP `vir_query` can return a note the user explicitly
   rejected as wrong. Violates CLAUDE.md's "never re-surfaced" claim (true
   only for `collectNotes`). Latent today (vault has no such dirs yet).

3. **`--full` is silently ignored by the article and PDF distill phases.** [V]
   `run.ts:787` / `run.ts:885` check `isArticleProcessed`/`isPdfProcessed`
   with no `opts.full ||` guard — unlike the session loop (`run.ts:486`) and
   unlike the dry-run counters (`run.ts:452,718,722`), which DO honor full.
   So `--full --dry-run` prices N docs; the real `--full` run re-processes 0.
   The documented "re-process everything" contract is unmet for 2 of 3 sources.

4. **`vir run --rewrite-only --dry-run` mutates the vault under a dry-run
   banner.** [V] `run.ts:139` prints the `--dry-run` header, but the
   `rewriteOnly` branch (`:157`) never checks `opts.dryRun`. No LLM cost, but
   every note file + index.md is rewritten. Same precedence chain silently
   resolves conflicting mode flags (`--rewrite-only --articles-only`, etc.)
   instead of rejecting them.

5. **Re-running `vir init` silently destroys config.** [V] The
   `ConfigSchema.safeParse` object (`cli.ts:1718–1747`) omits `kieTopUpTier`,
   `topicsDir`, and `pricing` from `existing` → zod re-defaults them and
   `saveConfig` persists the loss (high-tier Kie user's costs inflate 11%;
   renamed topicsDir orphans old topic pages; pricing overrides vanish).
   Also `cli.ts:1640–1654`: choosing a provider sets the other provider's
   API key to `undefined`, discarding it.

6. **Scrubber false positives mangle distill input.** [V — behaviorally
   confirmed] `scrubber.ts:10` `/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g` has no
   left anchor: `risk-management-strategy-2026-plan` →
   `ri[REDACTED_OPENAI_KEY]`. `scrubber.ts:13` `/\bBearer\s+…/gi`: "the
   bearer of bad news" → "the Bearer [REDACTED_TOKEN] bad news" (and `\s+`
   crosses newlines). Kebab identifiers are ubiquitous in transcripts; this
   can destroy the exact branch/file names a note is about.

7. **`callKie`'s timeout covers time-to-headers only.** [V]
   `distiller.ts:~195` clears the abort timer in `finally` as soon as `fetch`
   resolves; `response.json()`/`response.text()` stream the body afterwards
   with no timeout. A mid-body stall still hangs the daemon forever — the
   exact failure mode the 0.8.1 `KIE_TIMEOUT_MS` fix claims to have closed.

8. **`vir query --limit` ignored on the human path.** [V] `cli.ts:1049`
   hardcodes `search(cfg, db, question, 8)`; only `--json` honors the parsed
   limit.

9. **`vir lint --orphans` is 100% noise.** [E] Related-section wikilinks are
   written as `[[kebab(text)]]` (writer.ts:601–602) — never carrying the
   `-<8-hex>` suffix that note ids have — so the linter's resolution
   (`linter.ts:59–83`) matched **0 of 2,261 wikilinks** in the live vault:
   all 363 notes report as orphans; a true orphan is indistinguishable. Root
   cause is arguably the writer emitting dangling links (they also don't
   resolve in Obsidian's graph). Fixing link generation revives both the
   graph story and the linter.

## Medium severity

10. **`vir status` pending-embedding count omits PDFs.** [2×]
    `cli.ts:1229–1232` sums sessions+topics+articles only; the run preflight
    (`run.ts:338–342`) sums all four. PDFs distilled while Ollama was down
    show "0 pending" in status.
11. **`vir run --dry-run` omits the article cost estimate.** `run.ts:449–467`
    adds a supplemental estimate for PDFs but not articles, though the real
    run distills them — the 0.11.1 "money footgun" class, one site left.
12. **Review verdicts/themes preserved by NEW path.** `writer.ts:79–104` —
    a `--full` re-distill that retitles (0.9.1 deliberately retitles) or
    recategorizes computes a different `fullPath`; `preservedReviewFields`
    reads the nonexistent new path → `verified`/`reviewed_at` (and the +0.2
    boost) silently lost, old verified note left behind as a duplicate.
13. **`claude/updater.ts` marker edge cases can delete user content.**
    START-without-END: first sync appends a second block; second sync
    replaces from the orphan START to the new block's END — deleting
    everything between. Also: duplicate blocks (first replaced, second
    persists), END-before-START (region duplication), markers inside code
    fences treated as real. (`updater.ts:250–257`, first-`indexOf` matching.)
14. **`config.pricing` override for a model absent from `DEFAULT_PRICING` is
    ignored.** [V] `pricing.ts:59–61` returns `null` from the default table
    before consulting overrides → cost logs $0 for any future/unknown model
    id, silently.
15. **PDF distill prompt leaks the absolute local path.**
    `pdfDistiller.ts:115` embeds `Source: /Users/<name>/…` verbatim in the
    provider prompt while the body is scrubbed for exactly that class of data.
16. **Dedupe merge is not failure-ordered and chains stale snapshots.**
    `merger.ts:106–111` (winner rewritten + DB updated before loser archive;
    a throw leaves half-merged state that re-merges compoundingly next run);
    detector pairs from one snapshot, so overlapping clusters (A,B),(A,C)
    merge against stale/deleted files (`cli.ts:465–512`).
17. **A garbled classify response permanently buries a session.**
    `distiller.ts:526` greedy `/\{[\s\S]*\}/` + `run.ts:522–530` records
    `skipped: true` with the current hash; reconcile only targets
    `skipped = 0` — one transient formatting glitch = knowledge dropped with
    no recovery path.
18. **Kie in-body `{error:{message}}` mapped to retryable 502.**
    `distiller.ts:133–135` — permanent errors (bad model, malformed request)
    burn the full 60+120+240s backoff before failing.
19. **MCP cosmetics/guards:** readonly path guards missing *tables* but not
    migration-added *columns* (`archived` etc.) — ancient DBs get raw SQLite
    errors; `server.ts:217` hardcodes version `0.1.1`; `install.ts:13–18`
    prints 4 tools and `vir mcp` help prints 5 — server registers 6.

## Low severity (quick wins / rare triggers)

- Silent numeric coercions: `--top 0`→5, `--limit 0`→default, `--week 1.5`→1
  (self-heal, never error). `readCostLog`: malformed `ts` → record included in
  every window (`cost/log.ts:44`).
- `review.ts`: CRLF frontmatter gets a second frontmatter block on approve
  (`:66`); `.rejected/<basename>` collisions overwrite (`:118`); editor
  exiting non-zero still auto-approves (`:297–309`).
- `cli.ts` dedupe: `rl.close()` not in `finally` — readline leak on throw.
- `doctor.ts:142`: `statSync` outside try/catch — a TOCTOU/EACCES aborts the
  whole doctor table instead of one fail row.
- `daemon/systemd.ts:78–80`: `%` not escaped as `%%` in unit files.
  `daemon/cron.ts:69–73`: any `crontab -l` failure treated as empty — a
  transient failure + successful write could wipe user crontab entries.
  `daemon/index.ts:38`: `realpathSync` pins the daemon to a node-version dir
  (nvm upgrade → daemon dies silently; doctor-check candidate).
- YAML escaping: trailing `\` in a topic renders invalid frontmatter
  (writer/composer/articleDistiller/pdfDistiller escape `"` but not `\`).
- `embeddingSweep.ts:179`: whitespace-only-content rows are perpetually
  "pending" (skipped by sweep, selected by SQL counts).
- Convention: ~35 `console.log` sites in `cli.ts` + **1 in
  `pipeline/writer.ts:465`** (runs under the daemon) vs the display.ts
  monopoly.
- `db.ts:569–570`: `UPDATE … WHERE path LIKE '%/<id>.jsonl'` — `_`/`%` in an
  id act as wildcards; theoretical for UUID ids.

## Verified clean (invariants that hold)

Cost recorded exactly once per successful `callLLM` (retries never
double-count); 4-attempt retry contract; prose/transcript split; `is_error`
tool_results always kept; scrub-before-distill (modulo #15); per-item fault
isolation on all three tracks; ISO-week/UTC period math; `expandHome` on all
four config paths; all 22 CLI actions wrapped in `runAction`; zero
`process.exit` calls; kieTopUpTier 0.9× ordering vs overrides; launchd XML
escaping; MCP stdout discipline (stderr only); retriever +0.2 verified boost
pre-topK on both paths; cosine math; SQL parameterization.

Stale knowledge-base claims retired by this hunt: the article-embedding sweep
gap (fixed 0.9.0) and "preflight undercounts articles" (preflight fixed; the
live variant is `vir status` missing PDFs, #10).

# Bug-hunt verification — 2026-09-11

Re-verification of every outstanding finding in `docs/bug-hunt-2026-07.md`
against source at v0.17.4. Each verdict below cites the file:line it was read
from. Nothing was fixed during this pass; the four items fixed in 0.17.3/0.17.4
are recorded as such with their release.

**Why this pass exists:** the 07-30 audit found that 4 of the doc's 9
high-severity findings were already stale. A backlog nobody re-checks is worse
than no backlog — it makes real bugs and fixed ones look identical.

## Summary

| Severity | Fixed | Still live | Not verified | Total |
|----------|-------|-----------|--------------|-------|
| High (1–9) | 6 | 3 | 0 | 9 |
| Medium (10–19) | 5 | 5 | 0 | 10 |
| Low | 0 | 10 | 2 | 12 |
| **Total** | **11** | **18** | **2** | **31** |

Fixed: #1, #2, #4, #5, #6, #9 (by 0.12.0), #12 (0.17.3), #13, #14, #17, #19
(0.17.4). Still live: #3, #7, #8, #10, #11, #15, #16, #18 and the ten
low-severity items below.

## High severity

- **#1, #2, #4, #5, #6, #9 — FIXED** (confirmed 2026-07-30, unchanged since).
- **#3 — STILL LIVE.** `--full` is honored by the dry-run counters and the
  preflight (`run.ts:1219`, `run.ts:1223`) but NOT by the real distill loops:
  `run.ts:1288` (`if (db.isArticleProcessed(...)) continue;`) and
  `run.ts:1389` (`if (db.isPdfProcessed(...)) continue;`) have no
  `opts.full ||` guard. So `--full --dry-run` prices N documents and the real
  `--full` re-processes 0 of them. The documented "re-process everything"
  contract is still unmet for 2 of 3 sources.
- **#7 — STILL LIVE.** `distiller.ts:200` clears the abort timer in a `finally`
  attached to the `fetch` call, so the timeout covers time-to-headers only.
  The body is read afterwards at `distiller.ts:204` (`response.text()`) and
  `distiller.ts:224` (`response.json()`) with the timer already cleared. A
  mid-body stall hangs the daemon indefinitely — the exact failure mode the
  0.8.1 `KIE_TIMEOUT_MS` fix claims to have closed.
- **#8 — STILL LIVE.** `cli.ts:1275` parses `--limit`, and `runQueryJson`
  (`cli.ts:1223`) honors it — but the human path hardcodes
  `searchWithOutcome(cfg, db, question, 8)` at `cli.ts:1297`. `--limit` is
  silently ignored unless `--json` is passed.

## Medium severity

- **#12 — FIXED in 0.17.3.** Notes resolve by session id
  (`writer.ts locateBySession`), so a retitle preserves the verdict and
  removes the old file instead of forking a duplicate.
- **#13, #14, #17, #19 — FIXED in 0.17.4.** See that release's changelog entry.
- **#10 — STILL LIVE.** `cli.ts:1617-1619` sums
  `listEmbeddingTargets` + `listTopicEmbeddingTargets` +
  `listArticleEmbeddingTargets`. `listPdfEmbeddingTargets` exists
  (`db.ts:1220`) and the sweep uses it, but `vir status` omits it — PDFs
  pending embedding report as 0.
- **#11 — STILL LIVE.** The main dry-run block adds a supplemental estimate for
  PDFs (`run.ts:753`) and has no article equivalent, though the real run
  distills articles (`run.ts:1286`). `vir run --dry-run` under-quotes by the
  entire article cost — the 0.11.1 "money footgun" class, one site left.
- **#15 — STILL LIVE.** `pdfDistiller.ts:115` embeds `Source: ${parsed.filePath}`
  — the absolute local path, including the username — in the provider prompt,
  while the body is scrubbed for exactly that class of data.
- **#16 — STILL LIVE.** `merger.ts:107-112` orders the merge
  `rewriteWinnerBody` → `db.updateContent` → `archiveFile` →
  `appendArchivedSection` → `db.archive`. A throw anywhere after the first two
  leaves the winner rewritten and recorded while the loser is neither archived
  nor marked, so the next run re-merges the same pair compoundingly.
- **#18 — STILL LIVE.** `kieResponseError` maps an in-body `{error:{message}}`
  to `HttpError(502)`. 502 is retryable, so a permanent error (bad model id,
  malformed request) burns the full 60+120+240s backoff before failing. The
  sibling branch preserves the real code from `data.code`; only this one
  invents a status.

## Low severity

All verified against source; all still live.

- `review.ts:60-65` — `setFrontmatter` matches `/^(---\n)/`, so a CRLF file
  (`---\r\n`) misses and a SECOND frontmatter block is prepended on approve.
- `review.ts:117-118` — `.rejected/<basename>` is written with no uniqueness
  check; a basename collision silently overwrites a previously rejected note.
  `merger.ts` has `uniquePath` for exactly this and it is not used here.
- `review.ts:201-202` — `return !res.error` ignores `res.status`, so an editor
  exiting non-zero (`:cq`) still counts as a successful edit and auto-approves.
- `doctor.ts:181` — `statSync(p)` sits outside the try/catch after an
  `existsSync` check; a TOCTOU race or EACCES throws and aborts the whole
  doctor table instead of producing one fail row.
- `daemon/systemd.ts systemdQuote` — escapes backslashes and quotes but not
  `%`, which is systemd's specifier prefix and must be doubled. A path
  containing `%` is misinterpreted by systemd.
- `daemon/cron.ts:70-72` — any non-zero `crontab -l` is treated as an empty
  crontab, not just "no crontab for user". A transient failure followed by a
  successful write wipes the user's existing entries.
- `daemon/index.ts:42` — `realpathSync(process.argv[1])` pins the daemon to a
  node-version-specific path; an nvm upgrade kills it silently. Doctor-check
  candidate.
- `writer.ts:134,137,744` — frontmatter escapes `"` but not `\`, so a topic
  ending in a backslash escapes its own closing quote and emits invalid YAML.
  Same in composer / articleDistiller / pdfDistiller.
- `embeddingSweep.ts:139` — the sweep skips whitespace-only content, but
  `listEmbeddingTargets` (`db.ts:517`) only filters `content != ''`. A
  whitespace-only row is selected forever and never embedded: permanently
  "pending".
- `db.ts:822-828` — `UPDATE sessions ... WHERE path LIKE ?` with
  `%/<sessionId>.jsonl`. `_` and `%` in a session id act as wildcards, so an
  embedding could be written to the wrong row. Theoretical for UUID ids, which
  contain neither.
- **NOT VERIFIED** (2, both cosmetic): the silent numeric coercions
  (`--top 0` → 5 etc.) and the `console.log` convention count. The single
  `console.log` in `writer.ts:188` is confirmed present and does run under the
  daemon.

## Suggested order

1. **#3** — `--full` not honoring the contract it advertises, and the
   dry-run/real-run disagreement makes cost previews wrong too.
2. **#7** — an unbounded hang in the daemon is the worst failure shape here.
3. **#16** — compounding corruption, and it worsens silently with every run.
4. **#15** — leaks a username to a third-party API on every PDF distill.
5. **#10, #11, #18** — wrong numbers and wasted backoff; cheap.
6. The low-severity list, which is mostly one-line fixes with tests.

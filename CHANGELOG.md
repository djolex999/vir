# Changelog

## 0.26.0 — 2026-10-07

**vir reads Codex sessions too, and can distill them on your ChatGPT plan with no API key.**

- **Codex sessions.** Set `codexSessionsDir` (or re-run `vir init`, which now asks which coding agents you use) and vir reads `~/.codex/sessions/` alongside Claude Code. Harness context Codex stores as user messages (environment, AGENTS.md, IDE and file wrappers, in-app browser state, agent-history replays) is stripped; only your request survives. Subagent and review threads are skipped like Claude Code sidechains, `codex exec` runs are skipped like SDK agents, and desktop chats outside a repo group as one `codex-scratch` project. A project used from both agents is one project. New Codex projects start undecided, so nothing is spent until you include them. Archived Codex threads are not read.
- **`provider: "codex-cli"` (experimental).** Distills through `codex exec` on your ChatGPT login: keyless, quota instead of dollars, with the same per-run cap and halt-on-limit as `claude-cli`. Calls run read-only and ephemeral, with Codex's shell, web search, apps, plugins and subagents switched off. Codex picks the model unless you pin one. `vir doctor` checks `codex login status`.
- **`vir mcp install --target codex`** prints the `~/.codex/config.toml` block (or the `codex mcp add vir -- vir mcp` one-liner); vir never edits Codex's config itself.
- **Security: `claude-cli` distill calls run with no tools.** `claude -p` loaded your tools, MCP servers and permission allowlist, while the prompt carries transcript text vir doesn't control. Calls now pass `--tools ""` and `--strict-mcp-config`: no built-in tools, no MCP servers, no claude.ai connectors.
- **Prompts.** Codex sessions are described as "Codex session" in the classify and distill prompts; Claude Code prompts are unchanged byte for byte.
- **Doctor and projects.** One sessions check per configured agent; `vir projects` shows a sources column once a second agent is configured; the "prunes at ~30 days" warning only appears when a pending session can actually be pruned.
- `vir connect` says "1 candidate", not "1 candidates".
- README: a short demo of the connect → review → sync-claude flow.

## 0.25.3 — 2026-10-06

**Small fixes from the first real `vir connect` run.**

- **`vir sync-claude` asks again on a typo** at the per-rule `y / n / s` and the final `y / n` prompts, instead of treating it as skip or abort. In a terminal it re-asks up to 5 times; without one it asks once, as before.
- **No rule prompt for a CLAUDE.md that doesn't exist.** Such a rule could never be written and was re-asked every run; `sync-claude` now says once that it's waiting for that file.
- **Sources from merged duplicates are marked `merged`** in the rule hunk, the review screen and the rule file, so the same `[[note]]` appearing twice is explained.
- **`vir connect --dry-run` writes nothing,** not even the lesson-embedding cache, and its cost estimate uses the real output cap (1200 tokens), so "up to $X" is a true upper bound.
- **MCP `vir_query` keeps project-scoped rules under a `project` filter;** rejected-rule matching compares vectors from one embedding model only; rule files say which lines an edit keeps.

## 0.25.2 — 2026-10-06

- **Ships the 0.25.1 fix for real.** The 0.25.1 package was built a moment before the fix was merged, so it carried 0.25.0 code: `vir sync-claude` still skipped project folders like `pripremi.rs`. 0.25.2 is the same source as 0.25.1, built correctly.

## 0.25.1 — 2026-10-06

- **`vir sync-claude` finds projects whose folder name isn't already a slug.** A project folder like `pripremi.rs` or `My App` never matched its own project slug (`pripremi-rs`, `my-app`), so its CLAUDE.md was reported as missing and skipped — it never got a VIR block, and a connect-pass rule scoped to it could not be promoted. Folders under `~/projects`, `~/code` and `~/dev` whose kebab-cased name equals the slug are now matched, after every exact match, so projects that already resolved are unaffected.

## 0.25.0 — 2026-10-06

**vir notices lessons you keep re-learning and proposes them as rules — cited, reviewed, and added to CLAUDE.md only with your yes. Plus a skill so any coding agent can use your notes.**

- **`vir connect`: recurring lessons become proposed rules.** It finds a lesson you've recorded in at least 3 sessions spanning at least 7 days (clustering individual "What Was Learned" items by embedding), and asks the model to state it as one rule with a verbatim quote from each cited note. Invented quotes are discarded. Rules are written to `insights/rules/` as *proposed* and stay out of `vir query`/MCP until you accept them with `vir review --insights`. Accepted rules reach CLAUDE.md only via `vir sync-claude`, one y/n per rule, never under `--force`, `--dry-run` or a non-interactive shell. Rejections are remembered by session, so they survive note rewrites. `vir connect --dry-run` is free; a real run makes at most `connectMaxCandidates` (default 10) LLM calls and asks first. Requires an embedding provider. Thresholds are calibrated on a real 1,292-lesson vault (`docs/connect-pass-eval-2026-10.md`): precise over plentiful, so expect few proposals until your vault has real repeats. `vir status` shows proposed/accepted/awaiting counts. MCP `vir_query` gains `type: "insight"`.
- **Use vir from any agent.** New Agent Skills skill (`npx skills add djolex999/vir`) teaches Claude Code, Codex, Cursor and other skill-aware agents to check your vir notes before they work. It uses the MCP server when registered (with `synthesize: false`, so no LLM cost), else `vir query --json`, else the notes folder directly. It is read-only and never runs paid commands unless asked. A test pins every command, flag and MCP tool it names to the real CLI.

## 0.24.3 — 2026-10-06

**Obsidian is optional. vir writes a folder of markdown, and Obsidian is one good way to read it.**

- **`vir init` asks for a notes folder, not an Obsidian vault.** If the usual vault (`~/Documents/Obsidian/MyVault`) exists it is still the default; otherwise vir suggests `~/notes` and offers to create it. Notes land in `<folder>/vir/` as before. Existing configs are unchanged.
- **The articles folder defaults to `raw/` inside your notes folder** instead of a hard-coded Obsidian path, and the prompt no longer assumes Obsidian Web Clipper.
- **README: new "Without Obsidian" section.** Notes are plain markdown with YAML frontmatter; `vir query` and the MCP server need no editor, and VS Code (Foam / Markdown Memo) resolves the `[[wikilinks]]`.
- **Internal:** transcript discovery, filtering and parsing now go through a session-source layer (Claude Code is the first source), groundwork for supporting more coding agents. No behavior change: `vir run --dry-run`, `vir projects` and `vir doctor` output is identical before and after.

## 0.24.2 — 2026-10-05

**`vir reconcile` follows the same rules as `vir run`, and cost prompts show
real numbers.**

- **Reconcile no longer retries what `vir run` skips.** Rows that errored before the transcript and project filters existed (subagent and workflow transcripts, SDK-agent transcripts, sessions from excluded or undecided projects) were still retried, at full cost. Reconcile now applies the same filters and records those rows with their skip reason; they come back if you change the config.
- **Reconcile tells you when a transcript is gone.** Claude Code deletes old transcripts; those rows can't be retried and are now listed as "transcript gone" instead of "recoverable". On claude-cli the retry cost reads "quota" instead of "$0".
- **A failed reconcile retry counts toward the 3-attempt limit,** like a failed `vir run`, so a session that keeps failing is parked instead of retried on every pass (`--force` still retries it).
- **The `vir run` cost prompt shows a real estimate** ("up to $X", "subscription quota", or "unknown" for an unpriced model) instead of a fixed "$1–5".
- **`$EDITOR` with arguments works in `vir review`** (e.g. `code --wait`).
- **`vir run --full` also re-processes articles and PDFs.**
- **Very large transcripts are trimmed to fit the model's context** (the start and the end are kept, and the trim is logged), instead of failing every attempt.
- **Linux home paths are scrubbed** like macOS ones before anything is stored.

## 0.24.1 — 2026-10-05

**Four small fixes: an outage no longer crashes the run, and cost and config
handling get stricter.**

- **A provider outage no longer crashes `vir run`.** When the preflight probe failed (provider down, expired login), vir reported the outage and then Node killed the process with an extra stack trace in `daemon.log`. It now exits normally with the outage reported once.
- **`vir sync-claude` exits 1 when a `CLAUDE.md` could not be updated**, instead of printing ✗ and exiting 0.
- **`config.json` is never readable by others, even briefly.** It holds your API keys; it is now written to an owner-only temp file and renamed into place, instead of being written with the default permissions and tightened afterwards.
- **Spend on a model with no known price is reported as unknown, not $0.** With a model vir has no price for on your provider (for example `claude-sonnet-5` on Kie), calls were logged as free and `vir cost` under-reported. They are now counted as "unpriced" calls next to the total, cost prompts say "unknown", and `vir doctor` warns about configured models without a price. Add a price under `pricing` in `config.json` to have them counted.

## 0.24.0 — 2026-10-05

**Cost, safety and consistency fixes across the CLI, plus two refactors.**
Nothing here changes what a normal `vir run` produces; it changes what vir
spends, what it can race with, and how much of the code is checked.

- **`vir_query` can skip the paid answer.** Pass `synthesize: false` to get only the matching notes. The tool description now tells the agent that synthesis is billed. Default unchanged.
- **New notes are embedded once, from the same text as every other note.** The vector computed while writing a new note used to be dropped (its database row did not exist yet) and the end-of-run sweep embedded the note again from the body only. The write-time vector is now stored, and the sweep and `vir embed` read the note file so every vector is built from the same text. Existing vectors are untouched until a rewrite or `vir embed --force`.
- **`provider: claude-cli` works under the daemon's minimal PATH.** vir now finds `claude` on PATH or in the usual install locations (next to the Node running vir, `~/.claude/local`, `~/.local/bin`, Homebrew, `/usr/local`), so scheduled runs no longer fail when `claude` lives outside launchd's PATH.
- **No more racing the daemon.** Terminal `vir review`, `dedupe`, `audit` (judging), `compose` and `summarize` now take the pipeline lock and exit with a clear message while another vir process holds it. Dry runs are unaffected.
- **Paid checks ask first.** `vir dedupe` (up to 30 calls) and the `vir lint` contradiction check (up to 20) now confirm before spending; `--yes` skips the prompt. Without a terminal and without `--yes`, the paid step is skipped with a note.
- **`CLAUDE.md` is written atomically.** `sync-claude` writes a temp file and renames it into place, so a crash can no longer truncate your file, and a symlinked `CLAUDE.md` stays a symlink.
- **Rejecting never overwrites an earlier rejected copy** of the same note in `.rejected/`; vir says so instead.
- **Under the hood:** tests and `eval/` are type-checked in CI (`npm run typecheck:all`); `vir run` and `vir reconcile` share one session-distill core; the large commands moved out of `cli.ts` into their own modules.

## 0.23.3 — 2026-10-05

**A skipped re-run no longer hides a note you already had.** When a session
with a distilled note came back through `vir run` (a resumed transcript, or
`--full`) and that pass was skipped by the heuristic filter or by low classify
confidence, the note was marked skipped. Its file stayed in the vault, but it
dropped out of `vir query`, the MCP server, `sync-claude` and rewrites, and
never came back on its own. `vir reconcile` could do the same.

- **The existing note now stays served.** The new transcript is recorded as seen, so a low-confidence session is not re-classified (and billed) on every run. A note hidden by a failed re-distill is served again.
- **Notes already hidden this way are restored automatically** the first time 0.23.3 opens the database. Only rows that this bug can produce are touched.

## 0.23.2 — 2026-10-05

**Two vir processes can no longer both hold the pipeline lock.** The lock
file (`~/.vir/vir.lock`) was checked and then written in two steps, so a
daemon run and a manual `vir run` starting at the same moment could both take
it and distill the same sessions twice.

- **The lock is created atomically.** Exactly one process creates it; the others report that another vir process is running, as before.
- **Clearing a crashed run's leftover lock is guarded too.** Only one process at a time may remove a stale lock (via a short-lived `~/.vir/vir.lock.reclaim`), so a fresh lock is never deleted by mistake. Tested with 8 processes racing on a fresh and on a stale lock: exactly one winner every time.
- **A stale lock that cannot be removed** (for example, a permissions problem) now fails with a clear error instead of being silently overwritten.

## 0.23.1 — 2026-10-05

**A claude-cli quota halt no longer loses articles and PDFs.** When `vir run`
hit the subscription limit, the session loop stopped, but the article and PDF
phases still ran into the same wall and recorded every new item as processed
with an error. Those items were never tried again.

- **A quota halt now stops the whole run.** Project summaries, articles and PDFs are skipped after a halt, and a limit first hit inside the article or PDF phase halts there. Nothing is recorded, so the skipped items are simply new on the next run.
- **Items lost this way in earlier versions are retried automatically on the next run.** An errored article or PDF no longer counts as processed, so no manual step is needed.
- **Failing items stop retrying after 3 attempts,** the same bound sessions have. A changed file starts the count over. Articles and PDFs gain an `attempts` column (additive migration).

## 0.23.0 — 2026-09-29

**`vir review --json`: review from the Obsidian plugin.** The terminal review
loop now has a non-interactive twin with a stable JSON contract, so the
Obsidian plugin can list the queue and approve, reject or restore one note
without spawning a TTY. The interactive loop is unchanged.

- **Queue mode.** `vir review --audited --json` prints the notes `vir audit` flagged, worst first, as `{"items":[...],"counts":{"unaudited":n,"stale":n}}` (`--project` filters). Each item carries the note path, session id, title, category, project, verdict and reason; `counts` says how many notes have no audit yet or a stale one.
- **Actions.** `--approve`, `--reject` and `--restore` with `--json` act on exactly one note and print the result as JSON. Use the one-token `--flag=<path>` form so a path starting with `-` is never read as a flag.
- **Reject stops serving immediately.** `--reject` moves the note into `.rejected/` and calls `markRejected`, so `vir query` no longer returns it before the next run.
- **Path guard.** Actions accept only paths inside the category directories (and `.rejected/` for restore), and only session notes; anything else, including `../` escapes, fails `invalid_args` before touching a file.
- **No racing a run.** The three actions take the pipeline lock and fail with `busy` while a lock-holding run (a normal `vir run`, `vir reconcile`, `vir audit --apply-rejects`) is in progress; `vir run --rewrite-only` and `--dry-run` take no lock.
- **Two new error kinds:** `busy` and `not_found`, alongside the existing ones. Errors follow the `vir query --json` contract: empty stdout, one-line error payload on stderr, exit 1.

## 0.22.1 — 2026-09-28

**`vir audit --apply-rejects` asks only about the notes it will move, and the
audit's rejects were measured before being applied.** The one user-facing
change is the preview fix; the rest is the note-usefulness eval under `eval/`,
which never ships, and a byte-identical extraction of the query-synthesis
prompt (`buildSynthesisPrompt`) that the eval keys its cache on.

- **`vir audit --apply-rejects` previews only what it will move.** The confirmation listed and counted every fresh reject, including notes a human had approved, which the move step then skipped ("move 18 notes?" moved 17). The preview now uses the same approved-note check and shows approved notes as "approved, skipped". The move still re-checks at act time.
- **Note-usefulness eval, second verdict: FAIL on noise, rejects applied on inspection.** A hand check of the first run found one of the 18 rejects was genuinely load-bearing: `208035d9`, the only note on pripremi.rs's legacy email-flag `$unset` with `strict: false`, which also had a title that did not match its body. It was approved and retitled "strict-false-unset-migration" (title from the production title prompt). The eval's reject set now skips human-approved notes, matching exactly what `--apply-rejects` moves; it had been testing a removal that could never happen. Re-run on the remaining 17 rejects (34 exposed questions): 32 answers unchanged; Δrecall −0.015, CI [−0.037, 0.000], passes (> −0.05); Δcontradiction +0.015, CI [0.000, +0.037], fails (≤ +0.02). Every worse answer in both runs was checked by hand, and none traced to a fact held by a removed note: each came from an unrelated note swapping into the top 8 or from the answer being worded differently. At this sample size answer-wording noise alone can decide the gate, so the 17 rejects were applied on that inspection rather than on a PASS. They are reversible with `vir review --restore`.
- **`usefulness run --skip-none`** drops the report-only no-notes arm, which never feeds the gate: about a third fewer answer and grade calls. The run record carries `noneArm: false`, and the summary prints "full − none recall skipped".
- **Note-usefulness eval (`eval/usefulness/`, never shipped): the first measured verdict on `vir audit --apply-rejects` is FAIL, narrowly.** `npm run eval -- usefulness mine|run|show` mines real later-session questions and the facts that session established (82 questions from 71 human sessions), answers each with production retrieval and `synthesize()` against the full vault, the vault with the audit's 18 fresh rejects removed in a DB copy, and no notes, then grades every fact as stated, missing or contradicted. The grader passed all four probes (oracle recall 1.00, null clean 1.00, negation 1.00, re-grade agreement 0.99). On the 38 exposed questions, removing the rejects left 34 answers unchanged, improved 2 and hurt 2: Δrecall −0.007, 95% CI [−0.053, +0.039], against a bound of > −0.05; Δcontradiction +0.013, CI [0.000, +0.033], against a bound of ≤ +0.02. Both bounds miss, so non-inferiority is not shown. The mean effect is near zero and 38 questions leave a wide interval, so this says "not proven safe", not "the rejects are useful". Two rejects did carry facts a later session needed (popis snapshot/backup details, a pripremi.rs migration). Notes overall lift recall by only +0.05 over no notes, CI [+0.02, +0.09]. Run record: `~/.vir/eval/usefulness/runs/2026-09-28T13-04-40-271Z.json` (git abe6e8e, reject-set sha256 d0b4c5bc0f6c…).

## 0.22.0 — 2026-09-26

**`vir audit` and `vir review --audited`: a model judges the vault, a human
still decides.** Every served session note is a candidate for keep, verify,
merge or reject, one at a time, forever — nothing has ever re-graded the
whole vault at once. `vir audit` batches each project's notes (~40k chars a
batch, so near-duplicates usually share one) and asks `models.distill`
(`--model` overrides) for a verdict and a one-line reason per note. It only
ever writes to the `sessions` row — it never moves, rejects or merges a note
itself.

- **Verdicts are suggestions, not gates.** `tasks/lessons.md` (2026-09-18)
  found two model judges "agree on levels and flip a coin on direction" —
  so `vir review --audited` walks only the notes with a fresh non-`keep`
  verdict, worst first (reject, then merge, then verify), showing the
  auditor's reason under each one; the human approves, edits or rejects
  exactly as in plain `vir review` (`--apply-rejects` is the one exception,
  see below).
- **State lives on the row, like `pruned_at`/`rejected_at`.** Five columns —
  `audit_verdict`, `audit_reason`, `audit_merge_into`, `audit_content_hash`,
  `audited_at` — added the normal additive way. A verdict is stale once the
  note's content hash no longer matches; every reader ignores a stale
  verdict, so no upsert path has to know audits exist.
  `vir audit --all` re-audits fresh verdicts anyway.
- **Skips what a human has already settled.** A verified note (`verified:
  true` in frontmatter) is never audited — a human verdict outranks a model
  one. A garbled reply fails only its own batch (exit code 1, the rest keep
  going); a claude-cli subscription limit halts the whole run, the same as
  every other LLM path.
- **`--dry-run`** shows notes, batches and estimated cost with no model
  call. Cost is recorded under stage `audit` in `cost.log`, same chokepoint
  as every other LLM caller.
- **`vir audit --apply-rejects`: the one exception, and only for rejects.**
  It moves notes with a fresh `reject` verdict straight to `.rejected/` —
  no model call, gated behind the pipeline lock like `vir run`, and stamps
  `rejected_by: audit` so the note reads as machine-, not human-, rejected.
  `keep`/`verify`/`merge` are untouched; a stale verdict (content hash no
  longer matches) and an already-occupied `.rejected/` destination are both
  skipped and counted, never overwritten. Fully reversible with
  `vir review --restore <note>`. A note you approved in review, or restored
  after an audit reject, is never moved.
- **Calibration.** On the reference vault (185 notes), the first prompt sent
  76% of notes to verify for title and filler polish; after the fix: 65
  keep, 85 verify, 14 merge, 21 reject, 0 failed batches, 2% of notes the
  reference audit kept came back as reject, 45% exact agreement with an
  Opus audit that could read the repos. A 20-note human sample was agreed
  20/20, but by deference to the model rather than an independent check, so
  it does not confirm the verdicts. `--apply-rejects` ships anyway because
  every move asks first (default No) and is undone by `vir review
  --restore`. A usefulness eval (does Claude answer project questions
  better with the note than without) is the planned replacement gate.

## 0.21.0 — 2026-09-25

**`vir dedupe` merges render like the writer and survive a rewrite.** A
merged note used to differ from a distilled one, and the next
`--rewrite-only` quietly took parts of it away.

- **Same output contract as distill.** The merge prompt strips both notes'
  Related sections before the model sees them, and asks for Summary, What
  Was Learned and Context only. On conflict the newer note wins, not the
  higher-confidence one: staleness depends on age. A reply with no
  `## Summary` throws before any file or row changes.
- **The winner is re-rendered through the writer** (`rewriteRow`, shared
  with `--rewrite-only`), so it keeps the `Project:` / `Category:` header
  and gets neighbour-built Related. The loser is archived first, so it
  can't be one of those neighbours.
- **`## Archived Duplicates` survives rewrites.** It lives only in the
  file, so every rewrite deleted it, and `vir prune` stopped protecting
  merge winners. `write()` now carries it over. On the reference vault,
  the vault's backup git history gave the exact winner for 12 archived
  losers, and those sections were restored by hand.

**`vir lint --legacy-related [--fix]`: content in old Related sections
comes back.** Before 0.12.0 the distill prompt asked for a `## Related`
section, and the model often filled it with content, not links: file paths
with what lives there, API endpoints, a SQL query. Since 0.12.0 the writer
strips stored Related and rebuilds it from embedding neighbours, so every
`--rewrite-only` dropped those bullets from the file. The database still
held them.

- **`--fix` moves them into `## Details` in stored content**, in the place
  Related was, then re-renders the affected notes. Old-style topic names
  ("Supabase SSR authentication in Next.js API routes") and bare wikilinks
  are still dropped. A bullet counts as a topic name only if it is plain
  words, at most 8 of them, with no code span, path, colon, dash
  separator, parentheses, second sentence or verb of assertion. A dropped
  claim can't be recovered, but a kept topic name only costs a line.
- **Stored content, not the writer.** Every writer version renders
  `## Details`, and `vir dedupe` strips Related from the notes it merges,
  so fixing only the rendering would still lose the content on a merge.
  Pruned and rejected rows are migrated too, so a restore brings back the
  migrated text. Archived dedupe losers are left alone, since nothing
  renders them.
- **Idempotent.** A migrated row has no Related section, so a second pass
  selects nothing. `--fix` holds the pipeline lock. It clears each
  migrated row's embedding, because the embedded text now includes Details.
  The rewrite re-embeds, and the sweep back-fills anything it couldn't.
- **Reference vault:** 340 of 430 stored notes carried a Related section,
  and 336 of them held content: 1313 bullets kept, 146 topic names
  dropped. All 340 were migrated and 129 serving notes re-rendered, with
  no files added or removed. A second pass finds nothing.

## 0.20.0 — 2026-09-25

**A note rejected in `vir review` stops being served.** Review rejected by
moving the file into `.rejected/`, and SQL cannot see where a file is. The
row kept serving every read path built on the database: `listDistilled`
(and so `sync-claude`, summaries, `vir_recent_notes`, dedupe and lint),
`getStats` and `vir status`, and the embedding sweep. It dropped out of
search only by accident, because the moved file read as empty content.

- **`rejected_at` on the sessions row**, the same shape as `pruned_at`.
  The row keeps its content and stays processed, so nothing is re-distilled
  or re-billed. Every serving query now carries one gate for both states
  (`servingGate()`). Each clause is only added when its column exists, so
  the read-only MCP server works on a database that hasn't been migrated.
- **Backfilled from the files.** `vir run` and `vir review` sync every
  note in `.rejected/` that carries a `rejected_at` stamp into the
  database. Notes `vir prune` moved there carry no such stamp and keep
  their own state.
- **Rows are matched on the full session id**, never the 8-character
  filename suffix. Ids are UUIDs or `agent-<hex>`, which 785 rows in the
  reference DB use; anything outside that alphabet selects nothing, so a
  hand-edited frontmatter can't slip a `LIKE` wildcard in.
- **`vir review --restore <note>`** moves one rejected note back, removes
  its stamp and puts its row back on every read path. It refuses to
  overwrite a note already at the destination.
- **Reference vault:** a 2026-09-25 audit rejected 116 notes. `vir status`
  still counted 296 notes against 180 files. After the sync it counts 180.

**Notes record which git branches their session ran on.** Each line of a
Claude Code transcript carries `gitBranch`. The parser now collects them in
first-seen order and the writer emits a `branches:` list in frontmatter.
Detached `HEAD` is skipped, and the key is left out when the transcript has
none.

- **Why now, with nothing reading it yet.** A 2026-09-25 vault audit found
  notes describing work that never left its branch as if it were live (4
  of 25 on the current prompt). Whether a branch merged can only be known
  later, and 69% of 291 recent sessions ran off `main`, so writing "on
  branch X" into the note would be wrong most of the time within a week.
  A later check can compare this field against the repo. The field has to
  be captured now: Claude Code deletes transcripts after about 30 days, and
  what isn't recorded then can't be backfilled.
- **`--rewrite-only` keeps the block.** A rewrite has no transcript, so it
  carries the existing `branches:` list over, the same way it keeps
  `themes:`.
- **No LLM change.** The distill prompt, classify and cost are unchanged.

**A note is titled from the note.** The topic, which becomes the filename,
the alias and the title shown in every retrieval result, used to come from
classify. Classify reads the session's raw summary before the note exists,
and on the 09-18 prompt 10 of 25 titles no longer matched the note they
headed: `offline-backup-in-separate-database` on a note about trademark
research, `authentic-storytelling-beats-polished-copy` on an idle-shortcut
bug. A cheap classify-model call now names the finished note, and its title
replaces classify's.

- **Blind-judged before shipping.** An Opus judge, shown only the note body
  and the two titles in random order, preferred the new title on 23 of 25
  current-prompt notes, and on 7 of the 8 the vault audit had flagged. A
  variant that added "in English" and "name the specific thing" tied it
  13-12 and drifted onto side bullets, so it was not kept.
- **A failed naming call never costs the note.** The distill has already
  been paid for, so an unusable reply or a failed call keeps classify's
  topic, with a warning. A subscription limit still propagates, so the run
  loop halts on it as before.
- **Cost:** one classify-model call per distilled note, about 900 tokens in
  and 40 out. It is logged as stage `retitle` in `cost.log` and included in
  the `vir run --dry-run` estimate. Classify still decides the category,
  project and confidence, and the eval harness, which calls classify and
  distill directly, is unaffected.

**`vir lint --strays --fix`.** The stray check can now clean up what it
finds. It moves `retitle-duplicate` strays into `archived/` and drops
their `index.md` rows. Retrieval already skips that directory, and a move
can be undone by hand.

- **Only retitle duplicates move.** They are the one kind where a live
  sibling proves nothing unique is lost. An `unknown` stray may be the only
  copy of its text. A pruned leftover belongs to prune's `.rejected/`
  bookkeeping, which `--restore` reads by exact name. Both are reported and
  left where they are.
- **It holds the pipeline lock.** A concurrent `vir run` may be rewriting
  the same session's note, so `--fix` refuses to run while the lock is held.
- **It never overwrites.** A basename already in `archived/` (from dedupe
  or an earlier demotion) gets a `-1` suffix instead.
- **Reference vault:** 32 strays moved, 0 left. They were about a tenth of
  the 337 live notes a 2026-09-25 audit graded, and they are the source of
  its "one session split into several notes" finding.

## 0.19.0 — 2026-09-25

**macOS notifications come from vir, not Script Editor.**

- **They used to say "Script Editor".** `osascript display notification` is
  attributed to Script Editor, with its icon, and there was no way to tell
  vir's banners apart or to silence them without silencing Script Editor.
- **Now a bundled helper app posts them.** `Vir.app` (bundle id
  `dev.vir.app`, source in `native/notifier/`) shows as **vir** with the vir
  icon, and gets its own entry in System Settings → Notifications. It ships
  prebuilt: a universal, ad-hoc-signed binary, so installing needs no Swift
  toolchain. On first use it is copied to `~/.vir/Vir.app` and registered
  with LaunchServices.
- **macOS asks once.** `vir init` shows the Allow prompt at the end of setup,
  and the new `vir notifications` command shows it on demand, then sends a
  test banner. The daemon never prompts: macOS counts a prompt that nobody
  answers as a denial. Until notifications are allowed, vir falls back to
  osascript as before.
- **`vir doctor` has a new `notifications` row** (macOS, when
  `notifications` is on). It shows allowed, not set up, blocked (with where
  to fix it), or helper unavailable.

## 0.18.2 — 2026-09-24

**A failed provider preflight now reaches you.** One fix.

- **A logged-out daemon was silent.** The preflight probe aborts a run
  before the distill loop, so it records no per-session error rows. That
  part is deliberate: one outage is one fact, not N session failures. But
  it also meant the distill-failures notification and doctor row never
  fired. From 2026-09-23 every daemon run died on
  `Failed to authenticate: OAuth session expired`, and the only trace was a
  stack trace in `daemon.log`.
- **Now a failed preflight on a daemon run sends one desktop notification**
  naming the provider and the error. For a logged-out claude-cli it says
  what to do: run `claude` and `/login`. `notifications: false` silences it;
  interactive runs already print the error and don't notify.
- **`vir doctor` has a new `provider preflight` row.** Each failure is kept
  in `~/.vir/provider-preflight.failed` and cleared by the next successful
  probe. A failure from the last 2 days is a fail, an older one a warning.
  It sits apart from `provider auth` because that row pings from your shell,
  while this one reports what the last real run saw.
- Retry and attempt-counter behaviour is unchanged.

## 0.18.1 — 2026-09-23

**`vir reconcile` restores a note whose transcript is gone.** One fix.

- **A good note could stay hidden forever.** A session that distilled
  cleanly, then failed a later re-distill, keeps its content and gains an
  error, and `listDistilled` hides any row with an error. Once Claude Code
  pruned the transcript, reconcile's only move was to clear that stale
  error, and it never did: the loop skipped every target with a missing
  file before reaching the branch that restores it. The restore now runs
  first. Surviving content is restored and counted as recovered; a row
  with no content is still reported as a missing file.
- Reported by kantorcodes1 on r/ClaudeCode, who found it by reading the
  code. The case is now a test.

## 0.18.0 — 2026-09-18

**The distill prompt now writes for both of a note's readers.** A blind A/B
on 15 real transcripts (`eval/distill/`, never shipped) found the notes have
two readers with opposite needs: the human skimming a month later wanted the
opening to say what the session was (14 of 15 forced choices), and a model
standing in for a retrieving session wanted state and specifics first (14 of
15, same test, both side orders). The new prompt asks for both, in that
order, and passed a rule fixed before any output existed: the human no longer
preferred the old prompt (8 to 7) and the model preferred the new one (10 to 1
on full notes, p = 0.012).

- **Summary, sentence one:** what the session was, in plain words. **Sentence
  two:** the single most important thing it established, with the file,
  function, command, number or constraint that carries it.
- **Decisions say what was chosen and what it was chosen over.** Context stops
  repeating the project, category and date already in frontmatter.
- **"You are writing a page about the session, not replying to it."** A longer
  experimental prompt once made Haiku echo a session's closing chat message
  instead of writing a note; this line is the guard, and the failure did not
  recur across the test set.
- **Distill output cap 1500 → 2500 tokens.** Notes under this prompt average
  about 540 words, and the old cap was already cutting 550-590-word notes
  mid-sentence on the API path. Worst-case added cost is about $0.015 per note.
- The prompt text lives in one exported function, `buildDistillPrompt`, pinned
  byte-for-byte to the tested file by a test. The output contract is unchanged
  (marker-less body, same three headings, no Related section, title still from
  classify), so nothing downstream moves.
- **Existing notes are untouched.** Only new distills get the new shape; most
  old transcripts are gone, so there is no backfill. A `--full` run re-distills
  the few sessions whose transcripts still exist.

Honest limits: one human grader, note tops only, 15 transcripts; the model
judge is the same family as the distiller, so its verdict is a preview, not
verification.

## 0.17.8 — 2026-09-11

**Distill failures are now visible while they can still be fixed.** `vir run`
already recorded an error row per failed session and logged it — correct, and
also invisible, because the daemon is unattended and nobody reads daemon.log.
In the vault this was built against, 14 sessions died in one `fetch failed`
window on 2026-06-11 and were found three months later, by which time Claude
Code had deleted the transcripts and the knowledge was gone. 27 such rows
exist there and not one is recoverable.

- **A desktop notification at the end of any run that errored**, mirroring the
  existing projects-awaiting-decision notice. This is the half that reaches
  you the same day, while `vir reconcile` can still act. Respects
  `notifications: false`.
- **A `distill failures` row in `vir doctor`** carrying the standing state:
  how many failed, how many are still recoverable, the date of the last one,
  and the worst single day — because a cluster is the signal. 15 failures in
  one afternoon is an outage; 15 across a quarter is noise.
- **Severity keys on recoverability, not count.** Recoverable means the
  transcript still exists on disk, which is the only thing reconcile can act
  on: `fail` inside the ~7-day window, `warn` when older but still retryable,
  and `ok` once the transcripts have expired. A permanent red row for work
  nobody can do teaches people to ignore the whole table, so an expired
  backlog is reported as a fact with no call to action.
- Human table only; the 8-field `doctor --json` contract is unchanged.

## 0.17.7 — 2026-09-11

**`vir lint --strays`.** Finds note files that no live database row can
account for — pre-0.17.3 retitle debris, 32 of them in the reference vault
(one session accounts for five). Reporting only; nothing is moved or deleted.

- **Strays are retrievable, which is why this matters.** The embedding path
  never surfaces them: `getEmbeddings` builds each note's path from its
  CURRENT topic, so a stale slug never resolves. But the TF-IDF walk indexes
  every category dir — it skips only `summaries`, `.rejected` and `archived` —
  so whenever the embedder is down, one session can be cited twice under two
  titles and take two slots in the same top-k. That is observable in this
  vault's own query log.
- **The check asks whether ANY non-pruned row can produce a filename**, and
  deliberately ignores the content column. A session awaiting `vir reconcile`
  has empty content while its file on disk holds the only copy of the text, so
  a content-based test reports a live note as debris. The one-off script
  written for this cleanup did exactly that and would have demoted a real
  note; the case is now a test.
- **Strays are classified, not just counted.** `retitle-duplicate` (a live
  sibling shares the session id, so nothing unique is in the file, and the
  report names it), `pruned-leftover` (the demoted copy belongs in
  `.rejected/`), and `unknown` (no row at all — reported with no
  recommendation and flagged as possibly the only copy).
- `vir lint --strays` runs the check alone; a bare `vir lint` includes it.
- **A flaky test of our own, fixed.** `writer.related.test` asserted "no
  embedding provider" by relying on Ollama being absent from the machine, and
  broke the moment Ollama was running — the exact machine-dependent assertion
  the `providerOverride` seam exists to prevent. It now sets
  `embeddingProvider: "none"` explicitly.

## 0.17.6 — 2026-09-11

**A rewrite with no embedder no longer wipes every Related section.** One
fix, on the path you reach for straight after `vir prune --apply`.

- **`vir run --rewrite-only` with no embedding provider used to strip the
  Related section from every note in the vault, silently.** `neighborLinks`
  needs a vector; without a provider `computeNoteEmbedding` returns null, the
  writer computed ZERO neighbours, and zero neighbours renders identically to
  a note that genuinely has none. The self-heal sweep does not undo it — it
  stores embeddings, it does not rewrite notes — so the loss persisted until
  another rewrite with a working provider. `write()` now falls back to
  `preservedRelatedSection` (the existing block, verbatim) whenever there is
  no vector, mirroring `preservedThemesBlock`. A rewrite without an embedder
  is a no-op for links instead of a wipe.
- **Dangling wikilinks after a prune are cleared by regenerating, never by
  editing notes.** `neighborLinks` reads `db.getEmbeddings`, which the prune
  gate filters, so a pruned note disappears from every Related section on the
  next `vir run --rewrite-only` — by construction, now pinned by a test. The
  consequence of the fix above is worth stating: clearing dangling links
  REQUIRES a working embedding provider. With one down the rewrite preserves
  them, which is the safe failure but not the fix.

## 0.17.5 — 2026-09-11

**`vir prune`.** 0.14.0's agent-transcript filters are forward-only, so every
note distilled before them is still in the vault, the embedding pool, TF-IDF
and all six MCP tools. This demotes them. Dry run is the default; nothing is
ever deleted.

- **`vir prune`** reports what it would demote, per reason, and exits.
  `--apply` moves each note to `.rejected/` and marks its row; `--restore`
  puts every pruned note back byte-for-byte. On the vault this was built
  against: 132 candidates (129 sidechain, 3 workflow), 278 kept.
- **Prune state is DB-authoritative** — `pruned_at` + `prune_reason` on the
  sessions row. Deliberately NOT `skipped`: flipping that on a row holding a
  note is the 0.14.0 semi-prune. And deliberately not frontmatter, which is
  invisible to SQL — the reason `vir review`'s `.rejected/` move leaks through
  eight DB-backed read paths today (`listDistilled` and everything downstream,
  `getStats`, the embedding sweep). Every serving query now carries
  `prunedGate()`, which is a no-op on a DB whose migration has not run, so the
  read-only MCP path still opens an un-migrated database.
- **Gated at the paid boundary.** `--full` bypasses `isProcessed`, so without
  a gate in the run loop it re-classifies and re-distills every pruned session
  and only discovers at `write()` that the note is demoted — billing you on
  every run, forever. The check sits beside the retry bound, which has the
  same "even under --full" reasoning.
- **Classification is pure and zero-I/O.** 396 of 411 distilled transcripts no
  longer exist on disk (Claude Code prunes at ~30 days), and `entrypoint` was
  never backfilled — NULL on 376 of 411 rows — so the stored path does the
  work: `subagents/` yields sidechain, `wf_`/`workflows` yields workflow, and
  a stored `sdk*` entrypoint yields agent. The launcher traps hold by
  construction: the classifier reads `entrypoint` only, never `promptSource`
  (which reads "sdk" on desktop-launched human sessions) and never turn count
  (which would kill single-prompt autonomous runs).
- **Two buckets are reported and never pruned.** `unclassifiable` (no
  entrypoint, transcript gone — 231 rows) and `merge-winner` (dedupe records
  no parentage, so a winner cannot be shown to be all-agent — 12 rows). A
  prune that guesses is a delete with extra steps.
- **`--restore` is exact.** A pruned row keeps its content, embedding and
  hash; the note is stamped with prune's own frontmatter keys, never review's
  `rejected_at`, so a note that is both rejected and pruned restores cleanly.
- **Kept notes are never edited.** Dangling wikilinks pointing at pruned notes
  are counted and reported (177 on the reference vault), never rewritten.
- **`vir doctor`** gains a human-table row with pruned counts per reason and
  the restore hint. The 8-field `doctor --json` contract is unchanged.
- `CATEGORY_DIR` is exported from `writer.ts` rather than re-declared.

## 0.17.4 — 2026-09-11

**Four findings from the July audit backlog.** Two of them lose data; two
lie quietly. No new surface.

- **A garbled classify response no longer buries a session forever.**
  `parseClassification` folded an unparseable response into a confidence-0
  verdict, which `run.ts` recorded as `skipped: true` with the current hash
  — and `vir reconcile` only targets `skipped = 0`. One transient
  formatting glitch dropped that session's knowledge with no recovery path,
  indistinguishable from a session the model had genuinely judged dull. The
  two now diverge where the distinction exists: the fallback branches are
  marked `unparsed` and `run()` throws `ClassifyParseError`, which the
  existing handler routes through `recordError` (skipped = 0, error set,
  attempts + 1). The session becomes a reconcile target and
  `MAX_DISTILL_ATTEMPTS` bounds it at 3 consecutive failures. A real
  low-confidence verdict is untouched — that one is an answer, not an
  accident. (bug-hunt #17)
- **`vir sync-claude` no longer mangles a hand-edited CLAUDE.md.** Both
  markers were matched with a bare first-`indexOf`, no ordering or balance
  check, against a file the user edits by hand. An orphan `VIR:START`
  failed the guard and a SECOND block was appended — and the next sync then
  sliced from the orphan to the new block's END, deleting every line
  written between them (the deletion is armed by one sync and sprung by the
  next). `END` before `START` duplicated the region between them; a second
  complete block was left behind forever; and markers inside a fenced code
  block counted as real, so a CLAUDE.md that DOCUMENTS vir's markers got
  edited at the example. Markers are now located fence-aware and paired
  forward into complete blocks; unbalanced markers are refused with a
  reason and nothing is written, because appending was what armed the
  deletion. `applyPlan` returns `{ ok, reason }` and `vir sync-claude`
  prints it. (bug-hunt #13)
- **A `config.pricing` override for an unknown model no longer logs $0.**
  `resolvePricing` returned null as soon as the model was absent from
  `DEFAULT_PRICING`, before overrides were consulted — so an override for a
  model id newer than the table, which is exactly what the override exists
  for, priced the run at $0 silently. Only a COMPLETE override stands
  alone: with no base to patch, half a price is a wrong price. (bug-hunt
  #14)
- **MCP stops telling clients three untrue things.** It announced
  `version: "0.1.1"`, a literal untouched since the first release — now
  `readVirVersion()`, with a test asserting the initialiser carries no
  literal at all. `vir mcp install` advertised 4 tools while the server
  registers 6; both sides now read one `VIR_TOOLS` list, pinned by a test
  that scans the server's own `registerTool` calls, so a new tool cannot
  ship half-announced. And `getStats()` names six migration-added columns
  while the read-only MCP path deliberately skips migrations, so on an
  upgraded-but-never-written DB `vir_status` died with `no such column:
  category`; it now degrades to empty stats. (bug-hunt #19)

## 0.17.3 — 2026-09-11

**A note is identified by its session, not by its title.** Completes the
0.17.2 fix, which only covered half the cases. Includes everything in
0.17.2, which was tagged but never published.

- **A retitle no longer loses the review verdict or forks a duplicate.** A
  note's path is `makeSlug(topic, sessionId)` — built from the *topic*, which
  the distiller changes between runs on purpose (0.9.1 retitles
  deliberately). The path was therefore never identity. Every consumer that
  recomputed it from the current topic missed the note it meant to update:
  `preservedReviewFields()` read the new path, so `verified` / `reviewed_at`
  and the +0.2 retrieval boost were dropped; the old note stayed behind as a
  duplicate; and the 0.17.2 `.rejected/` guard keyed off the current slug
  too, so a retitled note came back rejected-no-more. Three symptoms, one
  cause. (bug-hunt #12, finishing #9)
- **`locateBySession()`** indexes the vault by the filename's session suffix,
  built once per writer and kept current as notes are written — a rescan per
  note would be O(n²) on a vault with thousands. `.rejected/` is scanned last
  so it wins: a rejection is the authoritative location for its session. A
  stale hit (a note `vir review` moved between runs) triggers one rebuild;
  a miss never does, so a batch of new notes doesn't rescan per note.
- **The suffix is an index hint; the full id is the authority.** `makeSlug`
  truncates the session id to 8 characters, so two sessions can share a
  filename suffix — and a match authorises deleting the old file. Every hit
  is confirmed against the `session_id` in frontmatter before it is used. A
  collision degrades to an orphaned duplicate, never a deletion. (The first
  draft of this patch resolved on the suffix alone and deleted the colliding
  note; the collision test caught it.)
- **`write()` retires what it replaces** — on a retitle the old file is
  removed and its `index.md` row dropped, since append mode never
  regenerates the index.
- **`archived/` is deliberately not indexed.** A dedupe-merged note being
  re-created by a re-distill is the same shape of problem, but what a merge
  should mean for the loser's session is a product decision, not a
  refactor — it gets its own.

## 0.17.2 — 2026-09-11

**Rejection sticks.** `vir review` rejections survive a `--full` re-distill.
No other behavior changes.

- **A rejected note no longer comes back.** `vir review` rejects by *moving*
  the note into `.rejected/`, which left the category path empty — so
  `preservedReviewFields()`, which carries a verdict across a rewrite by
  reading the destination path, found nothing and a re-distill wrote the
  note straight back as if it had never been rejected. `rejected_at` was in
  that function's keep-list the whole time; it just never had a file to be
  read from. `write()` now checks `.rejected/<slug>.md` first and returns
  that path untouched when it exists: the slug is
  `makeSlug(topic, sessionId)`, so a re-distill of the same session resolves
  to the same filename and the check is exact, not a heuristic. The
  embedding call and the index and log appends are skipped for a note nobody
  wants. `vir reconcile` and rewrite-only runs share `write()`, so one guard
  covers all three paths. (#9)
- **`REJECTED_DIR` has one definition**, in `writer.ts`, imported by
  `review.ts`. The literal was declared in both files — the same drift that
  produced the slug-helper bug (bug-hunt #1), caught before it could bite
  twice.

## 0.17.1 — 2026-09-04

**Website and brand.** No CLI behavior changes.

- **virwiki.dev.** Single-page site in `site/` (Astro, Preact islands, static
  on Vercel): live graph of a real vault sample laid out at build time, the
  note anatomy with the exact `writer.ts` frontmatter, measured numbers
  instead of a benchmark, cost stated up front, dark mode.
- **New mark.** The graph-spiral logo replaces the whirlpool across README,
  the npm package asset, the site, and the Obsidian plugin (vir-obsidian
  0.2.2 ships the matching ribbon icon).
- README numbers re-measured: 534 tests, 396 rescued sessions, 1,386 → 410
  transcripts-to-notes.

## 0.17.0 — 2026-08-13

**New distill provider: your Claude Code subscription.** `provider:
"claude-cli"` shells out to the installed `claude` binary in print mode —
zero per-session dollars, zero credentials. The API path (anthropic) stays
the default for new and existing installs; this ships as an option until it
has real mileage. Existing configs are untouched.

- **`claude-cli` provider** behind the existing `callLLM` seam, alongside
  anthropic and kie. Spawns `claude -p` with arg arrays (never a shell
  string), prompt on stdin, JSON envelope out, per-invocation `--model`
  pinning — hybrid routing survives. Two structural correctness
  requirements, enforced by tests rather than convention:
  `--no-session-persistence` always (vir never writes transcripts into
  `~/.claude/projects` — no self-scanning, no disk bloat) and a fixed
  neutral spawn cwd (`~/.vir`, so no project's CLAUDE.md can leak into
  distill context). Neither has a config path that could omit it.
- **Subscription limits are a wall, not a 429.** A detected limit
  (`ClaudeCliLimitError`) is never retried, halts `vir run` and
  `vir reconcile` with one message carrying the reset time, and burns no
  per-session attempt counters — one environmental fact, not N failures
  (the preflight-probe lesson). The detection regex is docs-sourced and
  honestly labeled UNVERIFIED: any unrecognized error envelope is written
  raw to daemon.log once per run as evidence, unknown errors fail safe
  (no retry chains), the first real match stamps
  `~/.vir/claude-cli-limit.confirmed`, and a new `vir doctor` "limit
  detection" row reports whether the pattern has ever been confirmed.
- **Batch cap: 25 sessions per run** on claude-cli only. Subscription quota
  has no meter, so a big backlog is bounded per cycle (~50 CLI calls ≈ one
  heavy interactive session); the cap is stated before the loop starts and
  the deferred remainder is reported and picked up next run. API providers
  are never capped.
- **Cost honesty.** claude-cli calls land in cost.log with
  `estimated_cost_usd: null` — cost not-applicable, never a fake $0.00
  that would corrupt dollar aggregates. `vir cost` reports them as a
  separate subscription-calls count, excluded from total/median/p90;
  dry-run estimates label "subscription quota (no $)".
- **`vir init` presents the choice honestly**, one line each: API key =
  predictable per-session cost, no effect on Claude Code limits;
  subscription = free and keyless, consumes your Claude Code usage limits.
  claude-cli asks for no key. `vir doctor` authenticates it with the
  existing claude-CLI detector plus a live ping.
- **Re-init key survival is now enforced by schema enumeration.**
  `buildInitConfig` had silently dropped a config key three times (bug #5,
  the projects map, logQueries); a new test enumerates `ConfigSchema`
  itself, so any future key must declare a survival sample and be carried
  over — by construction, not by remembering. The test immediately caught
  a FOURTH live drop: `embeddingProvider` (never carried since 0.15.0 — a
  configured provider silently reset to auto-detect on re-init). Fixed.

## 0.16.0 — 2026-08-13

**Retrieval logging.** Every `vir query` and MCP `vir_query` retrieval now
appends one record to a local, append-only `~/.vir/queries.jsonl` — which
notes surfaced, at what rank and score, by which method, and how fast. The
log is the ground truth for which notes earn their place in retrieval, and
the baseline for future ranking work. Local-only, never transmitted; the
synthesized answer is never recorded. Additive release: ranking, thresholds,
and retrieval behavior are unchanged.

- **Query log** (`~/.vir/queries.jsonl`, JSONL, not SQLite — the read-only
  MCP facade must never write the DB, and file appends don't contend with
  the daemon's SQLite lock). One record per query, written after retrieval
  resolves and before synthesis: timestamp, source (`cli`/`mcp`), query
  text, type filter, method (`embedding`/`tfidf`), degraded flag + reason,
  provider provenance (name/model/dim, null on tfidf), candidate count
  above the floor, model-mismatch exclusions, search latency, and per-hit
  `{slug, rank, score, verified}` — `verified` per hit is how the flat
  +0.2 `VERIFIED_BOOST` eventually gets calibrated instead of guessed.
- **Best-effort, never silent.** A log write failure can never fail a
  query (outer guard, unit-tested), but it emits one stderr line (stderr
  only — MCP stdout is the JSON-RPC channel) and stamps
  `~/.vir/queries.failed`, which the new `vir doctor` "query log" check
  surfaces when a failure post-dates the last successful write within 7
  days. Human table only; the 8-field `doctor --json` contract is unchanged.
- **Rotation.** The log caps at 5 MB; at the cap it rolls to
  `queries.jsonl.1` (one generation kept, ~10 MB bound total). Readers
  merge both generations in order.
- **`vir queries` (+ `--json`).** The payoff: total queries, method split,
  degraded rate, most-surfaced notes with mean rank, and the dead-weight
  list — notes that never surfaced in any logged query, the prune target.
  Dead weight is suppressed (JSON: `null`, never `[]`) below 20 logged
  queries: with a small sample "never surfaced" means unasked, not unused,
  and the report refuses to dress noise as signal.
- **Config: `logQueries`** (default `true`). Documented in the README:
  logged locally, never transmitted, delete anytime, `"logQueries": false`
  to disable.
- `SearchOutcome` gained `candidates` and `provider` provenance fields
  (additive, telemetry-only — never a ranking input).

## 0.15.0 — 2026-07-31

**Embeddings are now optional and provider-agnostic.** A new user needs only
an API key: semantic search activates on demand, and keyword search is a
supported floor, never an error state. Schema migration (additive), a new
provider, and new command surface.

- **Embedding model provenance.** Every embedding row stores the model and
  dimension that produced it (`embedding_model` / `embedding_dim` on all four
  tables; additive migration, existing rows backfill to `nomic-embed-text`/768).
  Retrieval refuses to compare vectors from different models — cosine across
  incompatible geometries is confident nonsense — and reports the excluded
  count instead of silently mixing them.
- **`EmbeddingProvider` interface** (`embedDoc`/`embedQuery`, `modelName`,
  `dimensions`, `maxInputChars`). Ollama is now one implementation, not the
  assumption.
- **Local provider: `vir embed --setup`.** Installs fastembed +
  bge-small-en-v1.5 (384d) into `~/.vir/embedder` on demand — never a package
  dependency (the CLI tarball stays ~212 kB). States the disk cost (~233 MB +
  ~128 MB model) and asks before touching disk or network. No node-gyp, no
  build step, ~190 ms cold start.
- **Provider resolution**: configured (`embeddingProvider` in config, optional)
  > Ollama detected > local installed > none. `vir init` asks no embedding
  question; when nothing resolves, `vir run` prints a one-line offer once per
  run and continues on keyword search.
- **Per-model similarity thresholds** (`RELATED_MIN_SIM`, the candidate floor)
  moved into a per-model table. bge values calibrated against a real 389-note
  vault by quantile-matching nomic's floors (doc-doc distributions are
  near-identical across the two models; bge query scores run ~0.15 hotter).
- **Honest labeling.** `via: tfidf (no provider)` is distinct from
  `via: tfidf (embeddings failed)` — different states, different fixes.
  `vir doctor` reports the active provider, model, dimension, alternatives
  with their costs, and the count of notes embedded under a different model
  (non-zero means an unfinished migration; `vir embed --force` finishes it).
- **Model-boundary re-embeds require consent.** `vir embed --force` across a
  model boundary states the note count and estimated time first; plain
  `vir embed` fills same-model gaps only. The index stays queryable at every
  point mid-migration.
- **Context-limit fix.** Ollama serves nomic at num_ctx 2048; notes over ~8k
  chars used to 500 and silently NULL their embedding forever. `embedText`
  now truncates at the model limit (recorded, not silent) with reactive
  halving, and `EmbedderError` carries a typed kind
  (`context-limit` / `http` / `network`) so daemon.log distinguishes a
  too-big note from a down Ollama.
- **TF-IDF idf smoothing** (`log(1 + N/df)`): a single-note vault can now
  find its own note (bare `log(N/df)` zeroed every term when df = N).
  Established-vault rankings shift minimally (top-3 changes limited to
  adjacent swaps on a 412-note corpus).
- `OLLAMA_HOST` env var overrides the Ollama base URL (Ollama's own
  convention).

## 0.14.0 — 2026-07-31

**Project-level and transcript-category distillation filtering.** Every
filter gates at the SCAN phase — before the paid classify call — and every
skip records a DB row with its reason; never a silent omission.

- **Per-project decisions** (`projects` config map, three-state: include /
  exclude / absent = undecided). Undecided sessions record `project-pending`
  and wait; the daemon never prompts (macOS notification instead, behind the
  new `notifications` flag); interactive `vir run` and `vir init` triage via
  a multi-select showing session counts and rough costs. Multi-select
  defaults to over-capture (undecided starts checked) — transcripts prune at
  ~30 days, so a wrong exclude is permanent.
- **`vir projects`**: per-project table (decision, sessions, distilled,
  pending, excluded, est. pending cost), `include|exclude <name>`, `--json`.
- **Project identity** decoded from transcript dir names by longest match
  against real on-disk directories (handles dashed names, dots, deleted
  cwds; falls back to the raw dir name, never guesses).
- **Nested workflow/subagent transcripts** (`subagents/…`, `wf_*`) are
  agent-internal execution, excluded by default (`workflowTranscripts`),
  with distinct `workflow-transcript` / `sidechain-transcript` skip reasons.
- **Top-level SDK-launched harness agents** (review/verify transcripts —
  first user line's `entrypoint` starts with `"sdk"`) excluded by default
  under their own `agentTranscripts` key and `agent-transcript` reason;
  detected entrypoint persisted per session; doctor reports counts by
  entrypoint. On the audited machine these were 67 of 97 top-level
  transcripts.
- **All filter skips are reversible** (flipping a decision or knob re-enters
  the transcripts) and **forward-only** (a row holding a distilled note is
  never overwritten — existing notes stay retrievable).
- **One-off run scoping**: `vir run --only <p>` / `--exclude-project <p>`
  (repeatable, never persisted).
- **`vir doctor`**: warns on undecided projects (with oldest-transcript age
  and the ~30-day prune deadline); informational agent-transcript line.
- **Default provider is now anthropic + claude-sonnet-5** (Kie stays fully
  supported; existing kie configs untouched, one-line notice on interactive
  runs). Provider preflight probe makes an outage one clear failure instead
  of N retry chains.
- **`vir init` masks API-key input** and echoes only a masked confirmation.
- New dep: `@inquirer/checkbox` (the multi-select). Additive DB migrations:
  `skip_reason`, `entrypoint`.

## 0.13.0 — 2026-07-30

- **Retry bound:** 3 consecutive failed distills park a session (new
  `sessions.attempts` column, reset on success) — `vir run` skips it even
  under `--full`; `vir reconcile --force` is the only way back in.
- **Process lock:** `~/.vir/vir.lock` pidfile with stale-PID reclaim
  serializes distiller-calling commands; a second `vir run`/`vir reconcile`
  exits immediately with the holder PID instead of double-spending.
- **`vir schedule install` no longer starts a paid run** (`RunAtLoad` is now
  false); new `--run-now` flag opts into an immediate first tick.
- **`vir doctor` backup-freshness check** (renders only when
  `~/.vir/backup.sh` exists): warns when the last successful backup is
  older than 48h.

Earlier releases (≤ 0.12.0) are documented in their annotated git tags and
commit messages (`git log --oneline --decorate`).

## 0.12.1 — 2026-07-30

Bug-fix release: eight fixes, all TDD (RED → GREEN), one commit each.

- `vir run --rewrite-only --dry-run` no longer rewrites the vault under the
  dry-run banner — it reports the would-rewrite count and exits before any
  write or index regeneration.
- Network-level fetch failures (`TypeError` with an error `cause` — undici's
  ECONNREFUSED/ENOTFOUND/socket-reset shape) are now retryable on the Kie
  path; previously they burned zero retries (30 of 41 backlog rows).
- `vir doctor`'s Ollama check performs a one-shot embedding probe instead of
  a reachability ping; `--json`'s `ollama.model` is the probe result (null
  when embedding fails), never an echoed constant.
- Embedding failures during `vir query` degrade to TF-IDF *loudly*: the error
  is surfaced, the result set is marked degraded, and the `via:` label
  reflects what actually served the results.
- A failed re-distill no longer records the transcript hash (hash = success
  marker), so changed transcripts stay eligible for `vir run`; the reconcile
  selector also claims error rows with surviving content (rescuing rows
  already orphaned) and restores the last good note when the source
  transcript is gone.
- `vir doctor` distinguishes daemon "not installed" from "installed but not
  running" — and the latter no longer reports ok.
- The TF-IDF fallback walk skips `.rejected/` and `archived/`, so
  human-rejected and dedupe-archived notes can never resurface via
  `vir query` / MCP `vir_query`.
- `docs/bug-hunt-2026-07.md` re-verified: 6 findings marked resolved with
  source refs, 3 marked not-re-verified.

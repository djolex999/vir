# Review queue in Obsidian — design

Date: 2026-09-28
Status: approved in brainstorming, pending spec review
Repos: `vir` (CLI 0.23.0) and `vir-obsidian` (plugin 0.3.0)

## Goal

Curate the vault from Obsidian instead of the terminal. The plugin gets a
Review tab that walks the notes `vir audit` flagged, worst first, and an
active-note card that shows any open session note's verdict with Approve and
Reject buttons. This replaces `vir review --audited` for people who read notes
in Obsidian anyway.

Part of the plugin upgrade sequence agreed on 2026-09-28: 0.2.2 parity
(shipped), **0.3.0 review queue (this spec)**, 0.4.0 Topics tab + Compose,
Ask-the-vault deferred.

## Decisions made in brainstorming

| Question | Decision |
|---|---|
| Interaction model | Both: a queue tab as the main surface, plus the verdict and actions on the active note |
| Queue contents | Fresh non-`keep` verdicts only (reject → merge → verify), same as `vir review --audited`. Unaudited and stale notes are counted in the header, not listed |
| Reject safety | Reject immediately; an 8-second notice offers Undo |
| Running `vir audit` from Obsidian | No. It is a paid, multi-minute run with a cost prompt; it stays in the terminal |
| Contract shape | Non-interactive `--json` modes on `vir review` (not a new `vir notes` group, not plugin-side frontmatter writes) |

## Background: how review works today

- **Approve** (`approveNote`, `src/cli/review.ts`) writes `verified: true` and
  `reviewed_at` into the note's frontmatter. Nothing touches the database.
- **Reject** (`rejectNote`) stamps `rejected_at` and moves the file to
  `.rejected/`. The database row is marked rejected lazily, by
  `syncRejections` on the next `vir run` or `vir review`. Until then
  `vir query` can still serve the moved note's old path.
- **Restore** (`restoreRejected`) moves a note back to its category folder and
  clears the row's rejection. It stamps `verified: true` only when the note
  was machine-rejected (`rejected_by: audit`). A human reject is restored
  unreviewed, which is exactly what Undo needs.
- **Audit verdicts** live only in SQLite (`audit_verdict`, `audit_reason`,
  `audit_merge_into`, `audit_content_hash`, `audited_at`). A verdict is fresh
  while the hash matches the row's stored content, not the file, so editing
  a note in Obsidian does not make its verdict stale.
- Terminal `vir review` does not take the pipeline lock.

Reference vault on 2026-09-28: about 196 serving notes; verdicts are 85
verify, 14 merge, 4 reject, 65 keep, 28 never audited. The queue is about 100
notes.

## Part 1: CLI contract (vir-cli 0.23.0)

All new behavior is on `vir review`. With `--json`, a mode is
non-interactive: exactly one JSON value on stdout, no prompts, and the exit
code decides success (0 = result, non-zero = `VirErrorPayload`).

### Queue: `vir review --audited --json`

```ts
interface VirReviewQueue {
  items: VirReviewItem[];      // fresh non-keep verdicts, orderForAudit order
  counts: { unaudited: number; stale: number };
}

interface VirReviewItem {
  path: string;                // vault-relative, same base as query --json
  sessionId: string;
  title: string;               // frontmatter `topic`
  category: VirQueryCategory;
  project: string | null;
  date: string;
  confidence: number;
  verdict: "reject" | "merge" | "verify";
  reason: string;
  mergeInto: { sessionId: string; path: string | null; title: string | null } | null;
  auditedAt: string;
}
```

- Built by a pure function next to `buildQueryResults` in `src/output/json.ts`
  from `collectNotes` + `db.listAudits()` + `orderForAudit`, so the JSON queue
  and the terminal queue cannot disagree on membership or order.
- `counts.unaudited`: serving session notes, not verified, with no verdict.
  `counts.stale`: notes whose verdict is not fresh.
- `--project` filters as in the terminal. `--limit` is ignored in JSON mode.
- `mergeInto.path`/`title` are null when the target is no longer serving.

### Actions

```
vir review --approve=<path> --json
vir review --reject=<path> --json
vir review --restore=<name> --json
```

```ts
interface VirReviewActionResult {
  action: "approve" | "reject" | "restore";
  path: string;        // where the note is now (.rejected/… after a reject)
  sessionId: string;
}
```

- **Reject** also marks the row rejected immediately (`db.markRejected`), so
  `vir query` stops serving the note at once instead of after the next run.
- **Path guard.** For approve and reject, `<path>` is resolved against the
  vault root and must land inside a category folder (`CATEGORY_DIR`), end in
  `.md`, and carry a `session_id`. For restore, `<name>` must be a file
  directly inside `.rejected/`. Anything else (`..`, absolute paths outside
  the vault, topic/article/pdf notes) exits with `kind: "invalid_args"`.
- **Lock.** The three actions take the pipeline lock without waiting
  (`acquireLock`). If it is held, they exit with `kind: "busy"`. Queue listing
  is read-only and takes no lock.
- **Errors.** `VirErrorKind` gains `"busy"` and `"not_found"` (the note is not
  at `<path>`). Existing kinds are unchanged.
- The interactive terminal loop is unchanged, including its lack of a lock.

### Compatibility

`doctor --json` is unchanged. The plugin gates the feature on its `version`
being at least `0.23.0`.

### CLI tests

- Path guard: accepts a category note; rejects `..`, outside-vault, topic,
  article, pdf, a missing file, and a non-`.md` path.
- Queue builder: membership and order match `orderForAudit`; counts; merge
  target resolution including a target that no longer serves.
- One integration test per action on a temp vault + temp DB, asserting both
  the file result and the row state (reject → row rejected; restore → row
  serving, human reject restored without `verified`).
- Busy: an action with the lock held exits non-zero with `kind: "busy"` and
  changes nothing.

## Part 2: Plugin (vir-obsidian 0.3.0)

### Units

| Unit | Responsibility | Tested by |
|---|---|---|
| `VirClient.reviewQueue()`, `VirClient.review(action, target)` | Spawn with `--approve=<path>` style arguments (never a bare positional, so a leading `-` cannot read as a flag); parse the Part 1 shapes | Existing fake-vir fixture tests + new contract fixtures |
| `src/lib/review-queue.ts` (pure) | Find by path, remove, re-insert at a clamped index, next item after a path, semver compare | vitest |
| `ReviewStore` | Single holder of the queue and the fetch time. `refresh()`, `approve/reject/restore(path)`, an in-flight flag, and an Obsidian `Events` change event both views subscribe to | vitest with a stub client |
| `ActiveNoteCard` | The in-context panel, rendered at the top of the Review and Related tabs | Manual |
| `ReviewTab` | Third `TabId` in `sidebar-view.ts` | Manual |

`src/types.ts` gains `VirReviewQueue`, `VirReviewItem`,
`VirReviewActionResult`, and the two new error kinds, hand-mirrored as usual
and pinned by contract fixtures captured from the real CLI.

### Review tab

Top to bottom:

1. The active-note card.
2. Header: "103 to review · 28 not audited · 6 stale · fetched 12m ago", and a
   refresh button.
3. The queue. Rows reuse `renderResultRow` with a verdict badge (reject red,
   merge orange, verify yellow) and the auditor's reason as a muted line.
   Clicking a row opens the note.

### Active-note card

- Shown only when the active file is a vir session note: it has a
  `session_id`, sits in a category folder, and is not under `archived/`
  (`isArchivedPath`). Topics, articles, and pdfs are not reviewable, as in
  the CLI.
- Shows the verdict and reason when the note is in the queue, "not flagged"
  otherwise, and Approve / Reject buttons.
- A merge verdict shows "merge into *title*", linked to the target note.
- A verified note shows "✓ Verified" and no buttons.
- Reads the store's cache only; switching notes never spawns a process. If
  the queue has never been fetched, the card triggers one fetch.

### Flow

- **Approve:** on success, the item leaves the queue and the next item opens
  in the same leaf.
- **Reject:** the same, plus an 8-second notice "Rejected *title* · Undo".
  Undo calls `--restore=<name>`, re-inserts the item at its old index,
  refetches the queue, and reopens the note.
- **Commands** (hotkey-able): *Approve current note*, *Reject current note*,
  *Open next note to review*.
- **Fetching:** when the Review tab first opens, on refresh, and after Undo.
  After approve/reject the queue is updated locally from the confirmed
  result. No background polling.
- **Version gate:** uses the version the status bar already reads from
  `doctor --json`. Below 0.23.0, the Review tab shows "Update vir to 0.23.0 or
  later to review from Obsidian" and the card is hidden.

## Part 3: Errors and edge cases

The CLI result is the only source of truth. When an outcome is unknown, the
plugin refetches the queue instead of guessing.

| Case | Behavior |
|---|---|
| `busy` | Notice "vir is busy (a run is in progress). Try again in a moment." No local change |
| `not_found` | Notice; drop the item locally; refetch |
| `invalid_args` | Error notice with the CLI message (indicates a bug) |
| Timeout (10 s) | Refetch; notice "Couldn't confirm; queue refreshed" |
| `VirNotFoundError` | Existing "Vir CLI not configured · Open settings" empty state |
| Undo refused (a note already exists at the restore destination) | Error notice with the CLI message; the note stays in `.rejected/` |
| Undo after the notice expires | `vir review --restore <name>` in the terminal (README) |

**Unsaved edits.** If a note is edited and Approve is clicked before Obsidian
saves the buffer, Obsidian can save over the CLI's `verified: true` write and
the stamp is lost silently. Before every action the plugin calls
`await view.save()` on each open `MarkdownView` of that file, then spawns the
CLI.

**Other cases**

- In-flight flag: buttons disabled and commands no-ops while an action runs.
- After a reject the file disappears from its leaf; the next item opens there.
  If the queue is empty the tab shows "Queue clear".
- Undo while another action runs: independent; the re-insert index is clamped.

## Known limitation (not in scope)

Body edits made in the file do not survive the next `vir run --rewrite-only`
or re-distill: the writer renders from the database's stored content and
carries over only the review fields. The terminal `[e]dit` has the same
limitation. The plugin README states it. Fixing it is a separate CLI change.

## Out of scope

- Running `vir audit` from Obsidian.
- An Edit action (the note is already open in the editor).
- Acting on stale verdicts or unaudited notes from the queue.
- Performing merges (still `vir dedupe`).
- Bulk actions (approve all verify, apply all rejects).

## Testing

- CLI: the tests listed in Part 1.
- Plugin: vitest for `review-queue.ts` and `ReviewStore`; contract fixtures
  for the queue, each action result, and the `busy` error, captured from the
  real CLI.
- Manual, in the sandbox vault:
  1. Approve and reject through the queue, including Undo.
  2. Edit a note and approve immediately; reopen it and confirm `verified`.
  3. Run `vir run` and act during it; confirm the `busy` notice.
  4. Point the plugin at a CLI older than 0.23.0; confirm the gate.

## Release order

1. vir-cli 0.23.0 to npm (CHANGELOG entry, docs page for the new flags).
2. vir-obsidian 0.3.0 via tag push. The version gate makes this order safe:
   a user on an older CLI sees the update message, not an error.
3. Update `site/src/content/docs/docs/obsidian-plugin.md`: the plugin now has
   three contracts plus the review actions, not two.

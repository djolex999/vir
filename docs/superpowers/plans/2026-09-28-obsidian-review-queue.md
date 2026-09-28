# Review Queue in Obsidian Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review `vir audit`'s flagged notes from Obsidian: a Review tab (queue, worst first) plus an active-note card with Approve/Reject, backed by new non-interactive `vir review --json` modes.

**Architecture:** Two repos. The CLI (`vir`, this repo) gains a pure queue builder in `src/output/json.ts` and a new `src/cli/reviewJson.ts` that guards paths, takes the pipeline lock, and reuses `approveNote` / `rejectNote` / `restoreRejected`. The plugin (`~/projects/vir-obsidian`) spawns those modes through `VirClient`, keeps the queue in an Obsidian-free `ReviewStore`, and drives UI through a `ReviewController`.

**Tech Stack:** TypeScript (strict), Node, commander, better-sqlite3, vitest; Obsidian plugin API (minAppVersion 1.7.2), esbuild.

**Spec:** `docs/superpowers/specs/2026-09-28-obsidian-review-queue-design.md` (this repo). Read it before any task.

## Global Constraints

- CLI version becomes `0.23.0`; plugin version becomes `0.3.0`; plugin `minAppVersion` stays `1.7.2` (no Obsidian API newer than 1.7.2: use `Notice(DocumentFragment, ms)`, `notice.hide()`, `MarkdownView.save()`, `createFragment`; never `messageEl`).
- JSON I/O convention (same as `vir query --json`): success = one JSON value on stdout, exit 0; failure = stdout EMPTY, one-line `{ "error": string, "kind": VirErrorKind }` on stderr, exit 1.
- `VirErrorKind` = `"ollama_unavailable" | "internal" | "invalid_args" | "no_vault" | "busy" | "not_found"`.
- The plugin passes targets as a single argv token `--approve=<path>` / `--reject=<path>` / `--restore=<name>`, never as a separate positional.
- Paths on the wire are relative to `vaultPath/outputDir`, `/`-separated (same base as `query --json`). The plugin, like the existing Related tab, assumes the Obsidian vault root is that directory.
- Plugin rules from `vir-obsidian/CLAUDE.md` apply: CLI is the only contract; disposal via `registerEvent` / `registerDomEvent` / `registerInterval`; no Obsidian imports in anything under `src/lib/` or in `src/review-store.ts` (vitest runs in Node).
- Notice copy (exact): busy → `vir is busy (a run is in progress). Try again in a moment.`; timeout → `Couldn't confirm; queue refreshed`; undo → `Rejected <title> · Undo` for 8000 ms; old CLI → `Update vir to 0.23.0 or later to review from Obsidian`.
- TypeScript strict, no `any`, named exports (plugin `main.ts` default export stays — Obsidian requires it).
- Do not publish to npm, push tags, or merge. Stop at pushed branches + PRs; the owner releases.

## Review Focus

1. Note filenames with spaces or a leading `-` must reach the CLI as one argument and resolve → pinned in Task 2 (space in filename) and Task 4 (leading-dash target echoes intact).
2. Obsidian vault opened one level above the vir output dir (`vir/patterns/x.md`): the card must stay hidden rather than send a path the CLI rejects → pinned in Task 5 (`isReviewablePath("vir/patterns/x.md") === false`).
3. Approving an already-verified note (stale queue, command fired twice) must stay idempotent: one `verified:` line, not two → pinned in Task 2.
4. Rejecting the last item in the queue: nothing to open next, no crash, queue shows clear → pinned in Task 5 (`nextItem` on empty) and Task 6 (store emptied).
5. Undo refused because a note was recreated at the destination: queue untouched, message surfaced → pinned in Task 6.

---

## Part A — CLI (repo: `vir`, this worktree)

Work on the current branch (`claude/obsidian-plugin-upgrade-scope-7f5401`, which holds the spec). Run tests with `npx vitest run <file>`; the global setup points `$HOME` at a temp dir.

### Task 1: Queue builder and wire types

**Files:**
- Modify: `src/output/json.ts` (imports at top; `VirErrorKind` at ~line 29; append new types + `buildReviewQueue` at end of file)
- Test: `src/output/json.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `ReviewNote`, `AuditedNote` from `src/cli/review.ts` (type-only); `AuditRow` from `src/state/db.ts` (type-only).
- Produces:
  ```ts
  export type VirReviewVerdict = "reject" | "merge" | "verify";
  export interface VirReviewMergeTarget { sessionId: string; path: string | null; title: string | null }
  export interface VirReviewItem { path: string; sessionId: string; title: string; category: VirQueryCategory; project: string | null; date: string; confidence: number; verdict: VirReviewVerdict; reason: string; mergeInto: VirReviewMergeTarget | null; auditedAt: string }
  export interface VirReviewQueue { items: VirReviewItem[]; counts: { unaudited: number; stale: number } }
  export type VirReviewAction = "approve" | "reject" | "restore";
  export interface VirReviewActionResult { action: VirReviewAction; path: string; sessionId: string }
  export function buildReviewQueue(ordered: AuditedNote[], unverified: ReviewNote[], audits: AuditRow[], allNotes: ReviewNote[]): VirReviewQueue
  ```

- [ ] **Step 1: Write the failing test** — append to `src/output/json.test.ts`:

```ts
import { buildReviewQueue } from "./json.js";
import type { AuditedNote, ReviewNote } from "../cli/review.js";
import type { AuditRow } from "../state/db.js";

describe("buildReviewQueue", () => {
  const note = (sessionId: string, over: Partial<ReviewNote> = {}): ReviewNote => ({
    filePath: `/v/patterns/${sessionId}.md`,
    relPath: `patterns/${sessionId}.md`,
    topic: `topic ${sessionId}`,
    category: "pattern",
    project: "demo",
    confidence: 0.9,
    date: "2026-09-01T00:00:00.000Z",
    verified: false,
    sessionId,
    ...over,
  });
  const audit = (
    sessionId: string,
    verdict: AuditRow["verdict"],
    fresh = true,
    mergeInto: string | null = null,
  ): AuditRow => ({
    path: `/p/x/${sessionId}.jsonl`,
    sessionId,
    verdict,
    reason: `why ${sessionId}`,
    mergeInto,
    auditedAt: "2026-09-26T00:00:00.000Z",
    fresh,
  });
  const audited = (n: ReviewNote, a: AuditRow): AuditedNote => ({ ...n, audit: a });

  it("maps ordered notes to wire items, keeping the given order", () => {
    const a = note("a");
    const b = note("b", { relPath: "gotchas/b.md", category: "gotcha", project: "" });
    const q = buildReviewQueue(
      [audited(b, audit("b", "reject")), audited(a, audit("a", "verify"))],
      [a, b],
      [audit("a", "verify"), audit("b", "reject")],
      [a, b],
    );
    expect(q.items.map((i) => [i.sessionId, i.verdict])).toEqual([["b", "reject"], ["a", "verify"]]);
    expect(q.items[0]).toEqual({
      path: "gotchas/b.md",
      sessionId: "b",
      title: "topic b",
      category: "gotcha",
      project: null,
      date: "2026-09-01T00:00:00.000Z",
      confidence: 0.9,
      verdict: "reject",
      reason: "why b",
      mergeInto: null,
      auditedAt: "2026-09-26T00:00:00.000Z",
    });
  });

  it("resolves a merge target from all notes, including verified ones", () => {
    const a = note("a");
    const target = note("t", { relPath: "patterns/t.md", topic: "the target", verified: true });
    const q = buildReviewQueue([audited(a, audit("a", "merge", true, "t"))], [a], [audit("a", "merge", true, "t")], [a, target]);
    expect(q.items[0]?.mergeInto).toEqual({ sessionId: "t", path: "patterns/t.md", title: "the target" });
  });

  it("gives null path/title for a merge target that no longer serves", () => {
    const a = note("a");
    const q = buildReviewQueue([audited(a, audit("a", "merge", true, "gone"))], [a], [audit("a", "merge", true, "gone")], [a]);
    expect(q.items[0]?.mergeInto).toEqual({ sessionId: "gone", path: null, title: null });
  });

  it("counts unaudited and stale among unverified notes", () => {
    const notes = [note("a"), note("b"), note("c"), note("d")];
    const audits = [audit("a", "verify"), audit("b", "keep", false), audit("c", "reject", false)];
    const q = buildReviewQueue([], notes, audits, notes);
    expect(q.counts).toEqual({ unaudited: 1, stale: 2 });
  });

  it("returns an empty queue when nothing was ever audited", () => {
    const notes = [note("a"), note("b")];
    expect(buildReviewQueue([], notes, [], notes)).toEqual({ items: [], counts: { unaudited: 2, stale: 0 } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/output/json.test.ts`
Expected: FAIL — `buildReviewQueue` is not exported.

- [ ] **Step 3: Implement** — in `src/output/json.ts`:

Add imports after the existing ones:
```ts
import type { AuditedNote, ReviewNote } from "../cli/review.js";
import type { AuditRow } from "../state/db.js";
```

Extend the error kinds:
```ts
export type VirErrorKind =
  | "ollama_unavailable"
  | "internal"
  | "invalid_args"
  | "no_vault"
  | "busy"
  | "not_found";
```

Append at the end of the file:
```ts
// ---- vir review --json (the plugin's review queue) ----

export type VirReviewVerdict = "reject" | "merge" | "verify";

export interface VirReviewMergeTarget {
  sessionId: string;
  path: string | null; // null when the target no longer serves
  title: string | null;
}

export interface VirReviewItem {
  path: string; // relative to vaultPath/outputDir, like VirQueryResult.path
  sessionId: string;
  title: string;
  category: VirQueryCategory;
  project: string | null;
  date: string;
  confidence: number;
  verdict: VirReviewVerdict;
  reason: string;
  mergeInto: VirReviewMergeTarget | null;
  auditedAt: string;
}

export interface VirReviewQueue {
  items: VirReviewItem[];
  counts: { unaudited: number; stale: number };
}

export type VirReviewAction = "approve" | "reject" | "restore";

export interface VirReviewActionResult {
  action: VirReviewAction;
  path: string; // where the note is now; `.rejected/<name>` after a reject
  sessionId: string;
}

// Pure: `ordered` is orderForAudit(unverified, audits), so the JSON queue and
// the terminal `--audited` walk share one membership and order rule. Counts
// cover unverified notes only: a verified note needs no review either way.
export function buildReviewQueue(
  ordered: AuditedNote[],
  unverified: ReviewNote[],
  audits: AuditRow[],
  allNotes: ReviewNote[],
): VirReviewQueue {
  const bySession = new Map(allNotes.map((n) => [n.sessionId, n]));
  const items = ordered.map((n): VirReviewItem => {
    const targetId = n.audit.mergeInto;
    const target = targetId !== null ? bySession.get(targetId) : undefined;
    const dir = n.relPath.split("/")[0] ?? "";
    return {
      path: n.relPath,
      sessionId: n.sessionId,
      title: n.topic,
      category: CATEGORY_DIRS[dir] ?? "pattern",
      project: n.project.length > 0 ? n.project : null,
      date: n.date,
      confidence: n.confidence,
      verdict: n.audit.verdict as VirReviewVerdict,
      reason: n.audit.reason,
      mergeInto:
        targetId !== null
          ? { sessionId: targetId, path: target?.relPath ?? null, title: target?.topic ?? null }
          : null,
      auditedAt: n.audit.auditedAt,
    };
  });

  const auditBySession = new Map(audits.map((a) => [a.sessionId, a]));
  let unaudited = 0;
  let stale = 0;
  for (const n of unverified) {
    const a = auditBySession.get(n.sessionId);
    if (a === undefined) unaudited += 1;
    else if (!a.fresh) stale += 1;
  }
  return { items, counts: { unaudited, stale } };
}
```

(`CATEGORY_DIRS` is the existing `Record<string, VirQueryCategory>` near the top of the file. `orderForAudit` never emits `keep`, so the verdict cast is safe.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/output/json.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/output/json.ts src/output/json.test.ts
git commit -m "feat(review): VirReviewQueue wire types and pure buildReviewQueue"
```

### Task 2: Path guards and review actions

**Files:**
- Create: `src/cli/reviewJson.ts`
- Test: `src/cli/reviewJson.test.ts`

**Interfaces:**
- Consumes: `approveNote(filePath, now?)`, `rejectNote(filePath, vaultRoot, now?)`, `restoreRejected(db, vaultRoot, name, now?)`, `parseFrontmatter`, `collectNotes`, `orderForAudit` from `./review.js`; `acquireLock(lockPath?)`, `releaseLock(lockPath?)`, `LockHeldError`, `LOCK_PATH` from `../pipeline/lock.js`; `CATEGORY_DIR`, `REJECTED_DIR` from `../pipeline/writer.js`; `StateDb.markRejected(sessionId, now?)`, `StateDb.listAudits()`; Task 1's types and `buildReviewQueue`.
- Produces:
  ```ts
  export class ReviewJsonError extends Error { readonly kind: VirErrorKind }
  export interface ReviewTarget { absPath: string; relPath: string; sessionId: string }
  export function resolveReviewTarget(vaultRoot: string, input: string): ReviewTarget
  export function resolveRejectedName(vaultRoot: string, input: string): string
  export interface ReviewActionDeps { vaultRoot: string; db: StateDb; lockPath?: string; now?: string }
  export function runReviewAction(deps: ReviewActionDeps, action: VirReviewAction, target: string): VirReviewActionResult
  export function reviewQueue(vaultRoot: string, db: StateDb, project?: string): VirReviewQueue
  ```

- [ ] **Step 1: Write the failing tests** — create `src/cli/reviewJson.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateDb } from "../state/db.js";
import { contentHash } from "../audit/types.js";
import {
  ReviewJsonError,
  resolveRejectedName,
  resolveReviewTarget,
  reviewQueue,
  runReviewAction,
} from "./reviewJson.js";

const SID = "abc12345-0000-4000-8000-000000000001";
const SID2 = "abc12345-0000-4000-8000-000000000002";

function note(sessionId: string | null, extra: string[] = []): string {
  return [
    "---",
    `topic: "test topic"`,
    "category: pattern",
    `project: "demo"`,
    ...(sessionId ? [`session_id: ${sessionId}`] : []),
    "date: 2026-05-01T10:00:00.000Z",
    "confidence: 0.9",
    ...extra,
    "---",
    "",
    "body text",
    "",
  ].join("\n");
}

function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ReviewJsonError ? err.kind : `other: ${(err as Error).message}`;
  }
  return "no error";
}

let root: string;
let vault: string;
let db: StateDb;
let lockPath: string;

const write = (rel: string, content: string): void => {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
};
const seedRow = (sessionId: string): void => {
  db.record({
    path: `/p/-home-u-app/${sessionId}.jsonl`,
    hash: "h",
    skipped: false,
    notePaths: [],
    content: "body",
    category: "pattern",
    topic: "test topic",
    project: "demo",
    confidence: 0.9,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vir-review-json-"));
  vault = join(root, "vir");
  mkdirSync(vault, { recursive: true });
  db = new StateDb(join(root, "vir.db"));
  lockPath = join(root, "vir.lock");
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("resolveReviewTarget", () => {
  it("accepts a session note in a category dir", () => {
    write("patterns/test-topic-abc12345.md", note(SID));
    expect(resolveReviewTarget(vault, "patterns/test-topic-abc12345.md")).toEqual({
      absPath: join(vault, "patterns/test-topic-abc12345.md"),
      relPath: "patterns/test-topic-abc12345.md",
      sessionId: SID,
    });
  });

  it("accepts a filename with spaces and a leading dash", () => {
    write("gotchas/-odd name.md", note(SID));
    expect(resolveReviewTarget(vault, "gotchas/-odd name.md").relPath).toBe("gotchas/-odd name.md");
  });

  it("rejects paths outside the reviewable category dirs", () => {
    write("topics/t.md", note(SID));
    write("articles/a.md", note(SID));
    for (const bad of ["../x.md", "/etc/passwd", "topics/t.md", "articles/a.md", "patterns/x.txt", "patterns/sub/x.md", ".rejected/x.md"]) {
      expect(kindOf(() => resolveReviewTarget(vault, bad))).toBe("invalid_args");
    }
  });

  it("reports a missing note as not_found", () => {
    expect(kindOf(() => resolveReviewTarget(vault, "patterns/missing.md"))).toBe("not_found");
  });

  it("refuses a note without a session_id", () => {
    write("patterns/no-session.md", note(null));
    expect(kindOf(() => resolveReviewTarget(vault, "patterns/no-session.md"))).toBe("invalid_args");
  });
});

describe("resolveRejectedName", () => {
  it("accepts a name with or without .md", () => {
    write(".rejected/test-topic-abc12345.md", note(SID));
    expect(resolveRejectedName(vault, "test-topic-abc12345")).toBe("test-topic-abc12345.md");
    expect(resolveRejectedName(vault, "test-topic-abc12345.md")).toBe("test-topic-abc12345.md");
  });
  it("refuses anything with a directory part", () => {
    expect(kindOf(() => resolveRejectedName(vault, "../patterns/x.md"))).toBe("invalid_args");
  });
  it("reports a missing rejected note as not_found", () => {
    expect(kindOf(() => resolveRejectedName(vault, "nope"))).toBe("not_found");
  });
});

describe("runReviewAction", () => {
  const NOW = "2026-09-28T12:00:00.000Z";

  it("approve stamps verified, returns the path, releases the lock", () => {
    write("patterns/test-topic-abc12345.md", note(SID));
    const res = runReviewAction({ vaultRoot: vault, db, lockPath, now: NOW }, "approve", "patterns/test-topic-abc12345.md");
    expect(res).toEqual({ action: "approve", path: "patterns/test-topic-abc12345.md", sessionId: SID });
    const after = readFileSync(join(vault, "patterns/test-topic-abc12345.md"), "utf8");
    expect(after).toContain("verified: true");
    expect(after).toContain(`reviewed_at: ${NOW}`);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("approving twice keeps a single verified line", () => {
    write("patterns/test-topic-abc12345.md", note(SID));
    const deps = { vaultRoot: vault, db, lockPath, now: NOW };
    runReviewAction(deps, "approve", "patterns/test-topic-abc12345.md");
    runReviewAction(deps, "approve", "patterns/test-topic-abc12345.md");
    const after = readFileSync(join(vault, "patterns/test-topic-abc12345.md"), "utf8");
    expect(after.match(/^verified:/gm)).toHaveLength(1);
  });

  it("reject moves the note and stops the row serving immediately", () => {
    seedRow(SID);
    write("patterns/test-topic-abc12345.md", note(SID));
    const res = runReviewAction({ vaultRoot: vault, db, lockPath, now: NOW }, "reject", "patterns/test-topic-abc12345.md");
    expect(res).toEqual({ action: "reject", path: ".rejected/test-topic-abc12345.md", sessionId: SID });
    expect(existsSync(join(vault, "patterns/test-topic-abc12345.md"))).toBe(false);
    expect(db.listDistilled()).toHaveLength(0);
  });

  it("restore puts a human reject back unreviewed and serving", () => {
    seedRow(SID);
    write("patterns/test-topic-abc12345.md", note(SID));
    const deps = { vaultRoot: vault, db, lockPath, now: NOW };
    runReviewAction(deps, "reject", "patterns/test-topic-abc12345.md");
    const res = runReviewAction(deps, "restore", "test-topic-abc12345.md");
    expect(res).toEqual({ action: "restore", path: "patterns/test-topic-abc12345.md", sessionId: SID });
    const after = readFileSync(join(vault, "patterns/test-topic-abc12345.md"), "utf8");
    expect(after).not.toContain("verified:");
    expect(after).not.toContain("rejected_at:");
    expect(db.listDistilled()).toHaveLength(1);
  });

  it("restore refuses to overwrite a recreated note and leaves both files", () => {
    write(".rejected/test-topic-abc12345.md", note(SID, ["rejected_at: 2026-09-01T00:00:00.000Z"]));
    write("patterns/test-topic-abc12345.md", note(SID));
    expect(kindOf(() => runReviewAction({ vaultRoot: vault, db, lockPath }, "restore", "test-topic-abc12345.md"))).toMatch(/^other: .*already exists/);
    expect(existsSync(join(vault, ".rejected/test-topic-abc12345.md"))).toBe(true);
  });

  it("fails busy without touching the note when the lock is held", () => {
    write("patterns/test-topic-abc12345.md", note(SID));
    writeFileSync(lockPath, String(process.pid)); // a live pid holds it
    expect(kindOf(() => runReviewAction({ vaultRoot: vault, db, lockPath }, "approve", "patterns/test-topic-abc12345.md"))).toBe("busy");
    expect(readFileSync(join(vault, "patterns/test-topic-abc12345.md"), "utf8")).not.toContain("verified:");
  });

  it("reports a bad path as invalid_args even while the lock is held", () => {
    writeFileSync(lockPath, String(process.pid));
    expect(kindOf(() => runReviewAction({ vaultRoot: vault, db, lockPath }, "approve", "../x.md"))).toBe("invalid_args");
  });
});

describe("reviewQueue", () => {
  it("lists fresh flagged notes worst first with counts", () => {
    seedRow(SID);
    seedRow(SID2);
    write("patterns/a-abc12345.md", note(SID));
    write("gotchas/b-abc12345.md", note(SID2).replace("category: pattern", "category: gotcha"));
    const hash = contentHash("body");
    db.recordAudit(`/p/-home-u-app/${SID}.jsonl`, { verdict: "verify", reason: "polish", mergeInto: null, contentHash: hash });
    db.recordAudit(`/p/-home-u-app/${SID2}.jsonl`, { verdict: "reject", reason: "noise", mergeInto: null, contentHash: hash });
    const q = reviewQueue(vault, db);
    expect(q.items.map((i) => [i.path, i.verdict, i.reason])).toEqual([
      ["gotchas/b-abc12345.md", "reject", "noise"],
      ["patterns/a-abc12345.md", "verify", "polish"],
    ]);
    expect(q.counts).toEqual({ unaudited: 0, stale: 0 });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/cli/reviewJson.test.ts`
Expected: FAIL — cannot resolve `./reviewJson.js`.

- [ ] **Step 3: Implement** — create `src/cli/reviewJson.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildReviewQueue,
  type VirErrorKind,
  type VirReviewAction,
  type VirReviewActionResult,
  type VirReviewQueue,
} from "../output/json.js";
import { acquireLock, LOCK_PATH, LockHeldError, releaseLock } from "../pipeline/lock.js";
import { CATEGORY_DIR, REJECTED_DIR } from "../pipeline/writer.js";
import type { StateDb } from "../state/db.js";
import {
  approveNote,
  collectNotes,
  orderForAudit,
  parseFrontmatter,
  rejectNote,
  restoreRejected,
} from "./review.js";

// The non-interactive half of `vir review`, for the Obsidian plugin. Same
// actions as the terminal loop (approveNote/rejectNote/restoreRejected), so
// the two can never disagree about what approve means.

export class ReviewJsonError extends Error {
  constructor(
    public readonly kind: VirErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ReviewJsonError";
  }
}

const REVIEWABLE_DIRS = new Set<string>(Object.values(CATEGORY_DIR));

export interface ReviewTarget {
  absPath: string;
  relPath: string;
  sessionId: string;
}

// A target must be exactly <category-dir>/<name>.md under the vault root and a
// session note. The plugin sends paths it read from Obsidian, so anything else
// is a bug or a hand-crafted argument, never something to guess at.
export function resolveReviewTarget(vaultRoot: string, input: string): ReviewTarget {
  const root = resolve(vaultRoot);
  const abs = resolve(root, input);
  const rel = relative(root, abs);
  const parts = rel.split(sep);
  const dir = parts[0] ?? "";
  const name = parts[1] ?? "";
  if (isAbsolute(rel) || parts.length !== 2 || !REVIEWABLE_DIRS.has(dir) || !name.endsWith(".md")) {
    throw new ReviewJsonError(
      "invalid_args",
      `not a reviewable note: ${input} (expected <patterns|gotchas|decisions|tools>/<name>.md)`,
    );
  }
  const relPath = `${dir}/${name}`;
  if (!existsSync(abs)) throw new ReviewJsonError("not_found", `no note at ${relPath}`);
  const sessionId = parseFrontmatter(readFileSync(abs, "utf8")).session_id ?? "";
  if (sessionId.length === 0) {
    throw new ReviewJsonError("invalid_args", `${relPath} has no session_id; only session notes are reviewable`);
  }
  return { absPath: abs, relPath, sessionId };
}

export function resolveRejectedName(vaultRoot: string, input: string): string {
  const file = input.endsWith(".md") ? input : `${input}.md`;
  if (file !== basename(file) || file.includes("\\")) {
    throw new ReviewJsonError("invalid_args", `not a file name in ${REJECTED_DIR}/: ${input}`);
  }
  if (!existsSync(join(vaultRoot, REJECTED_DIR, file))) {
    throw new ReviewJsonError("not_found", `no rejected note named ${file} in ${REJECTED_DIR}/`);
  }
  return file;
}

export interface ReviewActionDeps {
  vaultRoot: string;
  db: StateDb;
  lockPath?: string;
  now?: string;
}

// Paths are validated before the lock so a bad argument reports invalid_args,
// not busy. The file is re-checked inside the lock: a run may have moved it.
export function runReviewAction(
  deps: ReviewActionDeps,
  action: VirReviewAction,
  target: string,
): VirReviewActionResult {
  const lockPath = deps.lockPath ?? LOCK_PATH;
  if (action === "restore") {
    const name = resolveRejectedName(deps.vaultRoot, target);
    return withLock(lockPath, () => {
      const dest = restoreRejected(deps.db, deps.vaultRoot, name, deps.now);
      const sessionId = parseFrontmatter(readFileSync(dest, "utf8")).session_id ?? "";
      return { action, path: toWirePath(deps.vaultRoot, dest), sessionId };
    });
  }
  const t = resolveReviewTarget(deps.vaultRoot, target);
  return withLock(lockPath, () => {
    if (!existsSync(t.absPath)) throw new ReviewJsonError("not_found", `no note at ${t.relPath}`);
    if (action === "approve") {
      approveNote(t.absPath, deps.now);
      return { action, path: t.relPath, sessionId: t.sessionId };
    }
    const dest = rejectNote(t.absPath, deps.vaultRoot, deps.now);
    // Stop serving now, not at the next `vir run`'s syncRejections.
    deps.db.markRejected(t.sessionId, deps.now);
    return { action, path: toWirePath(deps.vaultRoot, dest), sessionId: t.sessionId };
  });
}

export function reviewQueue(vaultRoot: string, db: StateDb, project?: string): VirReviewQueue {
  const unverified = collectNotes(vaultRoot, { project });
  const audits = db.listAudits();
  return buildReviewQueue(
    orderForAudit(unverified, audits),
    unverified,
    audits,
    collectNotes(vaultRoot, { all: true }),
  );
}

function withLock<T>(lockPath: string, fn: () => T): T {
  try {
    acquireLock(lockPath);
  } catch (err) {
    if (err instanceof LockHeldError) throw new ReviewJsonError("busy", err.message);
    throw err;
  }
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

function toWirePath(vaultRoot: string, abs: string): string {
  return relative(resolve(vaultRoot), abs).split(sep).join("/");
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/cli/reviewJson.test.ts && npm run typecheck`
Expected: PASS; typecheck clean. If the "approving twice" test fails, check `setFrontmatter` replaces in place (it should; `review.ts:66`).

- [ ] **Step 5: Commit**

```bash
git add src/cli/reviewJson.ts src/cli/reviewJson.test.ts
git commit -m "feat(review): path-guarded, locked review actions and JSON queue"
```

### Task 3: CLI wiring, docs, version 0.23.0

**Files:**
- Modify: `src/cli/reviewJson.ts` (append `runReviewJson`)
- Modify: `src/cli.ts:1776-1785` (the `review` command)
- Modify: `CHANGELOG.md`, `site/src/content/docs/docs/changelog.md`, `site/src/content/docs/docs/commands.md:31-35`, `site/src/content/docs/docs/obsidian-plugin.md` ("How it talks to vir" section), `package.json` / `package-lock.json` (version)

**Interfaces:**
- Consumes: Task 2's `runReviewAction`, `reviewQueue`, `ReviewJsonError`; `errorPayload` from `../output/json.js`; `loadConfig` from `../config.js`; `StateDb`.
- Produces: `export interface ReviewJsonOptions { audited?: boolean; project?: string; approve?: string; reject?: string; restore?: string }` and `export function runReviewJson(opts: ReviewJsonOptions): void`; CLI flags `--approve <path>`, `--reject <path>`, `--json` on `vir review`.

- [ ] **Step 1: Append `runReviewJson`** to `src/cli/reviewJson.ts` (add `errorPayload` to the `../output/json.js` import, and `import { loadConfig } from "../config.js";` and `import { StateDb } from "../state/db.js";` — change the existing `import type { StateDb }` to a value import):

```ts
export interface ReviewJsonOptions {
  audited?: boolean;
  project?: string;
  approve?: string;
  reject?: string;
  restore?: string;
}

// Same I/O contract as `vir query --json`: one JSON value on stdout and exit 0,
// or an empty stdout, a one-line VirErrorPayload on stderr and exit 1.
export function runReviewJson(opts: ReviewJsonOptions): void {
  const actions: Array<[VirReviewAction, string]> = [];
  if (opts.approve !== undefined) actions.push(["approve", opts.approve]);
  if (opts.reject !== undefined) actions.push(["reject", opts.reject]);
  if (opts.restore !== undefined) actions.push(["restore", opts.restore]);
  if (actions.length + (opts.audited ? 1 : 0) !== 1) {
    fail("invalid_args", "--json needs exactly one of --audited, --approve, --reject, --restore");
    return;
  }

  let vaultRoot: string;
  try {
    const cfg = loadConfig();
    vaultRoot = join(cfg.vaultPath, cfg.outputDir);
  } catch (err) {
    fail("no_vault", (err as Error).message);
    return;
  }
  if (!existsSync(vaultRoot)) {
    fail("no_vault", `vault not found: ${vaultRoot}`);
    return;
  }

  const db = new StateDb();
  try {
    const action = actions[0];
    const out =
      action === undefined
        ? reviewQueue(vaultRoot, db, opts.project)
        : runReviewAction({ vaultRoot, db }, action[0], action[1]);
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch (err) {
    fail(err instanceof ReviewJsonError ? err.kind : "internal", (err as Error).message);
  } finally {
    db.close();
  }
}

function fail(kind: VirErrorKind, message: string): void {
  process.stderr.write(JSON.stringify(errorPayload(kind, message)) + "\n");
  process.exitCode = 1;
}
```

- [ ] **Step 2: Wire the command** — replace the `review` command block in `src/cli.ts` with:

```ts
program
  .command("review")
  .description("Walk through new distilled notes and approve/edit/reject")
  .option("--all", "Review all notes, including verified ones")
  .option("--project <slug>", "Filter by project")
  .option("--limit <n>", "Max notes to review in this session", "50")
  .option("--restore <note>", "Move one rejected note back out of .rejected/")
  .option("--audited", "Walk notes vir audit flagged, worst first")
  .option("--approve <path>", "Approve one note (needs --json)")
  .option("--reject <path>", "Reject one note into .rejected/ (needs --json)")
  .option("--json", "Non-interactive: print the --audited queue or one action's result as JSON")
  .action(
    runAction(async (opts: ReviewCliOptions & ReviewJsonOptions & { json?: boolean }) => {
      if (opts.json) {
        runReviewJson(opts);
        return;
      }
      if (opts.approve !== undefined || opts.reject !== undefined) {
        throw new Error("--approve and --reject need --json (the terminal loop asks per note)");
      }
      await runReview(opts);
    }),
  );
```

Add `import { runReviewJson, type ReviewJsonOptions } from "./cli/reviewJson.js";` next to the existing review import, and make sure `ReviewCliOptions` is imported from `./cli/review.js` (it is exported there).

- [ ] **Step 3: Build and smoke-test against the real vault (read-only paths only)**

```bash
npm run build
node dist/cli.js review --audited --json | head -c 600; echo
node dist/cli.js review --json; echo "exit=$?"
node dist/cli.js review --approve=../x.md --json; echo "exit=$?"
node dist/cli.js review --approve=patterns/x.md; echo "exit=$?"
```

Expected: 1) a JSON object starting `{"items":[{"path":"...","sessionId":...` ; 2) stderr `{"error":"--json needs exactly one of ...","kind":"invalid_args"}`, `exit=1`; 3) stderr `..."kind":"invalid_args"}`, `exit=1`; 4) the red "need --json" message, `exit=1`. Do NOT run approve/reject/restore against the real vault.

- [ ] **Step 4: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Docs and version**

- `CHANGELOG.md`: new top entry `## 0.23.0 — <date>` titled **`vir review --json`: review from the Obsidian plugin.** Bullets: queue mode (`--audited --json`, shape, counts); actions (`--approve/--reject/--restore` with `--json`, one-token `--flag=<path>` form); reject stops serving immediately (`markRejected`); path guard (category dirs only, session notes only); the three actions take the pipeline lock and fail `busy` instead of racing a run; two new error kinds `busy`, `not_found`; the interactive loop is unchanged.
- Mirror the entry into `site/src/content/docs/docs/changelog.md`.
- `site/src/content/docs/docs/commands.md`: add a row after line 35: `| \`vir review --json\` | free | Non-interactive review for the Obsidian plugin: \`--audited\` lists the queue; \`--approve\`, \`--reject\`, \`--restore\` act on one note |`.
- `site/src/content/docs/docs/obsidian-plugin.md`: replace the "Two stable JSON contracts" paragraph with: three contracts (`query --json`, `doctor --json`, `review --json`), and that Review needs vir 0.23.0+.
- `npm version 0.23.0 --no-git-tag-version`, then `npm run build && node dist/cli.js --version` → `0.23.0`.

- [ ] **Step 6: Commit and push**

```bash
git add -A
git commit -m "feat(review): vir review --json for the Obsidian plugin, 0.23.0"
git push -u origin HEAD
```

Open a PR (`gh pr create --base main`), title `0.23.0: vir review --json (review queue for the Obsidian plugin)`. Do not publish to npm.

---

## Part B — Plugin (repo: `~/projects/vir-obsidian`)

Before Task 4: `cd ~/projects/vir-obsidian && git checkout main && git pull && git checkout -b feat/0.3.0-review-queue`. Tests: `npx vitest run`; build: `npm run build`.

### Task 4: Wire types and client methods

**Files:**
- Modify: `src/types.ts` (append), `src/vir-client.ts` (`VirCLIError`, `run()` close handler, two new methods)
- Create: `tests/fixtures/fake-vir-review.mjs`
- Test: `tests/vir-client.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type VirReviewVerdict = "reject" | "merge" | "verify";
  export interface VirReviewMergeTarget { sessionId: string; path: string | null; title: string | null }
  export interface VirReviewItem { path: string; sessionId: string; title: string; category: VirCategory; project: string | null; date: string; confidence: number; verdict: VirReviewVerdict; reason: string; mergeInto: VirReviewMergeTarget | null; auditedAt: string }
  export interface VirReviewQueue { items: VirReviewItem[]; counts: { unaudited: number; stale: number } }
  export type VirReviewAction = "approve" | "reject" | "restore";
  export interface VirReviewActionResult { action: VirReviewAction; path: string; sessionId: string }
  // vir-client.ts
  class VirCLIError { constructor(message: string, stderr: string, exitCode: number, kind?: string); readonly kind?: string }
  VirClient.reviewQueue(): Promise<VirReviewQueue>
  VirClient.review(action: VirReviewAction, target: string): Promise<VirReviewActionResult>
  ```

- [ ] **Step 1: Create the fixture** `tests/fixtures/fake-vir-review.mjs` (then `chmod +x` it):

```js
#!/usr/bin/env node
const args = process.argv.slice(2);
const fail = (kind, error) => {
	process.stderr.write(JSON.stringify({ error, kind }) + "\n");
	process.exit(1);
};
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

if (args.includes("--audited")) {
	process.stdout.write(
		JSON.stringify({
			items: [
				{ path: "gotchas/b.md", sessionId: "b", title: "B", category: "gotcha", project: null, date: "2026-09-01", confidence: 0.6, verdict: "reject", reason: "noise", mergeInto: null, auditedAt: "2026-09-26" },
			],
			counts: { unaudited: 3, stale: 1 },
		}),
	);
	process.exit(0);
}
for (const action of ["approve", "reject", "restore"]) {
	const target = flag(action);
	if (target === undefined) continue;
	if (target.includes("BUSY")) fail("busy", "another vir process (pid 1) is already running the pipeline");
	if (target.includes("GONE")) fail("not_found", `no note at ${target}`);
	const path = action === "reject" ? `.rejected/${target.split("/").pop()}` : target;
	process.stdout.write(JSON.stringify({ action, path, sessionId: "sid" }));
	process.exit(0);
}
fail("invalid_args", `unexpected argv: ${JSON.stringify(args)}`);
```

- [ ] **Step 2: Write the failing tests** — append inside the existing `describe("VirClient", ...)` in `tests/vir-client.test.ts`:

```ts
	it("reviewQueue parses the queue", async () => {
		const q = await new VirClient(fx("fake-vir-review.mjs")).reviewQueue();
		expect(q.items[0]?.verdict).toBe("reject");
		expect(q.counts).toEqual({ unaudited: 3, stale: 1 });
	});

	it("review passes the target as one --action=<path> token, leading dash and spaces intact", async () => {
		const res = await new VirClient(fx("fake-vir-review.mjs")).review("approve", "patterns/-odd name.md");
		expect(res).toEqual({ action: "approve", path: "patterns/-odd name.md", sessionId: "sid" });
	});

	it("review surfaces the error kind on VirCLIError", async () => {
		const err = await new VirClient(fx("fake-vir-review.mjs"))
			.review("reject", "patterns/BUSY.md")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(VirCLIError);
		expect((err as VirCLIError).kind).toBe("busy");
	});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/vir-client.test.ts`
Expected: FAIL — `reviewQueue` / `review` do not exist.

- [ ] **Step 4: Implement**

Append to `src/types.ts`:
```ts
export type VirReviewVerdict = "reject" | "merge" | "verify";

export interface VirReviewMergeTarget {
	sessionId: string;
	path: string | null;
	title: string | null;
}

/** One `vir review --audited --json` row (vir-cli ≥ 0.23.0). */
export interface VirReviewItem {
	path: string;
	sessionId: string;
	title: string;
	category: VirCategory;
	project: string | null;
	date: string;
	confidence: number;
	verdict: VirReviewVerdict;
	reason: string;
	mergeInto: VirReviewMergeTarget | null;
	auditedAt: string;
}

export interface VirReviewQueue {
	items: VirReviewItem[];
	counts: { unaudited: number; stale: number };
}

export type VirReviewAction = "approve" | "reject" | "restore";

export interface VirReviewActionResult {
	action: VirReviewAction;
	/** Where the note is now; `.rejected/<name>` after a reject. */
	path: string;
	sessionId: string;
}
```

In `src/vir-client.ts`, change `VirCLIError`:
```ts
export class VirCLIError extends Error {
	constructor(
		message: string,
		public stderr: string,
		public exitCode: number,
		/** VirErrorPayload.kind when vir sent one (e.g. "busy", "not_found"). */
		public readonly kind?: string,
	) {
		super(message);
		this.name = "VirCLIError";
	}
}
```
In `run()`'s `close` handler, pass the kind: `rejectPromise(new VirCLIError(message, stderr, code ?? -1, payload?.kind));`.
Extend the type import to include `VirReviewAction, VirReviewActionResult, VirReviewQueue`, and add after `doctor()`:
```ts
	async reviewQueue(): Promise<VirReviewQueue> {
		const out = await this.run(["review", "--audited", "--json"], this.queryTimeoutMs);
		return this.parse<VirReviewQueue>(out);
	}

	// `--approve=<path>` is one argv token, so a note named `-x.md` can never
	// be read as a flag by vir's option parser.
	async review(action: VirReviewAction, target: string): Promise<VirReviewActionResult> {
		const out = await this.run(["review", `--${action}=${target}`, "--json"], this.queryTimeoutMs);
		return this.parse<VirReviewActionResult>(out);
	}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run && npm run build`
Expected: all tests PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/vir-client.ts tests/vir-client.test.ts tests/fixtures/fake-vir-review.mjs
git commit -m "feat(review): VirClient.reviewQueue/review and error kind on VirCLIError"
```

### Task 5: Pure queue helpers

**Files:**
- Create: `src/lib/review-queue.ts`
- Test: `tests/review-queue.test.ts`

**Interfaces:**
- Consumes: `VirReviewItem` (Task 4).
- Produces:
  ```ts
  export const REVIEW_MIN_CLI = "0.23.0";
  export function isAtLeast(version: string, min: string): boolean
  export function isReviewablePath(path: string): boolean
  export function rejectedName(path: string): string
  export function findItem(items: VirReviewItem[], path: string): VirReviewItem | undefined
  export function removeItem(items: VirReviewItem[], path: string): { items: VirReviewItem[]; removed: VirReviewItem | null; index: number }
  export function insertItem(items: VirReviewItem[], item: VirReviewItem, index: number): VirReviewItem[]
  export function nextItem(items: VirReviewItem[], index: number): VirReviewItem | undefined
  ```

- [ ] **Step 1: Write the failing tests** — `tests/review-queue.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { VirReviewItem } from "../src/types";
import {
	findItem,
	insertItem,
	isAtLeast,
	isReviewablePath,
	nextItem,
	rejectedName,
	removeItem,
} from "../src/lib/review-queue";

const item = (path: string): VirReviewItem => ({
	path,
	sessionId: path,
	title: path,
	category: "pattern",
	project: null,
	date: "2026-09-01",
	confidence: 0.9,
	verdict: "verify",
	reason: "r",
	mergeInto: null,
	auditedAt: "2026-09-26",
});
const q = [item("patterns/a.md"), item("patterns/b.md"), item("patterns/c.md")];

describe("isAtLeast", () => {
	it("compares numerically, not lexically", () => {
		expect(isAtLeast("0.23.0", "0.23.0")).toBe(true);
		expect(isAtLeast("0.100.0", "0.23.0")).toBe(true);
		expect(isAtLeast("0.22.1", "0.23.0")).toBe(false);
		expect(isAtLeast("1.0.0", "0.23.0")).toBe(true);
	});
	it("ignores a prerelease suffix and treats garbage as too old", () => {
		expect(isAtLeast("0.23.0-rc.1", "0.23.0")).toBe(true);
		expect(isAtLeast("unknown", "0.23.0")).toBe(false);
	});
});

describe("isReviewablePath", () => {
	it("accepts <category-dir>/<name>.md", () => {
		for (const p of ["patterns/a.md", "gotchas/a b.md", "decisions/-x.md", "tools/t.md"]) {
			expect(isReviewablePath(p)).toBe(true);
		}
	});
	it("rejects source notes, archived notes, nesting and a vault opened above the output dir", () => {
		for (const p of ["topics/t.md", "articles/a.md", "archived/a.md", "patterns/sub/a.md", "vir/patterns/x.md", "patterns/a.txt"]) {
			expect(isReviewablePath(p)).toBe(false);
		}
	});
});

describe("rejectedName", () => {
	it("returns the file name of a .rejected/ path", () => {
		expect(rejectedName(".rejected/a-abc.md")).toBe("a-abc.md");
	});
});

describe("queue edits", () => {
	it("finds by path", () => {
		expect(findItem(q, "patterns/b.md")?.path).toBe("patterns/b.md");
		expect(findItem(q, "patterns/z.md")).toBeUndefined();
	});
	it("removes and reports the index without mutating the input", () => {
		const r = removeItem(q, "patterns/b.md");
		expect(r.items.map((i) => i.path)).toEqual(["patterns/a.md", "patterns/c.md"]);
		expect(r.removed?.path).toBe("patterns/b.md");
		expect(r.index).toBe(1);
		expect(q).toHaveLength(3);
	});
	it("reports index -1 for a path not in the queue", () => {
		const r = removeItem(q, "patterns/z.md");
		expect(r).toEqual({ items: q, removed: null, index: -1 });
	});
	it("inserts at a clamped index and never duplicates", () => {
		const two = [item("patterns/a.md"), item("patterns/c.md")];
		expect(insertItem(two, item("patterns/b.md"), 1).map((i) => i.path)).toEqual(["patterns/a.md", "patterns/b.md", "patterns/c.md"]);
		expect(insertItem(two, item("patterns/b.md"), 99).map((i) => i.path)).toEqual(["patterns/a.md", "patterns/c.md", "patterns/b.md"]);
		expect(insertItem(two, item("patterns/a.md"), 1)).toHaveLength(2);
	});
	it("next is the item now at the removed index, wrapping to the first", () => {
		const after = [item("patterns/a.md"), item("patterns/c.md")];
		expect(nextItem(after, 1)?.path).toBe("patterns/c.md");
		expect(nextItem(after, 2)?.path).toBe("patterns/a.md");
		expect(nextItem([], 0)).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/review-queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/lib/review-queue.ts`:

```ts
import type { VirReviewItem } from "../types";

export const REVIEW_MIN_CLI = "0.23.0";

// The CLI's reviewable dirs (vir-cli CATEGORY_DIR). Topics, articles and pdfs
// carry no session and are never reviewed; archived/ holds dedupe losers.
const REVIEWABLE_DIRS = new Set(["patterns", "gotchas", "decisions", "tools"]);

export function isAtLeast(version: string, min: string): boolean {
	const parse = (v: string): number[] | null => {
		const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
		return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
	};
	const a = parse(version);
	const b = parse(min);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	}
	return true;
}

export function isReviewablePath(path: string): boolean {
	const parts = path.split("/");
	return parts.length === 2 && REVIEWABLE_DIRS.has(parts[0] ?? "") && (parts[1] ?? "").endsWith(".md");
}

export function rejectedName(path: string): string {
	return path.split("/").pop() ?? path;
}

export function findItem(items: VirReviewItem[], path: string): VirReviewItem | undefined {
	return items.find((i) => i.path === path);
}

export function removeItem(
	items: VirReviewItem[],
	path: string,
): { items: VirReviewItem[]; removed: VirReviewItem | null; index: number } {
	const index = items.findIndex((i) => i.path === path);
	if (index < 0) return { items, removed: null, index: -1 };
	return {
		items: [...items.slice(0, index), ...items.slice(index + 1)],
		removed: items[index] ?? null,
		index,
	};
}

export function insertItem(items: VirReviewItem[], item: VirReviewItem, index: number): VirReviewItem[] {
	if (items.some((i) => i.path === item.path)) return items;
	const at = Math.max(0, Math.min(index, items.length));
	return [...items.slice(0, at), item, ...items.slice(at)];
}

// After removing the item at `index`, the next one to review is whatever now
// sits there; past the end, start again from the top of the queue.
export function nextItem(items: VirReviewItem[], index: number): VirReviewItem | undefined {
	return items[index] ?? items[0];
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/review-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/review-queue.ts tests/review-queue.test.ts
git commit -m "feat(review): pure queue helpers (version gate, reviewable paths, edits)"
```

### Task 6: ReviewStore

**Files:**
- Create: `src/review-store.ts`
- Test: `tests/review-store.test.ts`

**Interfaces:**
- Consumes: Task 4 types and `VirCLIError`, `VirNotFoundError`, `VirTimeoutError`; Task 5 helpers.
- Produces:
  ```ts
  export interface ReviewClient { reviewQueue(): Promise<VirReviewQueue>; review(action: VirReviewAction, target: string): Promise<VirReviewActionResult> }
  export interface ReviewSnapshot { items: VirReviewItem[]; counts: { unaudited: number; stale: number }; fetchedAt: number | null; inFlight: boolean; error: string | null; notConfigured: boolean }
  export type FailureReason = "busy" | "not_found" | "timeout" | "not_configured" | "in_flight" | "error";
  export type ActionOutcome =
    | { ok: true; removed: VirReviewItem | null; index: number; result: VirReviewActionResult }
    | { ok: false; reason: FailureReason; message: string };
  export const BUSY_MESSAGE: string; export const TIMEOUT_MESSAGE: string;
  export class ReviewStore {
    constructor(getClient: () => ReviewClient, now?: () => number)
    get snapshot(): ReviewSnapshot
    onChange(fn: () => void): () => void
    refresh(): Promise<void>
    act(action: "approve" | "reject", path: string): Promise<ActionOutcome>
    undoReject(item: VirReviewItem | null, index: number, rejectedPath: string): Promise<ActionOutcome>
  }
  ```

- [ ] **Step 1: Write the failing tests** — `tests/review-store.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ReviewStore, BUSY_MESSAGE, TIMEOUT_MESSAGE, type ReviewClient } from "../src/review-store";
import { VirCLIError, VirNotFoundError, VirTimeoutError } from "../src/vir-client";
import type { VirReviewItem, VirReviewQueue } from "../src/types";

const item = (path: string): VirReviewItem => ({
	path,
	sessionId: path,
	title: path,
	category: "pattern",
	project: null,
	date: "2026-09-01",
	confidence: 0.9,
	verdict: "verify",
	reason: "r",
	mergeInto: null,
	auditedAt: "2026-09-26",
});
const queue = (...paths: string[]): VirReviewQueue => ({
	items: paths.map(item),
	counts: { unaudited: 2, stale: 1 },
});

function stub(q: VirReviewQueue) {
	const client = {
		reviewQueue: vi.fn(async () => q),
		review: vi.fn(async (action: "approve" | "reject" | "restore", target: string) => ({
			action,
			path: action === "reject" ? `.rejected/${target.split("/").pop()}` : target,
			sessionId: "sid",
		})),
	} satisfies ReviewClient;
	const store = new ReviewStore(() => client, () => 1_000);
	return { client, store };
}

describe("ReviewStore", () => {
	it("refresh loads items, counts and fetch time, and notifies", async () => {
		const { store } = stub(queue("patterns/a.md"));
		const seen = vi.fn();
		store.onChange(seen);
		await store.refresh();
		expect(store.snapshot).toMatchObject({ counts: { unaudited: 2, stale: 1 }, fetchedAt: 1_000, error: null });
		expect(store.snapshot.items).toHaveLength(1);
		expect(seen).toHaveBeenCalled();
	});

	it("refresh records a missing CLI separately from other errors", async () => {
		const { client, store } = stub(queue());
		client.reviewQueue.mockRejectedValueOnce(new VirNotFoundError());
		await store.refresh();
		expect(store.snapshot.notConfigured).toBe(true);
		client.reviewQueue.mockRejectedValueOnce(new Error("boom"));
		await store.refresh();
		expect(store.snapshot).toMatchObject({ notConfigured: false, error: "boom" });
	});

	it("concurrent refreshes share one fetch", async () => {
		const { client, store } = stub(queue("patterns/a.md"));
		await Promise.all([store.refresh(), store.refresh()]);
		expect(client.reviewQueue).toHaveBeenCalledTimes(1);
	});

	it("approve removes the item and reports where it was", async () => {
		const { client, store } = stub(queue("patterns/a.md", "patterns/b.md"));
		await store.refresh();
		const out = await store.act("approve", "patterns/a.md");
		expect(client.review).toHaveBeenCalledWith("approve", "patterns/a.md");
		expect(out).toMatchObject({ ok: true, index: 0, removed: { path: "patterns/a.md" } });
		expect(store.snapshot.items.map((i) => i.path)).toEqual(["patterns/b.md"]);
		expect(store.snapshot.inFlight).toBe(false);
	});

	it("rejecting the last item leaves an empty queue", async () => {
		const { store } = stub(queue("patterns/a.md"));
		await store.refresh();
		const out = await store.act("reject", "patterns/a.md");
		expect(out.ok).toBe(true);
		expect(store.snapshot.items).toEqual([]);
	});

	it("acting on a note that is not in the queue still succeeds (index -1)", async () => {
		const { store } = stub(queue("patterns/a.md"));
		await store.refresh();
		expect(await store.act("approve", "patterns/unflagged.md")).toMatchObject({ ok: true, index: -1, removed: null });
		expect(store.snapshot.items).toHaveLength(1);
	});

	it("busy leaves the queue untouched", async () => {
		const { client, store } = stub(queue("patterns/a.md"));
		await store.refresh();
		client.review.mockRejectedValueOnce(new VirCLIError("held", "", 1, "busy"));
		expect(await store.act("reject", "patterns/a.md")).toEqual({ ok: false, reason: "busy", message: BUSY_MESSAGE });
		expect(store.snapshot.items).toHaveLength(1);
	});

	it("not_found drops the item and refetches", async () => {
		const { client, store } = stub(queue("patterns/a.md", "patterns/b.md"));
		await store.refresh();
		client.reviewQueue.mockResolvedValueOnce(queue("patterns/b.md"));
		client.review.mockRejectedValueOnce(new VirCLIError("no note at patterns/a.md", "", 1, "not_found"));
		const out = await store.act("approve", "patterns/a.md");
		expect(out).toEqual({ ok: false, reason: "not_found", message: "no note at patterns/a.md" });
		expect(client.reviewQueue).toHaveBeenCalledTimes(2);
		expect(store.snapshot.items.map((i) => i.path)).toEqual(["patterns/b.md"]);
	});

	it("a timeout refetches instead of guessing", async () => {
		const { client, store } = stub(queue("patterns/a.md"));
		await store.refresh();
		client.review.mockRejectedValueOnce(new VirTimeoutError());
		expect(await store.act("approve", "patterns/a.md")).toEqual({ ok: false, reason: "timeout", message: TIMEOUT_MESSAGE });
		expect(client.reviewQueue).toHaveBeenCalledTimes(2);
	});

	it("refuses a second action while one is in flight", async () => {
		const { client, store } = stub(queue("patterns/a.md", "patterns/b.md"));
		await store.refresh();
		let release!: () => void;
		client.review.mockImplementationOnce(
			() => new Promise((r) => (release = () => r({ action: "approve", path: "patterns/a.md", sessionId: "sid" }))),
		);
		const first = store.act("approve", "patterns/a.md");
		expect(store.snapshot.inFlight).toBe(true);
		expect(await store.act("approve", "patterns/b.md")).toMatchObject({ ok: false, reason: "in_flight" });
		release();
		expect((await first).ok).toBe(true);
	});

	it("undo restores by file name, re-inserts at the old index and refetches", async () => {
		const { client, store } = stub(queue("patterns/a.md", "patterns/b.md"));
		await store.refresh();
		const out = await store.act("reject", "patterns/a.md");
		if (!out.ok) throw new Error("reject failed");
		client.reviewQueue.mockResolvedValueOnce(queue("patterns/a.md", "patterns/b.md"));
		const undo = await store.undoReject(out.removed, out.index, out.result.path);
		expect(client.review).toHaveBeenLastCalledWith("restore", "a.md");
		expect(undo.ok).toBe(true);
		expect(store.snapshot.items.map((i) => i.path)).toEqual(["patterns/a.md", "patterns/b.md"]);
	});

	it("a refused undo leaves the queue as it was and returns the CLI message", async () => {
		const { client, store } = stub(queue("patterns/a.md", "patterns/b.md"));
		await store.refresh();
		const out = await store.act("reject", "patterns/a.md");
		if (!out.ok) throw new Error("reject failed");
		client.review.mockRejectedValueOnce(new VirCLIError("patterns/a.md already exists — not overwriting it", "", 1, "internal"));
		const undo = await store.undoReject(out.removed, out.index, out.result.path);
		expect(undo).toEqual({ ok: false, reason: "error", message: "patterns/a.md already exists — not overwriting it" });
		expect(store.snapshot.items.map((i) => i.path)).toEqual(["patterns/b.md"]);
	});
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/review-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/review-store.ts`:

```ts
import type {
	VirReviewAction,
	VirReviewActionResult,
	VirReviewItem,
	VirReviewQueue,
} from "./types";
import { VirCLIError, VirNotFoundError, VirTimeoutError } from "./vir-client";
import { insertItem, rejectedName, removeItem } from "./lib/review-queue";

// No Obsidian imports: this runs under vitest in Node. Views subscribe with
// onChange and must unsubscribe (they pass the returned function to register()).

export interface ReviewClient {
	reviewQueue(): Promise<VirReviewQueue>;
	review(action: VirReviewAction, target: string): Promise<VirReviewActionResult>;
}

export interface ReviewSnapshot {
	items: VirReviewItem[];
	counts: { unaudited: number; stale: number };
	fetchedAt: number | null;
	inFlight: boolean;
	error: string | null;
	notConfigured: boolean;
}

export type FailureReason = "busy" | "not_found" | "timeout" | "not_configured" | "in_flight" | "error";

export type ActionOutcome =
	| { ok: true; removed: VirReviewItem | null; index: number; result: VirReviewActionResult }
	| { ok: false; reason: FailureReason; message: string };

export const BUSY_MESSAGE = "vir is busy (a run is in progress). Try again in a moment.";
export const TIMEOUT_MESSAGE = "Couldn't confirm; queue refreshed";

export class ReviewStore {
	private items: VirReviewItem[] = [];
	private counts = { unaudited: 0, stale: 0 };
	private fetchedAt: number | null = null;
	private inFlight = false;
	private error: string | null = null;
	private notConfigured = false;
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly getClient: () => ReviewClient,
		private readonly now: () => number = Date.now,
	) {}

	get snapshot(): ReviewSnapshot {
		return {
			items: this.items,
			counts: this.counts,
			fetchedAt: this.fetchedAt,
			inFlight: this.inFlight,
			error: this.error,
			notConfigured: this.notConfigured,
		};
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	// The tab and the card can both ask for the first fetch; share one spawn.
	private pendingRefresh: Promise<void> | null = null;

	refresh(): Promise<void> {
		this.pendingRefresh ??= this.fetchQueue().finally(() => {
			this.pendingRefresh = null;
		});
		return this.pendingRefresh;
	}

	private async fetchQueue(): Promise<void> {
		try {
			const q = await this.getClient().reviewQueue();
			this.items = q.items;
			this.counts = q.counts;
			this.fetchedAt = this.now();
			this.error = null;
			this.notConfigured = false;
		} catch (err) {
			this.notConfigured = err instanceof VirNotFoundError;
			this.error = this.notConfigured ? null : errorMessage(err);
		}
		this.emit();
	}

	async act(action: "approve" | "reject", path: string): Promise<ActionOutcome> {
		return this.guarded(async () => {
			const result = await this.getClient().review(action, path);
			const r = removeItem(this.items, path);
			this.items = r.items;
			return { ok: true, removed: r.removed, index: r.index, result };
		}, path);
	}

	async undoReject(item: VirReviewItem | null, index: number, rejectedPath: string): Promise<ActionOutcome> {
		return this.guarded(async () => {
			const result = await this.getClient().review("restore", rejectedName(rejectedPath));
			if (item) this.items = insertItem(this.items, item, index);
			await this.refresh();
			return { ok: true, removed: null, index, result };
		}, null);
	}

	// One action at a time; every failure maps to a reason the UI can phrase.
	// When the outcome is unknown (timeout) or the queue is wrong (not_found),
	// refetch: the CLI is the source of truth, never a local guess.
	private async guarded(fn: () => Promise<ActionOutcome>, path: string | null): Promise<ActionOutcome> {
		if (this.inFlight) return { ok: false, reason: "in_flight", message: "" };
		this.inFlight = true;
		this.emit();
		try {
			return await fn();
		} catch (err) {
			if (err instanceof VirTimeoutError) {
				await this.refresh();
				return { ok: false, reason: "timeout", message: TIMEOUT_MESSAGE };
			}
			if (err instanceof VirNotFoundError) {
				return { ok: false, reason: "not_configured", message: "Vir CLI not configured." };
			}
			if (err instanceof VirCLIError && err.kind === "busy") {
				return { ok: false, reason: "busy", message: BUSY_MESSAGE };
			}
			if (err instanceof VirCLIError && err.kind === "not_found") {
				if (path !== null) this.items = removeItem(this.items, path).items;
				await this.refresh();
				return { ok: false, reason: "not_found", message: err.message };
			}
			return { ok: false, reason: "error", message: errorMessage(err) };
		} finally {
			this.inFlight = false;
			this.emit();
		}
	}

	private emit(): void {
		for (const fn of this.listeners) fn();
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run && npm run build`
Expected: all PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/review-store.ts tests/review-store.test.ts
git commit -m "feat(review): ReviewStore — queue state, single in-flight action, failure mapping"
```

### Task 7: Controller, commands, version gate

**Files:**
- Create: `src/review-controller.ts`
- Modify: `src/main.ts` (fields, `onload`, a `cliVersion` setter used by the status bar), `src/status-bar.ts` (`poll()` records the version)

**Interfaces:**
- Consumes: `ReviewStore`, `ActionOutcome` (Task 6); `isAtLeast`, `isReviewablePath`, `nextItem`, `REVIEW_MIN_CLI` (Task 5).
- Produces (used by Task 8):
  ```ts
  // main.ts (VirPlugin)
  reviewStore: ReviewStore
  review: ReviewController
  cliVersion: string | null
  ensureReviewSupport(): Promise<"supported" | "unsupported" | "unknown">
  // review-controller.ts
  export class ReviewController {
    constructor(app: App, store: ReviewStore)
    isReviewable(file: TFile | null): file is TFile
    approve(file: TFile): Promise<void>
    reject(file: TFile): Promise<void>
    openNext(): Promise<void>
    openPath(path: string): Promise<void>
  }
  ```

No vitest here (Obsidian APIs); logic lives in Tasks 5-6. Verified by build now and manually in Task 9.

- [ ] **Step 1: Create `src/review-controller.ts`:**

```ts
import { App, MarkdownView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type { ReviewStore } from "./review-store";
import { isReviewablePath, nextItem } from "./lib/review-queue";

const UNDO_MS = 8_000;

export class ReviewController {
	constructor(
		private readonly app: App,
		private readonly store: ReviewStore,
	) {}

	/** A vir session note: <category-dir>/<name>.md with a session_id. */
	isReviewable(file: TFile | null): file is TFile {
		if (!file || !isReviewablePath(file.path)) return false;
		const sid: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.["session_id"];
		return typeof sid === "string" && sid.length > 0;
	}

	approve(file: TFile): Promise<void> {
		return this.act("approve", file);
	}

	reject(file: TFile): Promise<void> {
		return this.act("reject", file);
	}

	async openNext(): Promise<void> {
		if (this.store.snapshot.fetchedAt === null) await this.store.refresh();
		const first = this.store.snapshot.items[0];
		if (first) await this.openPath(first.path);
		else new Notice("Vir: nothing left to review");
	}

	async openPath(path: string, leaf?: WorkspaceLeaf): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await (leaf ?? this.app.workspace.getLeaf(false)).openFile(file);
	}

	private async act(action: "approve" | "reject", file: TFile): Promise<void> {
		const leaf = this.leafShowing(file);
		// Obsidian saves the editor buffer on a delay. If it saves after the CLI
		// writes `verified: true`, the stamp is silently overwritten. Flush first.
		for (const l of this.app.workspace.getLeavesOfType("markdown")) {
			if (l.view instanceof MarkdownView && l.view.file?.path === file.path) await l.view.save();
		}
		const title = this.store.snapshot.items.find((i) => i.path === file.path)?.title ?? file.basename;
		const outcome = await this.store.act(action, file.path);
		if (!outcome.ok) {
			if (outcome.reason !== "in_flight") new Notice(`Vir: ${outcome.message}`);
			return;
		}
		const next = nextItem(this.store.snapshot.items, Math.max(outcome.index, 0));
		if (next) await this.openPath(next.path, leaf ?? undefined);
		if (action === "reject") this.offerUndo(title, outcome.removed, outcome.index, outcome.result.path);
	}

	private offerUndo(
		title: string,
		removed: Parameters<ReviewStore["undoReject"]>[0],
		index: number,
		rejectedPath: string,
	): void {
		let notice: Notice | null = null;
		const frag = createFragment((f) => {
			f.appendText(`Rejected ${title} · `);
			const link = f.createEl("a", { text: "Undo", href: "#" });
			link.addEventListener("click", (evt) => {
				evt.preventDefault();
				notice?.hide();
				void this.store.undoReject(removed, index, rejectedPath).then(async (undo) => {
					if (!undo.ok) {
						new Notice(`Vir: ${undo.message}`);
						return;
					}
					await this.openPath(undo.result.path);
				});
			});
		});
		notice = new Notice(frag, UNDO_MS);
	}

	private leafShowing(file: TFile): WorkspaceLeaf | null {
		return (
			this.app.workspace
				.getLeavesOfType("markdown")
				.find((l) => l.view instanceof MarkdownView && l.view.file?.path === file.path) ?? null
		);
	}
}
```

(The Undo link lives inside the notice's own DOM, which Obsidian removes on hide; no `registerDomEvent` is needed or possible here.)

- [ ] **Step 2: Wire `src/main.ts`.** Add imports:
```ts
import { ReviewStore } from "./review-store";
import { ReviewController } from "./review-controller";
import { isAtLeast, REVIEW_MIN_CLI } from "./lib/review-queue";
```
Add fields to `VirPlugin`:
```ts
	reviewStore!: ReviewStore;
	review!: ReviewController;
	cliVersion: string | null = null;
```
In `onload()`, right after `this.client = new VirClient(this.settings.binaryPath);`:
```ts
		// Getter, not a captured client: refreshClient() swaps this.client.
		this.reviewStore = new ReviewStore(() => this.client);
		this.review = new ReviewController(this.app, this.reviewStore);
```
After the existing `addCommand` calls:
```ts
		this.addCommand({
			id: "approve-current-note",
			name: "Approve current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!this.review.isReviewable(file)) return false;
				if (!checking) void this.review.approve(file);
				return true;
			},
		});
		this.addCommand({
			id: "reject-current-note",
			name: "Reject current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!this.review.isReviewable(file)) return false;
				if (!checking) void this.review.reject(file);
				return true;
			},
		});
		this.addCommand({
			id: "open-next-review-note",
			name: "Open next note to review",
			callback: () => void this.review.openNext(),
		});
```
Add the method:
```ts
	/** Review needs vir-cli ≥ 0.23.0. Uses the version the status bar last saw. */
	async ensureReviewSupport(): Promise<"supported" | "unsupported" | "unknown"> {
		if (this.cliVersion === null) {
			try {
				this.cliVersion = (await this.client.doctor()).version;
			} catch {
				return "unknown";
			}
		}
		return isAtLeast(this.cliVersion, REVIEW_MIN_CLI) ? "supported" : "unsupported";
	}
```

- [ ] **Step 3: Record the version in `src/status-bar.ts`.** In `poll()`, replace the `try` body:
```ts
		try {
			const doctor = await this.plugin.client.doctor();
			this.plugin.cliVersion = doctor.version;
			view = resolveDaemonStatus(doctor);
		} catch (err) {
```

- [ ] **Step 4: Build and test**

Run: `npm run build && npx vitest run`
Expected: clean build (tsc included), all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review-controller.ts src/main.ts src/status-bar.ts
git commit -m "feat(review): controller (flush editor, act, open next, undo notice), commands, version gate"
```

### Task 8: Review tab and active-note card

**Files:**
- Create: `src/views/active-note-card.ts`, `src/views/review-tab.ts`
- Modify: `src/views/sidebar-view.ts` (third tab, card container, subscriptions), `src/views/result-row.ts` (optional verdict badge + reason line), `src/lib/format.ts` (`verdictColor`), `styles.css`
- Test: `tests/format.test.ts` (append `verdictColor`)

**Interfaces:**
- Consumes: `VirPlugin.reviewStore`, `.review`, `.ensureReviewSupport()` (Task 7); `findItem` (Task 5); `renderResultRow`, `renderEmptyState` (existing); `relativeTime` (existing).
- Produces: `export function verdictColor(verdict: string): string`; `ActiveNoteCard.render(parent: HTMLElement): void`; `ReviewTab.render(container: HTMLElement): void`.

- [ ] **Step 1: Failing test** — append to `tests/format.test.ts` (and add `verdictColor` to its import):

```ts
describe("verdictColor", () => {
	it("maps each verdict to a distinct color, muted for unknown", () => {
		expect(verdictColor("reject")).toBe("var(--color-red)");
		expect(verdictColor("merge")).toBe("var(--color-orange)");
		expect(verdictColor("verify")).toBe("var(--color-yellow)");
		expect(verdictColor("keep")).toBe("var(--text-muted)");
	});
});
```

Run: `npx vitest run tests/format.test.ts` → FAIL (`verdictColor` not exported).

- [ ] **Step 2: Implement `verdictColor`** — append to `src/lib/format.ts`:

```ts
export function verdictColor(verdict: string): string {
	switch (verdict) {
		case "reject":
			return "var(--color-red)";
		case "merge":
			return "var(--color-orange)";
		case "verify":
			return "var(--color-yellow)";
		default:
			return "var(--text-muted)";
	}
}
```
Run the test again → PASS.

Then extend `src/views/result-row.ts` so the queue rows don't reach into another component's DOM. Add `verdictColor` to its `../lib/format` import, add two optional fields to `RowData`:
```ts
	verdict?: string;
	reason?: string;
```
and in `renderResultRow`, after the `if (data.verified) { … }` block:
```ts
	if (data.verdict) {
		const v = meta.createSpan({ cls: "vir-badge", text: data.verdict });
		v.style.backgroundColor = verdictColor(data.verdict);
	}
```
and after the `if (data.date) …` line:
```ts
	if (data.reason) row.createDiv({ cls: "vir-row-reason", text: data.reason });
```

- [ ] **Step 3: Create `src/views/active-note-card.ts`:**

```ts
import type { App } from "obsidian";
import type VirPlugin from "../main";
import { findItem } from "../lib/review-queue";
import { verdictColor } from "../lib/format";

// The in-context half of review: whatever session note is open, show its
// verdict and the two actions. Reads the store's cache only.
export class ActiveNoteCard {
	constructor(
		private readonly app: App,
		private readonly plugin: VirPlugin,
	) {}

	render(parent: HTMLElement): void {
		parent.empty();
		const file = this.app.workspace.getActiveFile();
		if (!this.plugin.review.isReviewable(file)) {
			parent.hide();
			return;
		}
		parent.show();
		const snap = this.plugin.reviewStore.snapshot;
		if (snap.fetchedAt === null && !snap.inFlight && snap.error === null && !snap.notConfigured) {
			void this.plugin.reviewStore.refresh();
		}

		const card = parent.createDiv({ cls: "vir-card" });
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (fm?.["verified"] === true) {
			card.createDiv({ cls: "vir-card-verified", text: "✓ Verified" });
			return;
		}

		const item = findItem(snap.items, file.path);
		const head = card.createDiv({ cls: "vir-card-head" });
		if (item) {
			const badge = head.createSpan({ cls: "vir-badge", text: item.verdict });
			badge.style.backgroundColor = verdictColor(item.verdict);
			card.createDiv({ cls: "vir-card-reason", text: item.reason });
			const target = item.mergeInto;
			if (target) {
				const line = card.createDiv({ cls: "vir-card-reason" });
				line.appendText("merge into ");
				if (target.path !== null) {
					const targetPath = target.path;
					const link = line.createEl("a", { text: target.title ?? targetPath });
					link.addEventListener("click", () => void this.plugin.review.openPath(targetPath));
				} else {
					line.appendText("a note that no longer exists");
				}
			}
		} else {
			head.createSpan({ cls: "vir-card-muted", text: "Not flagged" });
		}

		const actions = card.createDiv({ cls: "vir-card-actions" });
		const approve = actions.createEl("button", { cls: "mod-cta", text: "Approve" });
		const reject = actions.createEl("button", { cls: "mod-warning", text: "Reject" });
		approve.disabled = snap.inFlight;
		reject.disabled = snap.inFlight;
		// Plain listeners: the card is rebuilt on every render (see ReviewTab).
		approve.addEventListener("click", () => void this.plugin.review.approve(file));
		reject.addEventListener("click", () => void this.plugin.review.reject(file));
	}
}
```

- [ ] **Step 4: Create `src/views/review-tab.ts`:**

```ts
import type { App } from "obsidian";
import type VirPlugin from "../main";
import { relativeTime } from "../lib/format";
import { openPluginSettings } from "../lib/app-setting";
import { REVIEW_MIN_CLI } from "../lib/review-queue";
import { renderEmptyState, renderResultRow } from "./result-row";

export class ReviewTab {
	constructor(
		private readonly app: App,
		private readonly plugin: VirPlugin,
	) {}

	async render(container: HTMLElement): Promise<void> {
		const support = await this.plugin.ensureReviewSupport();
		container.empty();
		if (support === "unsupported") {
			renderEmptyState(container, `Update vir to ${REVIEW_MIN_CLI} or later to review from Obsidian`);
			return;
		}

		const store = this.plugin.reviewStore;
		const snap = store.snapshot;
		if (snap.fetchedAt === null && snap.error === null && !snap.notConfigured && !snap.inFlight) {
			container.createDiv({ cls: "vir-empty", text: "Loading review queue…" });
			void store.refresh();
			return;
		}
		if (snap.notConfigured) {
			renderEmptyState(container, "Vir CLI not configured.", {
				label: "Open settings",
				onClick: () => openPluginSettings(this.app, this.plugin.manifest.id),
			});
			return;
		}

		const header = container.createDiv({ cls: "vir-review-header" });
		const fetched = snap.fetchedAt !== null ? ` · fetched ${relativeTime(new Date(snap.fetchedAt).toISOString())}` : "";
		header.createSpan({
			text: `${snap.items.length} to review · ${snap.counts.unaudited} not audited · ${snap.counts.stale} stale${fetched}`,
		});
		const refresh = header.createEl("button", { cls: "clickable-icon", text: "↻" });
		refresh.setAttr("aria-label", "Refresh review queue");
		// Plain listeners: these elements are rebuilt on every render and the
		// old ones are dropped with container.empty(). registerDomEvent would
		// pin every discarded element to the plugin until unload.
		refresh.addEventListener("click", () => void store.refresh());

		if (snap.error !== null) {
			renderEmptyState(container, `Couldn't load the queue: ${snap.error}`);
			return;
		}
		if (snap.items.length === 0) {
			renderEmptyState(container, "Queue clear. Run `vir audit` in a terminal to judge new notes.");
			return;
		}

		for (const item of snap.items) {
			renderResultRow(container, {
				title: item.title,
				category: item.category,
				project: item.project ?? undefined,
				date: item.date,
				verdict: item.verdict,
				reason: item.reason,
				onClick: () => void this.plugin.review.openPath(item.path),
			});
		}
	}
}
```

- [ ] **Step 5: Wire `src/views/sidebar-view.ts`.** Replace the file's body with:

```ts
import { ItemView, WorkspaceLeaf } from "obsidian";
import { VIR_ICON_ID } from "../icon";
import type VirPlugin from "../main";
import { RecentTab } from "./recent-tab";
import { RelatedTab } from "./related-tab";
import { ReviewTab } from "./review-tab";
import { ActiveNoteCard } from "./active-note-card";

export const VIR_VIEW_TYPE = "vir-sidebar";

type TabId = "recent" | "related" | "review";
const TAB_IDS: readonly TabId[] = ["recent", "related", "review"];

export class VirSidebarView extends ItemView {
	private recentTab: RecentTab;
	private relatedTab: RelatedTab;
	private reviewTab: ReviewTab;
	private card: ActiveNoteCard;
	private activeTab: TabId = "recent";

	private tabButtons = {} as Record<TabId, HTMLElement>;
	private containers = {} as Record<TabId, HTMLElement>;
	private cardContainer!: HTMLElement;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: VirPlugin,
	) {
		super(leaf);
		this.recentTab = new RecentTab(this.app, this.plugin);
		this.relatedTab = new RelatedTab(this.app, this.plugin, this);
		this.reviewTab = new ReviewTab(this.app, this.plugin);
		this.card = new ActiveNoteCard(this.app, this.plugin);
	}

	getViewType(): string {
		return VIR_VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Vir";
	}
	getIcon(): string {
		return VIR_ICON_ID;
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("vir-view");

		const tabs = root.createDiv({ cls: "vir-tabs" });
		this.tabButtons.recent = this.makeTab(tabs, "recent", "Recent");
		this.tabButtons.related = this.makeTab(tabs, "related", "Related");
		this.tabButtons.review = this.makeTab(tabs, "review", "Review");

		this.cardContainer = root.createDiv({ cls: "vir-card-slot" });
		for (const id of TAB_IDS) this.containers[id] = root.createDiv({ cls: "vir-content" });

		this.relatedTab.mount(this.containers.related);
		this.register(this.plugin.reviewStore.onChange(() => this.onReviewChange()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.renderCard()));
		this.registerEvent(this.app.metadataCache.on("changed", () => this.renderCard()));
		this.show(this.activeTab);
	}

	async onClose(): Promise<void> {
		this.relatedTab.unmount();
	}

	private makeTab(parent: HTMLElement, id: TabId, label: string): HTMLElement {
		const btn = parent.createEl("button", { cls: "vir-tab", text: label });
		this.registerDomEvent(btn, "click", () => this.show(id));
		return btn;
	}

	private show(id: TabId): void {
		this.activeTab = id;
		for (const t of TAB_IDS) {
			this.tabButtons[t].toggleClass("is-active", t === id);
			this.containers[t].toggle(t === id);
		}
		if (id === "recent") this.recentTab.render(this.containers.recent);
		if (id === "review") void this.reviewTab.render(this.containers.review);
		this.renderCard();
	}

	private onReviewChange(): void {
		if (this.activeTab === "review") void this.reviewTab.render(this.containers.review);
		this.renderCard();
	}

	private renderCard(): void {
		if (this.activeTab === "recent") {
			this.cardContainer.empty();
			this.cardContainer.hide();
			return;
		}
		void this.plugin.ensureReviewSupport().then((s) => {
			if (s === "supported") this.card.render(this.cardContainer);
			else this.cardContainer.hide();
		});
	}

	/** Used by the "Surface related notes" command. */
	focusRelatedAndRefresh(): void {
		this.show("related");
		this.relatedTab.forceRefresh();
	}
}
```

- [ ] **Step 6: Styles** — append to `styles.css`:

```css
/* ---- review ---- */
.vir-card-slot { padding: 8px 8px 0; }
.vir-card { padding: 8px; border: 1px solid var(--background-modifier-border); border-radius: 6px; font-size: var(--font-ui-small); }
.vir-card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.vir-card-reason { color: var(--text-muted); font-size: var(--font-ui-smaller); margin-bottom: 4px; }
.vir-card-muted { color: var(--text-muted); }
.vir-card-verified { color: var(--color-green); font-weight: 600; }
.vir-card-actions { display: flex; gap: 6px; margin-top: 6px; }
.vir-review-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0 8px 8px; font-size: var(--font-ui-smaller); color: var(--text-muted); }
.vir-row-reason { font-size: var(--font-ui-smaller); color: var(--text-muted); margin-top: 2px; }
```

- [ ] **Step 7: Build and test**

Run: `npm run build && npx vitest run`
Expected: clean; all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/views src/lib/format.ts tests/format.test.ts styles.css
git commit -m "feat(review): Review tab and active-note card"
```

### Task 9: Contract fixtures, docs, manual pass, 0.3.0

**Files:**
- Create: `tests/contract/fixtures/review-queue.json`, `review-approve.json`, `review-reject.json`, `review-restore.json`, `review-busy.json`
- Modify: `tests/contract/contract.test.ts`, `tests/contract/fixtures/README.md`, `README.md`, `CLAUDE.md` (architecture rule 3), `tasks/todo.md`, version files via `npm version`

**Interfaces:**
- Consumes: the built CLI from Task 3 (`VIRCLI=<vir worktree>/dist/cli.js`).

- [ ] **Step 1: Capture the queue fixture** (read-only against the real vault):

```bash
VIRCLI=/Users/djmarkovic999/projects/vir/.claude/worktrees/obsidian-plugin-upgrade-scope-7f5401/dist/cli.js
node "$VIRCLI" review --audited --json > tests/contract/fixtures/review-queue.json
head -c 300 tests/contract/fixtures/review-queue.json; echo
```

- [ ] **Step 2: Capture action fixtures in a sandbox HOME** (never act on the real vault):

```bash
SB=$(mktemp -d); mkdir -p "$SB/.vir" "$SB/vault/vir/patterns"
python3 - "$SB" <<'PY'
import json, os, sys
sb = sys.argv[1]
cfg = json.load(open(os.path.expanduser("~/.vir/config.json")))
cfg["vaultPath"] = f"{sb}/vault"
cfg["outputDir"] = "vir"
json.dump(cfg, open(f"{sb}/.vir/config.json", "w"))
PY
cat > "$SB/vault/vir/patterns/demo-note-abc12345.md" <<'MD'
---
topic: "demo note"
category: pattern
project: "demo"
session_id: abc12345-0000-4000-8000-000000000001
date: 2026-09-01T00:00:00.000Z
confidence: 0.9
---

body
MD
F=tests/contract/fixtures
HOME="$SB" node "$VIRCLI" review --approve=patterns/demo-note-abc12345.md --json > $F/review-approve.json
HOME="$SB" node "$VIRCLI" review --reject=patterns/demo-note-abc12345.md --json > $F/review-reject.json
HOME="$SB" node "$VIRCLI" review --restore=demo-note-abc12345.md --json > $F/review-restore.json
echo $$ > "$SB/.vir/vir.lock"   # a live pid (this shell) holds the lock
HOME="$SB" node "$VIRCLI" review --approve=patterns/demo-note-abc12345.md --json 2> $F/review-busy.json; echo "exit=$?"
rm -rf "$SB"
cat $F/review-approve.json $F/review-reject.json $F/review-restore.json $F/review-busy.json
```

Expected: three action results (reject's `path` starts `.rejected/`), then `exit=1` and a busy payload `{"error":"another vir process ...","kind":"busy"}`. The sandbox config copies real settings (possibly API keys) into a temp dir; the `rm -rf` removes it.

- [ ] **Step 3: Contract tests** — append to `tests/contract/contract.test.ts`:

```ts
describe("vir review --json contract (fixtures: review-*.json, vir-cli 0.23.0)", () => {
	it("queue matches VirReviewQueue", () => {
		const q = load("review-queue.json") as { items: Record<string, unknown>[]; counts: Record<string, unknown> };
		expect(kind(q.counts.unaudited)).toBe("number");
		expect(kind(q.counts.stale)).toBe("number");
		for (const i of q.items) {
			expect(kind(i.path)).toBe("string");
			expect(kind(i.sessionId)).toBe("string");
			expect(kind(i.title)).toBe("string");
			expect(VIR_CATEGORIES).toContain(i.category);
			expect(["string", "null"]).toContain(kind(i.project));
			expect(kind(i.date)).toBe("string");
			expect(kind(i.confidence)).toBe("number");
			expect(["reject", "merge", "verify"]).toContain(i.verdict);
			expect(kind(i.reason)).toBe("string");
			expect(kind(i.auditedAt)).toBe("string");
			if (i.mergeInto !== null) {
				const m = i.mergeInto as Record<string, unknown>;
				expect(kind(m.sessionId)).toBe("string");
				expect(["string", "null"]).toContain(kind(m.path));
				expect(["string", "null"]).toContain(kind(m.title));
			}
		}
	});

	it("action results match VirReviewActionResult", () => {
		for (const [file, action] of [
			["review-approve.json", "approve"],
			["review-reject.json", "reject"],
			["review-restore.json", "restore"],
		] as const) {
			const r = load(file) as Record<string, unknown>;
			expect(r.action).toBe(action);
			expect(kind(r.path)).toBe("string");
			expect(kind(r.sessionId)).toBe("string");
		}
		expect((load("review-reject.json") as { path: string }).path.startsWith(".rejected/")).toBe(true);
	});

	it("busy is a VirErrorPayload with kind busy", () => {
		expect(load("review-busy.json")).toMatchObject({ kind: "busy" });
	});
});
```
Run: `npx vitest run tests/contract` → PASS.

- [ ] **Step 4: Docs**
- `tests/contract/fixtures/README.md`: add the capture commands from Steps 1-2 and "review fixtures captured <date> against vir-cli 0.23.0".
- `README.md`: a `### Review tab` section (queue worst first, card on Related/Review, Approve/Reject, 8-second Undo, the three commands and that they can take hotkeys, needs vir-cli 0.23.0+, `vir audit` stays in the terminal) and a short note: "Edits to a note's body are replaced the next time vir rewrites it; approve records your verdict, not your edits."
- `CLAUDE.md` rule 3: "Three wire shapes: `VirQueryResult[]`, `VirDoctorResult`, and the `vir review --json` shapes (`VirReviewQueue`, `VirReviewActionResult`). Review is the only write path, and it goes through the CLI."
- `tasks/todo.md`: a `## v0.3.0` section checking off Tasks 4-9.

- [ ] **Step 5: Version, build, install into the vault**

```bash
npm version 0.3.0 --no-git-tag-version
npm run build && npx vitest run
cp main.js styles.css manifest.json ~/Vir/vir/.obsidian/plugins/vir/
```
Then in Obsidian: View → Force Reload.

- [ ] **Step 6: Manual pass** (record each result in the PR description)
1. Review tab lists the queue worst first with reasons; header counts match `vir review --audited --json`.
2. Open a queued note → card shows its verdict and reason on both Review and Related tabs. Approve → next item opens; the note's frontmatter has `verified: true`.
3. Reject → next item opens; notice "Rejected … · Undo" shows; click Undo within 8 s → note returns to its folder without `verified`, reappears in the queue.
4. Type in a note body and click Approve within a second → reopen the note; `verified: true` is present and the typed text too.
5. Start `vir run` in a terminal (a real run holds the lock) and click Reject → busy notice, note unchanged.
6. Set the binary path to a vir < 0.23.0 (e.g. a global install of 0.22.1) → Review tab shows the update message; card hidden. Restore the path.
7. Open a topic note and a note under `archived/` → no card.

- [ ] **Step 7: Commit, push, PR**

```bash
git add -A
git commit -m "feat: review queue in the sidebar (vir review --json), 0.3.0"
git push -u origin feat/0.3.0-review-queue
gh pr create --base main --title "0.3.0: review queue in the sidebar" --body-file <(printf '%s\n' "Implements the review queue spec (vir repo docs/superpowers/specs/2026-09-28-obsidian-review-queue-design.md). Requires vir-cli 0.23.0.")
```
Then edit the PR body to add the manual-pass results. Do not tag. Release order: vir-cli 0.23.0 on npm first, then tag `0.3.0` here.

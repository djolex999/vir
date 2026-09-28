import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildReviewQueue,
  errorPayload,
  type VirErrorKind,
  type VirReviewAction,
  type VirReviewActionResult,
  type VirReviewQueue,
} from "../output/json.js";
import { acquireLock, LOCK_PATH, LockHeldError, releaseLock } from "../pipeline/lock.js";
import { CATEGORY_DIR, REJECTED_DIR } from "../pipeline/writer.js";
import { loadConfig } from "../config.js";
import { StateDb } from "../state/db.js";
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

  let db: StateDb | undefined;
  try {
    db = new StateDb();
    const action = actions[0];
    const out =
      action === undefined
        ? reviewQueue(vaultRoot, db, opts.project)
        : runReviewAction({ vaultRoot, db }, action[0], action[1]);
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch (err) {
    fail(err instanceof ReviewJsonError ? err.kind : "internal", (err as Error).message);
  } finally {
    db?.close();
  }
}

function fail(kind: VirErrorKind, message: string): void {
  process.stderr.write(JSON.stringify(errorPayload(kind, message)) + "\n");
  process.exitCode = 1;
}

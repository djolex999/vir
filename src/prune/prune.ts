import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { setFrontmatter } from "../cli/review.js";
import type { Config } from "../config.js";
import { acquireLock, releaseLock, LOCK_PATH } from "../pipeline/lock.js";
import { makeSlug } from "../pipeline/slug.js";
import { CATEGORY_DIR, REJECTED_DIR } from "../pipeline/writer.js";
import type { PruneCandidateRow, StateDb } from "../state/db.js";
import { classifyRow, type PruneDecision } from "./classify.js";

// Frontmatter keys prune owns. Deliberately NOT review's `rejected_at`: a note
// can be both review-rejected and pruned, and stripping a key we did not write
// would make `--restore` lossy. `.rejected/` residency is what review's own
// mechanics key on (collectNotes skips the directory), not the key.
const PRUNED_AT = "pruned_at";
const PRUNE_REASON = "prune_reason";

export interface PrunePlanItem {
  path: string;
  sessionId: string;
  slug: string;
  notePath: string;
  noteExists: boolean;
  topic: string;
  project: string | null;
  decision: PruneDecision;
}

export interface PrunePlan {
  prune: PrunePlanItem[];
  keep: PrunePlanItem[];
  alreadyPruned: number;
  byReason: Record<string, number>;
  byKeepReason: Record<string, number>;
  // Links in notes we are KEEPING that point at a note we would demote.
  // Reported, never repaired: rewriting a kept note is an edit the user did
  // not ask for, and the count is the honest cost of the operation.
  danglingLinks: number;
}

export interface PruneIoOptions {
  lockPath?: string;
  now?: string;
}

function vaultRoot(cfg: Config): string {
  return join(cfg.vaultPath, cfg.outputDir);
}

function deriveSessionId(path: string): string {
  return basename(path).replace(/\.jsonl$/, "");
}

function noteIsMergeWinner(notePath: string): boolean {
  try {
    return readFileSync(notePath, "utf8").includes("## Archived Duplicates");
  } catch {
    return false;
  }
}

function toItem(row: PruneCandidateRow, cfg: Config): PrunePlanItem {
  const sessionId = deriveSessionId(row.path);
  const slug = makeSlug(row.topic, sessionId);
  const notePath = join(
    vaultRoot(cfg),
    CATEGORY_DIR[row.category] ?? `${row.category}s`,
    `${slug}.md`,
  );
  const noteExists = existsSync(notePath);
  return {
    path: row.path,
    sessionId,
    slug,
    notePath,
    noteExists,
    topic: row.topic,
    project: row.project,
    decision: classifyRow(
      {
        path: row.path,
        entrypoint: row.entrypoint,
        isMergeWinner: noteExists && noteIsMergeWinner(notePath),
      },
      cfg.claudeProjectsDir,
    ),
  };
}

// Count wikilinks pointing at a to-be-pruned slug from notes that are staying.
// Walks the live category dirs only — `.rejected/` and `archived/` are already
// out of every read path, so a link from there costs nothing.
function countDanglingLinks(cfg: Config, doomed: PrunePlanItem[]): number {
  if (doomed.length === 0) return 0;
  const slugs = new Set(doomed.map((d) => d.slug));
  const doomedFiles = new Set(doomed.map((d) => d.notePath));
  let count = 0;
  for (const sub of Object.values(CATEGORY_DIR)) {
    const dir = join(vaultRoot(cfg), sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const full = join(dir, name);
      if (doomedFiles.has(full)) continue;
      let raw: string;
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const m of raw.matchAll(/\[\[([^\]|]+)/g)) {
        if (slugs.has((m[1] ?? "").trim())) count += 1;
      }
    }
  }
  return count;
}

export function buildPrunePlan(db: StateDb, cfg: Config): PrunePlan {
  const prune: PrunePlanItem[] = [];
  const keep: PrunePlanItem[] = [];
  let alreadyPruned = 0;
  const byReason: Record<string, number> = {};
  const byKeepReason: Record<string, number> = {};

  for (const row of db.listPruneCandidates()) {
    if (row.pruned_at !== null) {
      alreadyPruned += 1;
      continue;
    }
    const item = toItem(row, cfg);
    if (item.decision.action === "prune") {
      prune.push(item);
      byReason[item.decision.reason] = (byReason[item.decision.reason] ?? 0) + 1;
    } else {
      keep.push(item);
      byKeepReason[item.decision.reason] =
        (byKeepReason[item.decision.reason] ?? 0) + 1;
    }
  }

  return {
    prune,
    keep,
    alreadyPruned,
    byReason,
    byKeepReason,
    danglingLinks: countDanglingLinks(cfg, prune),
  };
}

export interface PruneApplyResult {
  moved: number;
  marked: number;
  // Rows whose note file was already absent from the category dir (a
  // review-rejected note, or one deleted by hand). The DB state is still set —
  // that is the half that actually gates retrieval.
  stateOnly: number;
}

export function applyPrunePlan(
  db: StateDb,
  cfg: Config,
  plan: PrunePlan,
  opts: PruneIoOptions = {},
): PruneApplyResult {
  const lockPath = opts.lockPath ?? LOCK_PATH;
  const now = opts.now ?? new Date().toISOString();
  acquireLock(lockPath);
  try {
    const rejectedDir = join(vaultRoot(cfg), REJECTED_DIR);
    let moved = 0;
    let stateOnly = 0;

    for (const item of plan.prune) {
      if (item.decision.action !== "prune") continue;
      if (item.noteExists) {
        if (!existsSync(rejectedDir)) mkdirSync(rejectedDir, { recursive: true });
        const dest = join(rejectedDir, basename(item.notePath));
        const stamped = setFrontmatter(readFileSync(item.notePath, "utf8"), {
          [PRUNED_AT]: now,
          [PRUNE_REASON]: item.decision.reason,
        });
        writeFileSync(dest, stamped);
        rmSync(item.notePath, { force: true });
        moved += 1;
      } else {
        stateOnly += 1;
      }
      db.markPruned(item.path, item.decision.reason, now);
    }

    return { moved, marked: plan.prune.length, stateOnly };
  } finally {
    releaseLock(lockPath);
  }
}

export interface PruneRestoreResult {
  restored: number;
  missing: number;
}

export function restorePruned(
  db: StateDb,
  cfg: Config,
  opts: PruneIoOptions = {},
): PruneRestoreResult {
  const lockPath = opts.lockPath ?? LOCK_PATH;
  acquireLock(lockPath);
  try {
    const rejectedDir = join(vaultRoot(cfg), REJECTED_DIR);
    let restored = 0;
    let missing = 0;

    for (const row of db.listPruneCandidates()) {
      if (row.pruned_at === null) continue;
      const item = toItem(row, cfg);
      const src = join(rejectedDir, `${item.slug}.md`);
      if (existsSync(src)) {
        const stripped = removeFrontmatterKeys(readFileSync(src, "utf8"), [
          PRUNED_AT,
          PRUNE_REASON,
        ]);
        mkdirSync(join(vaultRoot(cfg), CATEGORY_DIR[row.category]), {
          recursive: true,
        });
        writeFileSync(item.notePath, stripped);
        rmSync(src, { force: true });
      } else {
        missing += 1;
      }
      db.clearPruned(row.path);
      restored += 1;
    }
    return { restored, missing };
  } finally {
    releaseLock(lockPath);
  }
}

// Remove whole frontmatter lines for the given keys. Paired with
// setFrontmatter, which appends new keys as their own lines, this is what makes
// a restore byte-exact.
export function removeFrontmatterKeys(
  content: string,
  keys: string[],
): string {
  const m = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!m) return content;
  const drop = new Set(keys);
  const kept = (m[2] ?? "")
    .split("\n")
    .filter((line) => {
      const idx = line.indexOf(":");
      return idx === -1 || !drop.has(line.slice(0, idx).trim());
    })
    .join("\n");
  return (
    (m[1] ?? "---\n") +
    kept +
    (m[3] ?? "\n---") +
    content.slice((m.index ?? 0) + m[0].length)
  );
}

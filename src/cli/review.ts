import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config.js";
import { CATEGORY_DIR, REJECTED_DIR, kebab } from "../pipeline/writer.js";
import type { Category } from "../pipeline/types.js";
import type { AuditRow } from "../state/db.js";
import { StateDb } from "../state/db.js";
import { syncRejections } from "../state/rejections.js";
import * as ui from "../ui/display.js";

// The four typed category dirs hold reviewable notes. `.rejected/`, `archived/`,
// `projects/`, index.md and log.md are intentionally never walked.
const CATEGORY_DIRS = ["patterns", "gotchas", "decisions", "tools"] as const;

export interface ReviewNote {
  filePath: string;
  relPath: string;
  topic: string;
  category: string;
  project: string;
  confidence: number;
  date: string;
  verified: boolean;
  sessionId: string;
}

// Frontmatter is line-oriented `key: value`. Mirrors mcp/server.ts so review
// reads notes the same way the rest of the codebase does — strips surrounding
// quotes so a value like `topic: "x"` parses to `x`.
export function parseFrontmatter(content: string): Record<string, string> {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  const block = m?.[1];
  if (block === undefined) return {};
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key.length === 0) continue;
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    }
    out[key] = val;
  }
  return out;
}

// Upsert keys in the YAML frontmatter, preserving every other line (and the
// whole body) verbatim. Existing keys are replaced in place; new keys are
// appended just before the closing `---`. Values are written raw — callers
// pass already-safe scalars (booleans, ISO dates).
export function setFrontmatter(
  content: string,
  updates: Record<string, string>,
): string {
  const m = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!m) {
    const block = Object.entries(updates)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    return `---\n${block}\n---\n\n${content}`;
  }
  const remaining = { ...updates };
  const lines = (m[2] ?? "").split("\n").map((line) => {
    const idx = line.indexOf(":");
    if (idx === -1) return line;
    const key = line.slice(0, idx).trim();
    if (key in remaining) {
      const val = remaining[key];
      delete remaining[key];
      return `${key}: ${val}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(remaining)) lines.push(`${k}: ${v}`);
  return (
    (m[1] ?? "---\n") +
    lines.join("\n") +
    (m[3] ?? "\n---") +
    content.slice((m.index ?? 0) + m[0].length)
  );
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

// Approve: stamp verified + reviewed_at. Re-reads the file each call so it also
// captures any edits made via $EDITOR immediately before approval.
export function approveNote(
  filePath: string,
  now: string = new Date().toISOString(),
): void {
  const content = readFileSync(filePath, "utf8");
  writeFileSync(
    filePath,
    setFrontmatter(content, { verified: "true", reviewed_at: now }),
  );
}

// Reject: stamp rejected_at and move the note into `.rejected/` (recoverable,
// never deleted). Returns the new path.
export function rejectNote(
  filePath: string,
  vaultRoot: string,
  now: string = new Date().toISOString(),
): string {
  const content = readFileSync(filePath, "utf8");
  const updated = setFrontmatter(content, { rejected_at: now });
  const rejectedDir = join(vaultRoot, REJECTED_DIR);
  if (!existsSync(rejectedDir)) mkdirSync(rejectedDir, { recursive: true });
  const dest = join(rejectedDir, basename(filePath));
  writeFileSync(dest, updated);
  rmSync(filePath);
  return dest;
}

// Undo one review rejection: move the note back to its category dir, drop the
// stamp, and let its row serve again. `name` is the filename in `.rejected/`,
// with or without `.md`. Refuses rather than overwrite a live note.
export function restoreRejected(
  db: StateDb,
  vaultRoot: string,
  name: string,
): string {
  const file = name.endsWith(".md") ? name : `${name}.md`;
  const src = join(vaultRoot, REJECTED_DIR, basename(file));
  if (!existsSync(src)) {
    throw new Error(`no rejected note named ${file} in ${REJECTED_DIR}/`);
  }
  const content = readFileSync(src, "utf8");
  const fm = parseFrontmatter(content);
  const subDir = CATEGORY_DIR[fm.category as Category];
  if (subDir === undefined) {
    throw new Error(`${file} has no known category (got "${fm.category ?? ""}")`);
  }
  const dest = join(vaultRoot, subDir, basename(file));
  if (existsSync(dest)) {
    throw new Error(`${join(subDir, basename(file))} already exists — not overwriting it`);
  }
  mkdirSync(join(vaultRoot, subDir), { recursive: true });
  writeFileSync(dest, removeFrontmatterKeys(content, ["rejected_at"]));
  rmSync(src);
  if (fm.session_id) db.clearRejected(fm.session_id);
  return dest;
}

export interface CollectOptions {
  all?: boolean;
  project?: string;
  limit?: number;
}

// Walk the category dirs and return reviewable notes, newest first. Default
// behavior hides verified notes (and `.rejected/` is never on the walk path);
// `all` includes verified ones for re-review.
export function collectNotes(
  vaultRoot: string,
  opts: CollectOptions = {},
): ReviewNote[] {
  const projSlug = opts.project ? kebab(opts.project) : null;
  const out: ReviewNote[] = [];

  for (const dir of CATEGORY_DIRS) {
    const full = join(vaultRoot, dir);
    if (!existsSync(full)) continue;
    let names: string[];
    try {
      names = readdirSync(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const filePath = join(full, name);
      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const fm = parseFrontmatter(content);
      const verified = fm.verified === "true";
      if (!opts.all && verified) continue;
      if (projSlug && kebab(fm.project ?? "") !== projSlug) continue;
      out.push({
        filePath,
        relPath: join(dir, name),
        topic: fm.topic ?? name.replace(/\.md$/, ""),
        category: fm.category ?? dir.replace(/s$/, ""),
        project: fm.project ?? "",
        confidence: Number(fm.confidence ?? "0") || 0,
        date: fm.date ?? "",
        verified,
        sessionId: fm.session_id ?? "",
      });
    }
  }

  out.sort((a, b) => b.date.localeCompare(a.date));
  if (opts.limit && opts.limit > 0) return out.slice(0, opts.limit);
  return out;
}

export interface AuditedNote extends ReviewNote {
  audit: AuditRow;
}

const AUDIT_ORDER: Record<string, number> = { reject: 0, merge: 1, verify: 2 };

// Worst first, so a short review session spends its attention where the
// auditor saw the most noise. `keep` needs no human, and a stale verdict judged
// text the note no longer has.
export function orderForAudit(notes: ReviewNote[], audits: AuditRow[]): AuditedNote[] {
  const bySession = new Map(audits.filter((a) => a.fresh).map((a) => [a.sessionId, a]));
  return notes
    .flatMap((n) => {
      const audit = bySession.get(n.sessionId);
      return audit !== undefined && audit.verdict !== "keep" ? [{ ...n, audit }] : [];
    })
    .sort(
      (a, b) =>
        (AUDIT_ORDER[a.audit.verdict] ?? 9) - (AUDIT_ORDER[b.audit.verdict] ?? 9) ||
        b.date.localeCompare(a.date),
    );
}

// Body sans frontmatter and the injected "Project:/Category:" wikilink header,
// collapsed to a single paragraph for a compact preview.
function excerpt(content: string): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const lines = body.split("\n");
  // Drop the leading wikilink header lines and any blank padding around them.
  while (lines.length > 0) {
    const first = (lines[0] ?? "").trim();
    if (first === "" || /^(Project|Category):/.test(first)) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

// Opens the note in $EDITOR (or $VISUAL), falling back to nano. Synchronous so
// the review loop blocks until the editor exits. Returns false if the editor
// couldn't be launched at all.
function openInEditor(filePath: string): boolean {
  const editor = process.env.EDITOR || process.env.VISUAL || "nano";
  const res = spawnSync(editor, [filePath], { stdio: "inherit" });
  return !res.error;
}

function renderNote(
  n: ReviewNote,
  idx: number,
  total: number,
  audit?: { verdict: string; reason: string; target: string | null },
): void {
  const catColor = ui.colorForCategory[n.category] ?? ui.text;
  ui.line(
    `${ui.dim(`[${idx + 1}/${total}]`)} ${ui.text(ui.shortNotePath(n.relPath))}`,
  );
  ui.line(
    `${catColor(n.category)}  ${ui.dim(ui.BULLET)}  ${ui.text(n.project || "—")}` +
      `  ${ui.dim(ui.BULLET)}  ${ui.dim("conf")} ${ui.info(n.confidence.toFixed(2))}` +
      (n.verified ? `  ${ui.dim(ui.BULLET)}  ${ui.success("verified")}` : ""),
  );
  if (audit !== undefined) {
    const color = audit.verdict === "reject" ? ui.errorColor : ui.warn;
    ui.line(
      `${ui.dim("audit")}  ${color(audit.verdict)}${audit.target ? ui.dim(` → ${audit.target}`) : ""}  ${ui.text(audit.reason)}`,
    );
  }
  ui.blank();
  let body = "";
  try {
    body = excerpt(readFileSync(n.filePath, "utf8"));
  } catch {
    body = "";
  }
  ui.line(ui.dim(ui.wrap(body.slice(0, 320), 64)));
  ui.blank();
}

export interface ReviewCliOptions {
  all?: boolean;
  project?: string;
  limit?: string;
  restore?: string;
  audited?: boolean;
}

export async function runReview(opts: ReviewCliOptions): Promise<void> {
  const cfg = loadConfig();
  const vaultRoot = join(cfg.vaultPath, cfg.outputDir);
  const db = new StateDb();
  try {
    await reviewWithDb(opts, vaultRoot, db);
  } finally {
    db.close();
  }
}

async function reviewWithDb(
  opts: ReviewCliOptions,
  vaultRoot: string,
  db: StateDb,
): Promise<void> {
  if (opts.restore !== undefined) {
    const dest = restoreRejected(db, vaultRoot, opts.restore);
    ui.header("review");
    ui.blank();
    ui.row(ui.success(ui.CHECK), ui.text(`restored → ${ui.shortNotePath(dest)}`));
    return;
  }
  syncRejections(db, vaultRoot);

  const parsedLimit = opts.limit ? Number.parseInt(opts.limit, 10) : 50;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;

  const collected = collectNotes(vaultRoot, {
    all: opts.all,
    project: opts.project,
    limit: opts.audited ? undefined : limit,
  });
  const topicBySession = new Map(db.listDistilled().map((r) => [r.sessionId, r.topic]));
  const audited = opts.audited ? orderForAudit(collected, db.listAudits()).slice(0, limit) : null;
  const notes: ReviewNote[] = audited ?? collected;

  ui.header("review");
  ui.blank();

  if (notes.length === 0) {
    ui.row(
      ui.success(ui.CHECK),
      ui.text(
        opts.audited
          ? "no flagged notes — run `vir audit` first"
          : opts.all
            ? "no notes found to review"
            : "no unreviewed notes — you're all caught up",
      ),
    );
    return;
  }

  const scope = opts.project ? ` in ${opts.project}` : "";
  ui.line(
    ui.dim(
      `Found ${notes.length} ${opts.all ? "" : "unreviewed "}note${notes.length === 1 ? "" : "s"}${scope}.`,
    ),
  );
  ui.blank();

  const rl = createInterface({ input: stdin, output: stdout });
  let approved = 0;
  let edited = 0;
  let rejected = 0;
  let skipped = 0;
  let quit = false;

  try {
    for (let i = 0; i < notes.length; i += 1) {
      const n = notes[i];
      if (!n) continue;
      ui.divider();
      const a = audited?.[i]?.audit;
      renderNote(
        n,
        i,
        notes.length,
        a && {
          verdict: a.verdict,
          reason: a.reason,
          target: a.mergeInto ? (topicBySession.get(a.mergeInto) ?? a.mergeInto) : null,
        },
      );

      const ans = (
        await rl.question(
          ui.muted("[a]pprove  [e]dit  [r]eject  [s]kip  [q]uit: "),
        )
      )
        .trim()
        .toLowerCase();

      if (ans === "a") {
        approveNote(n.filePath);
        approved += 1;
        ui.row(ui.success(ui.CHECK), ui.text("approved"));
      } else if (ans === "e") {
        rl.pause();
        const launched = openInEditor(n.filePath);
        rl.resume();
        if (!launched) {
          ui.row(
            ui.warn(ui.WARN_GLYPH),
            ui.text("could not open editor — left unreviewed"),
          );
          skipped += 1;
          continue;
        }
        approveNote(n.filePath);
        edited += 1;
        ui.row(ui.success(ui.CHECK), ui.text("edited + approved"));
      } else if (ans === "r") {
        const dest = rejectNote(n.filePath, vaultRoot);
        const sid = parseFrontmatter(readFileSync(dest, "utf8")).session_id;
        if (sid) db.markRejected(sid);
        rejected += 1;
        ui.row(ui.warn(ui.CROSS), ui.text(`rejected → ${ui.shortNotePath(dest)}`));
      } else if (ans === "q") {
        quit = true;
        break;
      } else {
        // skip (explicit [s], empty, or any unrecognized key): no mutation.
        skipped += 1;
      }
    }
  } finally {
    rl.close();
  }

  const reviewed = approved + edited + rejected;
  ui.blank();
  ui.divider();
  ui.line(
    ui.text(
      `Reviewed ${reviewed} note${reviewed === 1 ? "" : "s"}: ` +
        `${approved} approved, ${edited} edited, ${rejected} rejected, ${skipped} skipped.` +
        (quit ? ui.dim("  (quit early)") : ""),
    ),
  );
  ui.divider();
}

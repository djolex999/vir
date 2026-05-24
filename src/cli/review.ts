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
import { kebab } from "../pipeline/writer.js";
import * as ui from "../ui/display.js";

// The four typed category dirs hold reviewable notes. `.rejected/`, `archived/`,
// `projects/`, index.md and log.md are intentionally never walked.
const CATEGORY_DIRS = ["patterns", "gotchas", "decisions", "tools"] as const;
const REJECTED_DIR = ".rejected";

export interface ReviewNote {
  filePath: string;
  relPath: string;
  topic: string;
  category: string;
  project: string;
  confidence: number;
  date: string;
  verified: boolean;
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
      });
    }
  }

  out.sort((a, b) => b.date.localeCompare(a.date));
  if (opts.limit && opts.limit > 0) return out.slice(0, opts.limit);
  return out;
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

function renderNote(n: ReviewNote, idx: number, total: number): void {
  const catColor = ui.colorForCategory[n.category] ?? ui.text;
  ui.line(
    `${ui.dim(`[${idx + 1}/${total}]`)} ${ui.text(ui.shortNotePath(n.relPath))}`,
  );
  ui.line(
    `${catColor(n.category)}  ${ui.dim(ui.BULLET)}  ${ui.text(n.project || "—")}` +
      `  ${ui.dim(ui.BULLET)}  ${ui.dim("conf")} ${ui.info(n.confidence.toFixed(2))}` +
      (n.verified ? `  ${ui.dim(ui.BULLET)}  ${ui.success("verified")}` : ""),
  );
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
}

export async function runReview(opts: ReviewCliOptions): Promise<void> {
  const cfg = loadConfig();
  const vaultRoot = join(cfg.vaultPath, cfg.outputDir);

  const parsedLimit = opts.limit ? Number.parseInt(opts.limit, 10) : 50;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;

  const notes = collectNotes(vaultRoot, {
    all: opts.all,
    project: opts.project,
    limit,
  });

  ui.header("review");
  ui.blank();

  if (notes.length === 0) {
    ui.row(
      ui.success(ui.CHECK),
      ui.text(
        opts.all
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
      renderNote(n, i, notes.length);

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

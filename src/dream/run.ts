import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { flaggedNotePaths } from "../claude/updater.js";
import { parseFrontmatter } from "../cli/review.js";
import { noteRef } from "../pipeline/slug.js";
import { readExistingChangelog } from "../pipeline/summarizer.js";
import { noteStatusLookup, type NoteStatus } from "../search/noteStatus.js";
import type { NoteUsage } from "../search/noteUsage.js";
import type { DistilledRow, StateDb } from "../state/db.js";
import { DreamParseError, buildDreamPrompt, parseDreamResponse } from "./prompt.js";
import { renderBody, renderDreamFile } from "./render.js";
import { dreamInputHash, selectDreamNotes, type DreamSelection } from "./select.js";
import { validateDream, type DreamStats } from "./validate.js";

// One project's dream: select notes, one model call, validate in code, write
// projects/<slug>.md. The only file it ever writes is that page.

export const DREAM_BUDGET_TOKENS = 60_000;
export const DEFAULT_MIN_NOTES = 5;

type VaultCfg = Pick<Config, "vaultPath" | "outputDir">;

export interface DreamDeps {
  llm: (prompt: string) => Promise<string>;
  isVerified: (r: DistilledRow) => boolean;
  usage: ReadonlyMap<string, NoteUsage>;
  now?: () => string;
}

export type DreamOutcome =
  | { kind: "too-few"; notes: number }
  | { kind: "unchanged"; path: string }
  | { kind: "written"; path: string; stats: DreamStats; conflicts: number }
  | { kind: "failed"; reason: string };

export function projectPagePath(cfg: VaultCfg, slug: string): string {
  return join(cfg.vaultPath, cfg.outputDir, "projects", `${slug}.md`);
}

function readPage(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function planDream(
  cfg: VaultCfg,
  db: StateDb,
  slug: string,
  deps: Omit<DreamDeps, "llm">,
  opts: { force?: boolean; minNotes?: number },
): { selection: DreamSelection; inputHash: string; skip: DreamOutcome | null } {
  const grounds = db.listGrounds();
  const lookup = noteStatusLookup(grounds);
  const statusOf = (r: DistilledRow): NoteStatus =>
    deps.isVerified(r) ? "verified" : lookup({ title: noteRef(r), content: r.content });
  const selection = selectDreamNotes(db.listDistilled(), slug, {
    flagged: flaggedNotePaths(db.listAudits(), grounds),
    isVerified: deps.isVerified,
    statusOf,
    usage: deps.usage,
    budgetTokens: DREAM_BUDGET_TOKENS,
  });
  const inputHash = dreamInputHash(selection.notes);
  const minNotes = opts.minNotes ?? DEFAULT_MIN_NOTES;
  if (selection.notes.length < minNotes) {
    return { selection, inputHash, skip: { kind: "too-few", notes: selection.notes.length } };
  }
  const file = projectPagePath(cfg, slug);
  const existing = readPage(file);
  if (!opts.force && existing !== null && parseFrontmatter(existing).input_hash === inputHash) {
    return { selection, inputHash, skip: { kind: "unchanged", path: file } };
  }
  return { selection, inputHash, skip: null };
}

function writeAtomically(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.vir-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export async function dreamProject(
  cfg: VaultCfg,
  db: StateDb,
  slug: string,
  deps: DreamDeps,
  opts: { force?: boolean; minNotes?: number; model: string },
): Promise<DreamOutcome> {
  const plan = planDream(cfg, db, slug, deps, opts);
  if (plan.skip !== null) return plan.skip;
  const { notes, sourceChars } = plan.selection;
  const projectName = notes[0]?.row.project ?? slug;

  let raw;
  try {
    raw = parseDreamResponse(await deps.llm(buildDreamPrompt(projectName, notes)));
  } catch (err) {
    if (err instanceof DreamParseError) return { kind: "failed", reason: err.message };
    throw err;
  }
  const { page, stats } = validateDream(raw, notes, sourceChars, (p) => Buffer.byteLength(renderBody(p)));
  if (stats.kept === 0) {
    return { kind: "failed", reason: `no entry survived the quote check (${stats.dropped} dropped)` };
  }

  const file = projectPagePath(cfg, slug);
  const content = renderDreamFile({
    projectSlug: slug,
    page,
    stats,
    notes: notes.length,
    sessions: new Set(notes.map((n) => n.row.sessionId)).size,
    inputHash: plan.inputHash,
    model: opts.model,
    generated: (deps.now ?? (() => new Date().toISOString()))(),
    existingChangelog: readExistingChangelog(file),
  });
  writeAtomically(file, content);
  return { kind: "written", path: file, stats, conflicts: page.conflicts.length };
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "../config.js";
import { dayOf } from "../journal/render.js";
import { kebab } from "../pipeline/slug.js";
import { checkClaim, findUndocumented } from "./check.js";
import { CodeIndex, gitTopLevel, mainCheckout } from "./codeIndex.js";
import { discoverDocs } from "./discover.js";
import { blankVirBlock, extractClaims } from "./extract.js";
import type { DocReport, DriftReport } from "./types.js";

export const DRIFT_SUBDIR = "drift";
export const DEFAULT_DRIFT_TZ = "Europe/Belgrade";

export interface DriftOptions {
  docs?: string[];
  only?: string;
  timeZone?: string;
  now?: Date;
  // Docs may only be read from inside this folder (see discoverDocs).
  allowedRoot?: string;
}

// The repo `path` belongs to: its git top level, or the folder itself.
export function resolveRepoRoot(path: string): string {
  return gitTopLevel(path) ?? path;
}

export function repoSlug(root: string): string {
  return kebab(basename(mainCheckout(root) ?? root));
}

// Deterministic drift for one repo. Docs are read and checked one at a time;
// the code index is built once and shared.
export function runDrift(path: string, opts: DriftOptions = {}): DriftReport {
  const root = resolveRepoRoot(path);
  const idx = new CodeIndex(root);
  const bins = idx.cli().bins;
  const all = discoverDocs(root, opts.docs ?? [], opts.allowedRoot);
  const docs = opts.only !== undefined ? all.filter((d) => d.rel === opts.only) : all;
  const texts: string[] = [];
  const reports: DocReport[] = [];
  for (const doc of docs) {
    let md: string;
    try {
      md = readFileSync(doc.abs, "utf8");
    } catch {
      continue;
    }
    texts.push(blankVirBlock(md.split("\n")).join("\n"));
    const claims = extractClaims(md, { bins });
    const items = claims
      .map((c) => checkClaim(c, doc.rel, idx))
      .filter((i): i is NonNullable<typeof i> => i !== null);
    reports.push({ doc: doc.rel, ...(doc.source !== undefined ? { source: doc.source } : {}), checked: claims.length, items });
  }
  // Undocumented is judged against every doc, even when one was asked for.
  if (opts.only !== undefined) {
    for (const d of all) {
      if (docs.includes(d)) continue;
      try {
        texts.push(blankVirBlock(readFileSync(d.abs, "utf8").split("\n")).join("\n"));
      } catch {
        continue;
      }
    }
  }
  const und = findUndocumented(texts, idx);
  return {
    root,
    slug: repoSlug(root),
    date: dayOf((opts.now ?? new Date()).toISOString(), opts.timeZone ?? DEFAULT_DRIFT_TZ) ?? "",
    head: idx.head(),
    docs: reports,
    undocumented: und.items,
    undocumentedMore: und.more,
  };
}

function atomicWrite(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, file);
}

// Latest report at drift/<slug>.md, dated copy at drift/<slug>/<date>.md.
export function driftVaultPaths(cfg: Pick<Config, "vaultPath" | "outputDir">, slug: string, date: string): { latest: string; dated: string } {
  const dir = join(cfg.vaultPath, cfg.outputDir, DRIFT_SUBDIR);
  return { latest: join(dir, `${slug}.md`), dated: join(dir, slug, `${date}.md`) };
}

export function writeDriftReport(cfg: Pick<Config, "vaultPath" | "outputDir">, report: DriftReport, body: string): { latest: string; dated: string } {
  const paths = driftVaultPaths(cfg, report.slug, report.date);
  atomicWrite(paths.latest, body);
  atomicWrite(paths.dated, body);
  return paths;
}

export function writeReportFile(file: string, body: string): void {
  if (existsSync(file) && !file.endsWith(".md")) throw new Error(`refusing to overwrite non-markdown file ${file}`);
  atomicWrite(file, body);
}

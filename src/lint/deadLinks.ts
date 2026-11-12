import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "../config.js";

// Wikilinks in vault notes that resolve to nothing. Session notes build their
// Related list from embedding neighbors at write time; when a neighbor is later
// retitled, rejected, pruned or merged, the links to it go dead and stay dead
// until the linking note is rewritten. On the reference vault that was 22% of
// the links checked (310 of 1427).
//
// The fix never repoints a link by session id: a re-distilled session can come
// back under an unrelated title ("motion-underutilization-in-dashboard" became
// "held-debt-broke-ci"), so the same id is not the same note. Session notes are
// re-rendered instead, which rebuilds Related from embedding neighbors that
// exist. Only the dead bullets go: the note's live links stay, and the freed
// slots are filled with the nearest notes not already listed, from the note's
// stored embedding. Other notes (topic pages, PDFs, journal) only lose links
// whose target is gone; `vir compose` and `vir journal` rebuild those.

// Folders under the vir output dir whose notes are checked. Hub pages
// (projects/, the category files) and index/log are link targets, not sources.
const SOURCE_DIRS = ["patterns", "gotchas", "decisions", "tools", "topics", "insights", "articles", "pdfs", "journal"];
// Obsidian ignores dot-folders, so a note in .rejected/ does not resolve.
// archived/ is a normal folder: it resolves, which is what dedupe's links rely on.
const SESSION_SUFFIX = /-([0-9a-f]{8})$/;
const LINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
// The header every session note carries: `Project: [[growthq]]`, `Category:
// [[pattern]]`. Those are hub links, resolved or not by design.
const HUB_LINE = /^(?:Project|Category):\s/;

export type DeadLinkKind = "retitled" | "removed" | "unknown";

export interface DeadLink {
  // Vault-relative path of the note holding the link, under the output dir.
  relPath: string;
  line: number;
  target: string;
  kind: DeadLinkKind;
  // For "retitled": the live note now carrying that session id. Shown for
  // context only; it is often a different subject, so it is never linked.
  replacement: string | null;
}

export interface DeadLinkResult {
  scanned: number;
  links: number;
  dead: DeadLink[];
}

interface VaultIndex {
  // Lowercased basenames (with and without .md) and aliases that resolve.
  resolvable: Set<string>;
  // Session suffix -> live basenames (no .md) carrying it.
  liveBySuffix: Map<string, string[]>;
}

function walk(dir: string, acc: string[], skipDot: boolean): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (skipDot && e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc, skipDot);
    else acc.push(full);
  }
}

function frontmatterAliases(raw: string): string[] {
  if (!raw.startsWith("---\n")) return [];
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return [];
  const fm = raw.slice(4, end).split("\n");
  const out: string[] = [];
  let inAliases = false;
  for (const line of fm) {
    if (/^aliases:\s*$/.test(line)) {
      inAliases = true;
      continue;
    }
    if (inAliases) {
      const m = line.match(/^\s+-\s+"?(.*?)"?\s*$/);
      if (m) {
        if (m[1]) out.push(m[1]);
        continue;
      }
      inAliases = false;
    }
  }
  return out;
}

function buildIndex(vaultPath: string): VaultIndex {
  const files: string[] = [];
  walk(vaultPath, files, true);
  const resolvable = new Set<string>();
  const liveBySuffix = new Map<string, string[]>();
  for (const full of files) {
    const name = full.slice(full.lastIndexOf("/") + 1);
    resolvable.add(name.toLowerCase());
    if (!name.endsWith(".md")) continue;
    const base = name.slice(0, -3);
    resolvable.add(base.toLowerCase());
    const s = base.match(SESSION_SUFFIX);
    if (s?.[1] !== undefined) {
      const list = liveBySuffix.get(s[1]) ?? [];
      list.push(base);
      liveBySuffix.set(s[1], list);
    }
    let raw: string;
    try {
      raw = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    for (const a of frontmatterAliases(raw)) resolvable.add(a.toLowerCase());
  }
  return { resolvable, liveBySuffix };
}

function linkTarget(inner: string): string {
  return (inner.split("|")[0] ?? "").split("#")[0]?.trim() ?? "";
}

export function classifyDeadLink(
  target: string,
  liveBySuffix: ReadonlyMap<string, string[]>,
): { kind: DeadLinkKind; replacement: string | null } {
  const base = target.slice(target.lastIndexOf("/") + 1);
  const s = base.match(SESSION_SUFFIX);
  if (s?.[1] === undefined) return { kind: "unknown", replacement: null };
  const live = liveBySuffix.get(s[1]) ?? [];
  // Exactly one live note from the same session: the target was retitled.
  // Several would make the repoint a guess, so that case stays unknown.
  if (live.length === 1) return { kind: "retitled", replacement: live[0] ?? null };
  if (live.length === 0) return { kind: "removed", replacement: null };
  return { kind: "unknown", replacement: null };
}

export function deadLinkCheck(cfg: Pick<Config, "vaultPath" | "outputDir">): DeadLinkResult {
  const root = join(cfg.vaultPath, cfg.outputDir);
  const index = buildIndex(cfg.vaultPath);
  const result: DeadLinkResult = { scanned: 0, links: 0, dead: [] };
  for (const dir of SOURCE_DIRS) {
    const files: string[] = [];
    walk(join(root, dir), files, true);
    for (const full of files) {
      if (!full.endsWith(".md")) continue;
      let raw: string;
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      result.scanned += 1;
      let inFence = false;
      raw.split("\n").forEach((line, i) => {
        if (/^\s*```/.test(line)) inFence = !inFence;
        if (inFence || HUB_LINE.test(line)) return;
        for (const m of line.matchAll(LINK)) {
          const target = linkTarget(m[2] ?? "");
          if (target === "") continue;
          result.links += 1;
          const base = target.slice(target.lastIndexOf("/") + 1).toLowerCase();
          if (index.resolvable.has(base)) continue;
          result.dead.push({
            relPath: relative(root, full),
            line: i + 1,
            target,
            ...classifyDeadLink(target, index.liveBySuffix),
          });
        }
      });
    }
  }
  return result;
}

function labelFor(base: string): string {
  return base.replace(SESSION_SUFFIX, "");
}

// Drops a note's links to removed targets: a bullet that is only that link is
// deleted, an inline link becomes its label as plain text. Retitled and unknown
// links are left alone. Pure, for tests.
export function dropRemovedLinks(raw: string, dead: DeadLink[]): { text: string; removed: number } {
  const byLine = new Map<number, Set<string>>();
  for (const d of dead) {
    if (d.kind !== "removed") continue;
    const set = byLine.get(d.line) ?? new Set<string>();
    set.add(d.target);
    byLine.set(d.line, set);
  }
  let removed = 0;
  const out: string[] = [];
  raw.split("\n").forEach((line, i) => {
    const targets = byLine.get(i + 1);
    if (targets === undefined) {
      out.push(line);
      return;
    }
    const bulletOnly = /^\s*[-*]\s+\[\[[^\]]+\]\]\s*$/.test(line);
    let hit = false;
    const next = line.replace(LINK, (whole, _bang: string, inner: string) => {
      const target = linkTarget(inner);
      if (!targets.has(target)) return whole;
      hit = true;
      removed += 1;
      return inner.includes("|") ? inner.slice(inner.indexOf("|") + 1).trim() : labelFor(target);
    });
    if (hit && bulletOnly) return;
    out.push(next);
  });
  return { text: out.join("\n"), removed };
}

export interface DeadLinkFixSummary {
  // Session notes whose Related list was repaired.
  repaired: number;
  // Dead links taken out (Related bullets in session notes, gone targets elsewhere).
  removed: number;
  // Fresh neighbors added in place of removed Related bullets.
  added: number;
  // Dead links still present after the fix, from a fresh check.
  left: number;
}

export interface NeighborLink {
  slug: string;
  topic: string;
}

const SESSION_DIRS = new Set(["patterns", "gotchas", "decisions", "tools"]);
const BULLET = /^\s*[-*]\s+/;

// Repairs a session note's Related section: drops every bullet that holds a
// dead link, then fills that many slots with `candidates` (best first) not
// already linked and not the note itself. Inline links to removed targets
// elsewhere in the note become their label. Pure, for tests.
export function repairRelated(
  raw: string,
  dead: DeadLink[],
  selfBase: string,
  candidates: NeighborLink[],
): { text: string; removed: number; added: number } {
  const deadByLine = new Map<number, DeadLink[]>();
  for (const d of dead) {
    const list = deadByLine.get(d.line) ?? [];
    list.push(d);
    deadByLine.set(d.line, list);
  }
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => /^##\s+related\b/i.test(l));
  let end = lines.length;
  if (start !== -1) {
    const next = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
    if (next !== -1) end = next;
  }
  const out: string[] = [];
  const kept: string[] = [];
  let removed = 0;
  let lastBulletAt = -1;
  lines.forEach((line, i) => {
    const inRelated = start !== -1 && i > start && i < end;
    const deadHere = deadByLine.get(i + 1);
    if (inRelated && BULLET.test(line)) {
      if (deadHere !== undefined) {
        removed += 1;
        return;
      }
      kept.push(line);
      out.push(line);
      lastBulletAt = out.length - 1;
      return;
    }
    if (!inRelated && deadHere !== undefined && deadHere.some((d) => d.kind === "removed")) {
      const r = dropRemovedLinks(line, deadHere.map((d) => ({ ...d, line: 1 })));
      removed += r.removed;
      if (r.text !== "" || !BULLET.test(line)) out.push(r.text);
      return;
    }
    out.push(line);
  });
  const linked = new Set<string>([selfBase.toLowerCase()]);
  for (const l of kept) for (const m of l.matchAll(LINK)) linked.add(linkTarget(m[2] ?? "").toLowerCase());
  const deadInRelated = start === -1 ? 0 : [...deadByLine.keys()].filter((ln) => ln - 1 > start && ln - 1 < end && BULLET.test(lines[ln - 1] ?? "")).length;
  const fill = candidates.filter((c) => !linked.has(c.slug.toLowerCase())).slice(0, deadInRelated);
  if (fill.length > 0 && start !== -1) {
    const at = lastBulletAt !== -1 ? lastBulletAt + 1 : out.findIndex((l) => /^##\s+related\b/i.test(l)) + 2;
    out.splice(Math.min(at, out.length), 0, ...fill.map((c) => `- [[${c.slug}|${c.topic}]]`));
  }
  return { text: out.join("\n"), removed, added: fill.length };
}

export async function fixDeadLinks(
  cfg: Pick<Config, "vaultPath" | "outputDir">,
  result: DeadLinkResult,
  // Nearest existing notes to the session note at this output-relative path,
  // best first; null when it has no stored embedding (no fill, dead bullets
  // still go).
  neighbors: (relPath: string) => NeighborLink[] | null,
): Promise<DeadLinkFixSummary> {
  const root = join(cfg.vaultPath, cfg.outputDir);
  const byFile = new Map<string, DeadLink[]>();
  for (const d of result.dead) {
    const list = byFile.get(d.relPath) ?? [];
    list.push(d);
    byFile.set(d.relPath, list);
  }
  const summary: DeadLinkFixSummary = { repaired: 0, removed: 0, added: 0, left: 0 };
  for (const [rel, dead] of byFile) {
    const full = join(root, rel);
    const raw = readFileSync(full, "utf8");
    const dir = rel.split("/")[0] ?? "";
    let text: string;
    if (SESSION_DIRS.has(dir)) {
      const base = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/, "");
      const r = repairRelated(raw, dead, base, neighbors(rel) ?? []);
      text = r.text;
      summary.removed += r.removed;
      summary.added += r.added;
      if (text !== raw) summary.repaired += 1;
    } else {
      const r = dropRemovedLinks(raw, dead);
      text = r.text;
      summary.removed += r.removed;
    }
    if (text !== raw) writeFileSync(full, text);
  }
  summary.left = deadLinkCheck(cfg).dead.length;
  return summary;
}

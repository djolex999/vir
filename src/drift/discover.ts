import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { mainCheckout } from "./codeIndex.js";

// Which docs make claims about the current code: CLAUDE.md layers (nested
// ones are per-folder deltas) and the root README. Dated audits, plans and
// changelogs are history and are not checked unless asked for by --doc.

export interface DocFile {
  // Repo-relative path the doc speaks for.
  rel: string;
  // Absolute path to read it from.
  abs: string;
  // Where it was read from, when that isn't the checked tree.
  source?: string;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "coverage", "vendor", ".venv", "__pycache__", ".turbo", "worktrees",
]);
const MAX_DEPTH = 6;

function nestedClaudeMd(root: string, dir: string, depth: number, acc: string[]): void {
  if (depth > MAX_DEPTH) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) nestedClaudeMd(root, full, depth + 1, acc);
    else if (name === "CLAUDE.md" && dir !== root) acc.push(relative(root, full));
  }
}

// True when `path` really sits inside `dir` (symlinks resolved).
export function isInside(path: string, dir: string): boolean {
  try {
    const rel = relative(realpathSync(dir), realpathSync(path));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

// `allowedRoot`: the main-checkout fallback is used only when that checkout
// is inside it. A repo's .git file can point anywhere, so the MCP tool, which
// only accepts repos under $HOME, must not follow it out of $HOME.
export function discoverDocs(root: string, extra: string[] = [], allowedRoot?: string): DocFile[] {
  const docs: DocFile[] = [];
  const rootClaude = join(root, "CLAUDE.md");
  if (existsSync(rootClaude)) {
    docs.push({ rel: "CLAUDE.md", abs: rootClaude });
  } else {
    // CLAUDE.md is often gitignored, so a worktree has none. The main
    // checkout's copy describes its own branch: label it so a difference
    // reads as "main's doc vs this branch", not silent drift.
    const main = mainCheckout(root);
    const allowed = main !== null && (allowedRoot === undefined || isInside(main, allowedRoot));
    if (main !== null && allowed && existsSync(join(main, "CLAUDE.md"))) {
      docs.push({ rel: "CLAUDE.md", abs: join(main, "CLAUDE.md"), source: "main checkout" });
    }
  }
  if (existsSync(join(root, ".claude", "CLAUDE.md"))) docs.push({ rel: ".claude/CLAUDE.md", abs: join(root, ".claude", "CLAUDE.md") });
  const nested: string[] = [];
  nestedClaudeMd(root, root, 0, nested);
  for (const rel of nested.sort()) if (rel !== ".claude/CLAUDE.md") docs.push({ rel, abs: join(root, rel) });
  for (const name of ["README.md", "readme.md", "Readme.md"]) {
    if (existsSync(join(root, name))) {
      docs.push({ rel: name, abs: join(root, name) });
      break;
    }
  }
  for (const e of extra) {
    const rel = relative(root, resolve(root, e));
    if (rel.startsWith("..") || docs.some((d) => d.rel === rel)) continue;
    if (existsSync(join(root, rel))) docs.push({ rel, abs: join(root, rel) });
  }
  return docs;
}

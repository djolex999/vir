import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

// What the code actually has, read once per repo: the file list, every
// package.json, the commander CLI, a lazy word index over code files and the
// rename/delete history. All deterministic, no model, no new dependency.

const WALK_SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "coverage", "vendor", ".venv", "__pycache__", ".turbo",
]);
const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|py|go|rs|rb|sh|ya?ml|toml|swift|kt|java|php|sql)$/;
const MAX_CODE_FILE_BYTES = 1_000_000;
const MAX_CODE_FILES = 8000;

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

export function gitTopLevel(path: string): string | null {
  return git(path, ["rev-parse", "--show-toplevel"])?.trim() || null;
}

// A worktree's main checkout: where gitignored files like CLAUDE.md live.
export function mainCheckout(root: string): string | null {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim();
  if (!common || basename(common) !== ".git") return null;
  const main = dirname(common);
  return main === root ? null : main;
}

function walk(root: string, dir: string, acc: string[]): void {
  if (acc.length > 50_000) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (WALK_SKIP.has(name)) continue;
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(root, full, acc);
    else if (st.isFile()) acc.push(relative(root, full));
  }
}

// Tracked plus untracked-but-not-ignored files; a plain walk outside git.
export function listFiles(root: string): string[] {
  const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (out !== null) return [...new Set(out.split("\0").filter((f) => f.length > 0))].filter((f) => existsSync(join(root, f)));
  const acc: string[] = [];
  walk(root, root, acc);
  return acc;
}

interface PackageJson {
  name?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface PackageInfo {
  dir: string;
  name: string | null;
  scripts: Set<string>;
  deps: Set<string>;
  bins: string[];
}

function readPackage(root: string, rel: string): PackageInfo | null {
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(join(root, rel), "utf8")) as PackageJson;
  } catch {
    return null;
  }
  const name = typeof pkg.name === "string" ? pkg.name : null;
  const bins =
    typeof pkg.bin === "string"
      ? name !== null ? [name.replace(/^@[^/]+\//, "")] : []
      : pkg.bin !== undefined ? Object.keys(pkg.bin) : [];
  return {
    dir: dirname(rel) === "." ? "" : dirname(rel),
    name,
    scripts: new Set(Object.keys(pkg.scripts ?? {})),
    deps: new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]),
    bins,
  };
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const LOCKFILES: [string, PackageManager][] = [
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
];

export interface CliInfo {
  bins: Set<string>;
  // Top-level command names, and "parent sub" paths for nested ones.
  commands: Set<string>;
  subcommands: Map<string, Set<string>>;
  flags: Set<string>;
}

export interface FileHistory {
  // old path -> new path, newest rename wins.
  renamed: Map<string, { to: string; commit: string }>;
  deleted: Map<string, { commit: string; date: string }>;
}

// Commander's `.command("x")` on `program` (the `new Command()` variable) is a
// top-level command; on a variable bound to another `.command()` it is a sub.
export function parseCommander(sources: string[]): Omit<CliInfo, "bins"> {
  const commands = new Set<string>();
  const subcommands = new Map<string, Set<string>>();
  const flags = new Set<string>();
  for (const src of sources) {
    if (!src.includes(".command(")) continue;
    const roots = new Set([...src.matchAll(/(\w+)\s*=\s*new\s+Command\(/g)].map((m) => m[1] ?? ""));
    const bound = new Map<string, string>();
    for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(\w+)\s*\.command\(\s*["'`]([\w:-]+)/g)) {
      if (roots.size === 0 || roots.has(m[2] ?? "")) bound.set(m[1] ?? "", m[3] ?? "");
    }
    for (const m of src.matchAll(/(\w+)\s*\.command\(\s*["'`]([\w:-]+)/g)) {
      const recv = m[1] ?? "";
      const name = m[2] ?? "";
      const parent = bound.get(recv);
      if (parent !== undefined) {
        const subs = subcommands.get(parent) ?? new Set<string>();
        subs.add(name);
        subcommands.set(parent, subs);
      } else if (roots.size === 0 || roots.has(recv)) {
        commands.add(name);
      }
    }
    for (const m of src.matchAll(/\.(?:option|requiredOption)\(\s*["'`]([^"'`]+)/g)) {
      for (const f of (m[1] ?? "").matchAll(/--(?:no-)?([a-z][\w-]*)/g)) flags.add(`--${f[1]}`);
    }
  }
  return { commands, subcommands, flags };
}

export class CodeIndex {
  readonly root: string;
  readonly files: string[];
  readonly fileSet: Set<string>;
  readonly dirSet: Set<string>;
  readonly packages: PackageInfo[];
  readonly manager: { name: PackageManager; lockfile: string } | null;
  private codeText: string[] | null = null;
  private wordCache = new Map<string, boolean>();
  private historyCache: FileHistory | null = null;
  private cliCache: CliInfo | null = null;

  constructor(root: string) {
    this.root = root;
    this.files = listFiles(root);
    this.fileSet = new Set(this.files);
    this.dirSet = new Set<string>();
    for (const f of this.files) {
      let d = dirname(f);
      while (d !== "." && !this.dirSet.has(d)) {
        this.dirSet.add(d);
        d = dirname(d);
      }
    }
    this.packages = this.files
      .filter((f) => basename(f) === "package.json")
      .map((f) => readPackage(root, f))
      .filter((p): p is PackageInfo => p !== null);
    const lock = LOCKFILES.find(([file]) => this.fileSet.has(file));
    this.manager = lock !== undefined ? { name: lock[1], lockfile: lock[0] } : null;
  }

  // A file or directory, repo-relative, without a trailing slash.
  exists(rel: string): boolean {
    const p = rel.replace(/\/+$/, "");
    if (p === "" || p === ".") return true;
    if (this.fileSet.has(p) || this.dirSet.has(p)) return true;
    // Ignored files (CLAUDE.md, .env.example kept local) are not in the list.
    return existsSync(join(this.root, p));
  }

  hasTopLevel(segment: string): boolean {
    return this.exists(segment);
  }

  basenameMatches(name: string): string[] {
    return this.files.filter((f) => basename(f) === name);
  }

  // The package.json closest above `rel` (a doc's folder), else the root one.
  nearestPackage(relDir: string): PackageInfo | null {
    let d = relDir === "." ? "" : relDir;
    for (;;) {
      const hit = this.packages.find((p) => p.dir === d);
      if (hit !== undefined) return hit;
      if (d === "") return null;
      d = dirname(d) === "." ? "" : dirname(d);
    }
  }

  allDeps(): Set<string> {
    return new Set(this.packages.flatMap((p) => [...p.deps]));
  }

  ownNames(): Set<string> {
    return new Set(this.packages.map((p) => p.name).filter((n): n is string => n !== null));
  }

  private codeFiles(): string[] {
    if (this.codeText !== null) return this.codeText;
    const out: string[] = [];
    for (const f of this.files) {
      if (out.length >= MAX_CODE_FILES) break;
      const base = basename(f);
      // Never read real env files; examples are how env vars get documented.
      if (/^\.env(\..*)?$/.test(base) && !/\.(example|sample|template)$/.test(base)) continue;
      if (!CODE_EXT.test(f) && !/\.(example|sample|template)$/.test(base)) continue;
      if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f)) continue;
      try {
        const full = join(this.root, f);
        if (statSync(full).size > MAX_CODE_FILE_BYTES) continue;
        out.push(readFileSync(full, "utf8"));
      } catch {
        continue;
      }
    }
    this.codeText = out;
    return out;
  }

  // Whole-word occurrence in any code file (docs excluded).
  hasWord(word: string): boolean {
    const cached = this.wordCache.get(word);
    if (cached !== undefined) return cached;
    const re = new RegExp(`(^|[^A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`);
    const hit = this.codeFiles().some((t) => re.test(t));
    this.wordCache.set(word, hit);
    return hit;
  }

  cli(): CliInfo {
    if (this.cliCache !== null) return this.cliCache;
    const parsed = parseCommander(
      this.files
        .filter((f) => /\.(ts|tsx|mts|js|mjs|cjs)$/.test(f) && !/\.test\./.test(f))
        .map((f) => {
          try {
            return readFileSync(join(this.root, f), "utf8");
          } catch {
            return "";
          }
        }),
    );
    this.cliCache = { bins: new Set(this.packages.flatMap((p) => p.bins)), ...parsed };
    return this.cliCache;
  }

  history(): FileHistory {
    if (this.historyCache !== null) return this.historyCache;
    const renamed = new Map<string, { to: string; commit: string }>();
    const deleted = new Map<string, { commit: string; date: string }>();
    const out = git(this.root, ["log", "-M", "--diff-filter=RD", "--name-status", "--format=@%h %as", "-n", "3000"]) ?? "";
    let commit = "";
    let date = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("@")) {
        [commit = "", date = ""] = line.slice(1).split(" ");
        continue;
      }
      const parts = line.split("\t");
      const status = parts[0] ?? "";
      // git log is newest first: keep the first (latest) event per path.
      if (status.startsWith("R") && parts[1] !== undefined && parts[2] !== undefined) {
        if (!renamed.has(parts[1])) renamed.set(parts[1], { to: parts[2], commit });
      } else if (status === "D" && parts[1] !== undefined) {
        if (!deleted.has(parts[1])) deleted.set(parts[1], { commit, date });
      }
    }
    this.historyCache = { renamed, deleted };
    return this.historyCache;
  }

  head(): string | null {
    return git(this.root, ["rev-parse", "--short", "HEAD"])?.trim() || null;
  }
}

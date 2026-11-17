import { basename, dirname, join, posix } from "node:path";
import type { CodeIndex } from "./codeIndex.js";
import type { Claim, DriftItem, Undocumented } from "./types.js";

// Each claim against the code. Results are `stale` (nothing backs it) or
// `changed` (git recorded where it went). No edit-distance guessing: a
// "changed" suggestion is either a recorded rename or the only file left
// with that name.

const COMMANDER_BUILTIN_FLAGS = new Set(["--help", "--version"]);
const UNDOCUMENTED_CAP = 15;

function norm(p: string): string {
  return posix.normalize(p).replace(/^\.\//, "").replace(/\/$/, "");
}

// Where a path claim lives in the repo, or null when it is not about the repo.
// A code span is anchored at the repo root; a tree entry or link at the doc's
// folder first. A path whose first segment exists nowhere is about something
// else (the vault, ~/.vir, another repo) and is skipped, not reported.
function resolvePath(claim: Claim, docDir: string, idx: CodeIndex): { rel: string; exists: boolean } | null {
  const v = norm(claim.value);
  const first = v.split("/")[0] ?? "";
  const bases = docDir === "" ? [""] : claim.via === "tree" || claim.via === "link" ? [docDir, ""] : ["", docDir];
  const at = (base: string, p: string): string => (base === "" ? p : norm(join(base, p)));
  for (const b of bases) if (idx.exists(at(b, v))) return { rel: at(b, v), exists: true };
  // A section of the root doc about a sub-package (`site/`) writes its paths
  // relative to that package.
  for (const p of idx.packages) if (p.dir !== "" && idx.exists(at(p.dir, v))) return { rel: at(p.dir, v), exists: true };
  for (const b of bases) {
    const rel = at(b, v);
    const h = idx.history();
    const anchor = claim.via === "link" ? dirname(rel) : at(b, first);
    if (idx.exists(anchor === "." ? "" : anchor) || h.renamed.has(rel) || h.deleted.has(rel)) return { rel, exists: false };
  }
  return null;
}

function followRenames(rel: string, idx: CodeIndex): { to: string; commit: string } | null {
  const { renamed } = idx.history();
  let cur = rel;
  let commit = "";
  for (let hop = 0; hop < 6; hop += 1) {
    const next = renamed.get(cur);
    if (next === undefined) break;
    cur = next.to;
    commit = next.commit;
    if (idx.exists(cur)) return { to: cur, commit };
  }
  return null;
}

function checkPath(claim: Claim, docDir: string, idx: CodeIndex): DriftItem | null {
  const r = resolvePath(claim, docDir, idx);
  if (r === null || r.exists) return null;
  const moved = followRenames(r.rel, idx);
  if (moved !== null) return { kind: "changed", claim, detail: `renamed in ${moved.commit}`, now: moved.to };
  const name = basename(r.rel);
  if (!claim.value.endsWith("/") && name.includes(".")) {
    const same = idx.basenameMatches(name);
    if (same.length === 1 && same[0] !== undefined) return { kind: "changed", claim, detail: "only file with that name", now: same[0] };
  }
  const del = idx.history().deleted.get(r.rel);
  return { kind: "stale", claim, detail: del !== undefined ? `deleted in ${del.commit} (${del.date})` : claim.value.endsWith("/") ? "no such directory" : "no such file" };
}

export function checkClaim(claim: Claim, docRel: string, idx: CodeIndex): DriftItem | null {
  const docDir = dirname(docRel) === "." ? "" : dirname(docRel);
  switch (claim.kind) {
    case "path":
      return checkPath(claim, docDir, idx);
    case "npm-script": {
      const pkg = idx.nearestPackage(docDir);
      if (pkg === null) return null;
      if (pkg.scripts.has(claim.value)) return null;
      // A root doc's section about a sub-package runs that package's scripts.
      if (idx.packages.some((p) => p.scripts.has(claim.value))) return null;
      const where = pkg.dir === "" ? "package.json" : `${pkg.dir}/package.json`;
      return { kind: "stale", claim, detail: `no "${claim.value}" script in ${where}` };
    }
    case "package-manager": {
      if (idx.manager === null || claim.value === idx.manager.name) return null;
      return { kind: "changed", claim, detail: `repo is locked with ${idx.manager.lockfile}`, now: idx.manager.name };
    }
    case "dependency": {
      if (idx.packages.length === 0) return null;
      if (idx.ownNames().has(claim.value) || idx.allDeps().has(claim.value)) return null;
      return { kind: "stale", claim, detail: "no package.json lists it" };
    }
    case "cli-command": {
      const cli = idx.cli();
      if (cli.commands.size === 0) return null;
      const [top = "", sub] = claim.value.split(" ");
      if (!cli.commands.has(top)) return { kind: "stale", claim, detail: `no "${top}" command` };
      const subs = cli.subcommands.get(top);
      if (sub !== undefined && subs !== undefined && subs.size > 0 && !subs.has(sub)) {
        return { kind: "stale", claim, detail: `"${top}" has no "${sub}" subcommand`, now: [...subs].sort().join(", ") };
      }
      return null;
    }
    case "cli-flag": {
      const cli = idx.cli();
      if (cli.commands.size === 0 || COMMANDER_BUILTIN_FLAGS.has(claim.value)) return null;
      return cli.flags.has(claim.value) ? null : { kind: "stale", claim, detail: `no ${claim.value} option anywhere in the CLI` };
    }
    case "env-var":
      return idx.hasWord(claim.value) ? null : { kind: "stale", claim, detail: "not read anywhere in the code" };
  }
}

// What the code has that no doc mentions: top-level source modules and CLI
// commands. Capped and reported once per repo, not per doc.
export function findUndocumented(docTexts: string[], idx: CodeIndex): { items: Undocumented[]; more: number } {
  const text = docTexts.join("\n");
  const items: Undocumented[] = [];
  for (const srcRoot of ["src", "lib", "app", "packages"]) {
    if (!idx.dirSet.has(srcRoot)) continue;
    const dirs = [...idx.dirSet]
      .filter((d) => dirname(d) === srcRoot)
      .map((d) => basename(d))
      .filter((d) => !/^(__\w+__|test|tests|fixtures|testFixtures)$/.test(d))
      .sort();
    for (const d of dirs) {
      const mentioned = text.includes(`${d}/`) || text.includes(`${srcRoot}/${d}`);
      if (!mentioned) items.push({ kind: "src-dir", name: `${srcRoot}/${d}/` });
    }
  }
  const cli = idx.cli();
  for (const cmd of [...cli.commands].sort()) {
    if (cmd === "help") continue;
    const mentioned = [...cli.bins].some((b) => new RegExp(`(^|[^\\w-])${b}\\s+${cmd.replace(/[-]/g, "\\-")}(?![\\w-])`).test(text));
    if (!mentioned && cli.bins.size > 0) items.push({ kind: "cli-command", name: `${[...cli.bins][0]} ${cmd}` });
  }
  return { items: items.slice(0, UNDOCUMENTED_CAP), more: Math.max(0, items.length - UNDOCUMENTED_CAP) };
}

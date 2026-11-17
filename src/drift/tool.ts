import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { renderDrift } from "./render.js";
import { resolveRepoRoot, runDrift } from "./run.js";

// The `vir_drift` MCP tool: the same deterministic check as `vir drift`,
// read-only. It never writes the vault or a report file and never calls a
// model. `path` is limited to a git repo or folder under $HOME that has a
// CLAUDE.md or README, so the tool can't be pointed at arbitrary files.

export function driftToolReport(path: string | undefined, doc: string | undefined, cwd: string = process.cwd(), home: string = homedir()): string {
  const target = resolve(cwd, path ?? ".");
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`not a directory: ${target}`);
  const root = resolveRepoRoot(target);
  const rel = relative(realpathSync(home), realpathSync(root));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`only repos under your home folder can be checked, got ${root}`);
  const report = runDrift(root, doc !== undefined ? { only: doc } : {});
  if (report.docs.length === 0) {
    throw new Error(doc !== undefined ? `no doc "${doc}" in ${root} (try CLAUDE.md or README.md)` : `no CLAUDE.md or README.md in ${root}`);
  }
  return renderDrift(report);
}

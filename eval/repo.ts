import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Works from both the vitest source tree (eval/) and the compiled tree
// (eval/dist/eval/): walk up to the package.json that names the CLI.
function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string };
        if (parsed.name === "@djolex999/vir-cli") return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the vir repo root above ${from}`);
}

export const REPO_ROOT = findRepoRoot(import.meta.dirname);
// The production CLI, built by `npm run build`. Arm homes are populated by
// running IT (`vir embed --setup`, `vir embed --force`) under the arm's HOME —
// the harness never reimplements an embedding write.
export const CLI_JS = join(REPO_ROOT, "dist", "cli.js");
export const ARM_WORKER_JS = join(REPO_ROOT, "eval", "dist", "eval", "armWorker.js");
export const USEFULNESS_WORKER_JS = join(REPO_ROOT, "eval", "dist", "eval", "usefulness", "worker.js");

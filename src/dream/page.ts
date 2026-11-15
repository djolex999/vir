import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";

// Where a project's page lives, and whether `vir dream` owns it. Kept free of
// heavy imports: the distill pass checks it before its auto-summary step.

export function projectPagePath(cfg: Pick<Config, "vaultPath" | "outputDir">, slug: string): string {
  return join(cfg.vaultPath, cfg.outputDir, "projects", `${slug}.md`);
}

export function isDreamPage(file: string): boolean {
  if (!existsSync(file)) return false;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
  return fm !== undefined && /^kind:\s*dream\s*$/m.test(fm);
}

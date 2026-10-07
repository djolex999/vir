import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VIR_DIR } from "../config.js";

export const REPO_URL = "github.com/djolex999/vir";
export const STAR_NUDGE_MARKER = join(VIR_DIR, "first-run-nudge");

export interface StarNudgeContext {
  interactive: boolean;
  distilled: number;
  failed: boolean;
  markerExists: boolean;
}

// Asked once ever, and only right after a run that actually wrote notes —
// never from the daemon, a dry run, a partial mode, or a failed run.
export function shouldShowStarNudge(ctx: StarNudgeContext): boolean {
  return ctx.interactive && ctx.distilled > 0 && !ctx.failed && !ctx.markerExists;
}

export function starNudgeLine(): string {
  return `  first notes written. vir is a one-person project — a star helps others find it: ${REPO_URL}`;
}

export function maybeShowStarNudge(
  ctx: Omit<StarNudgeContext, "markerExists">,
  print: (line: string) => void,
  markerPath: string = STAR_NUDGE_MARKER,
): void {
  if (!shouldShowStarNudge({ ...ctx, markerExists: existsSync(markerPath) })) return;
  print(starNudgeLine());
  try {
    writeFileSync(markerPath, `${new Date().toISOString()}\n`);
  } catch {
    // An unwritable ~/.vir means the line may show again next run — never fail a run over it.
  }
}

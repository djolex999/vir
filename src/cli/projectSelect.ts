import checkbox from "@inquirer/checkbox";
import { readFileSync } from "node:fs";
import {
  CONFIG_PATH,
  ConfigSchema,
  saveConfig,
  type Config,
} from "../config.js";
import type { PendingProjectInfo } from "../pipeline/run.js";
import * as ui from "../ui/display.js";

export interface ProjectChoice {
  name: string;
  value: string;
  checked: boolean;
}

export function buildProjectChoices(
  projects: PendingProjectInfo[],
  existing: Record<string, "include" | "exclude">,
): ProjectChoice[] {
  const nameWidth = Math.min(
    Math.max(...projects.map((p) => p.name.length), 8),
    40,
  );
  // Default is over-capture: everything not explicitly excluded starts
  // CHECKED. Transcripts prune at ~30 days, so an accidental enter that
  // includes too much costs cents; one that excludes too much loses the
  // sessions forever.
  return projects.map((p) => ({
    name: `${p.name.padEnd(nameWidth)}  ${String(p.sessionCount).padStart(3)} session${p.sessionCount === 1 ? " " : "s"}  ~${ui.formatUsd(p.estCost)}`,
    value: p.name,
    checked: existing[p.name] !== "exclude",
  }));
}

// Selected = include, unselected = exclude. Every project SHOWN gets decided —
// that is the point of the triage pass; only projects never shown stay
// undecided.
export function decisionsFromSelection(
  projects: PendingProjectInfo[],
  selected: string[],
): Record<string, "include" | "exclude"> {
  const chosen = new Set(selected);
  const out: Record<string, "include" | "exclude"> = {};
  for (const p of projects) {
    out[p.name] = chosen.has(p.name) ? "include" : "exclude";
  }
  return out;
}

export async function promptProjectDecisions(
  projects: PendingProjectInfo[],
  existing: Record<string, "include" | "exclude">,
  message: string,
): Promise<Record<string, "include" | "exclude">> {
  const selected = await checkbox<string>({
    message,
    choices: buildProjectChoices(projects, existing),
    pageSize: 15,
  });
  return decisionsFromSelection(projects, selected);
}

// Persist decisions by patching the RAW config file, not the loaded Config —
// loadConfig expands ~ paths, and writing those back would bake absolute
// paths into the user's config. Validated through the schema before saving.
export function persistProjectDecisions(
  decisions: Record<string, "include" | "exclude">,
): void {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  raw.projects = {
    ...((raw.projects as Record<string, string> | undefined) ?? {}),
    ...decisions,
  };
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `refusing to save invalid config: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  saveConfig(raw as unknown as Config);
}

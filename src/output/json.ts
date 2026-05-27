/**
 * Machine-readable output contract for programmatic consumers (the vir-obsidian
 * plugin). These two schemas are the entire surface between the CLI and the
 * plugin — keep them pure and stable. The CLI wiring in cli.ts / doctor.ts
 * serializes the output of these builders; this module never touches stdout.
 */
import { relative } from "node:path";
import type { SearchHit } from "../search/retriever.js";

export type VirQueryCategory =
  | "pattern"
  | "gotcha"
  | "decision"
  | "tool"
  | "article";

export interface VirQueryResult {
  path: string; // vault-relative path to the .md file
  score: number;
  category: VirQueryCategory;
  confidence: number;
  preview: string; // first ~200 chars of body, frontmatter stripped, ws-collapsed
  project: string | null;
  date: string; // ISO 8601 (may be date-only)
}

export type VirErrorKind =
  | "ollama_unavailable"
  | "internal"
  | "invalid_args"
  | "no_vault";

export interface VirErrorPayload {
  error: string;
  kind: VirErrorKind;
}

export interface VirDoctorResult {
  daemon: "ok" | "stale" | "down";
  lastPollAt: string | null;
  lastDistillAt: string | null;
  dbSizeMb: number;
  vaultPath: string;
  configValid: boolean;
  ollama: { reachable: boolean; model: string | null };
  version: string;
}

// Vault subdirectory → canonical wire category, used when a note's frontmatter
// lacks an explicit category (older notes) or to collapse article sub-types
// (concept/technique/…) down to the single "article" bucket the contract uses.
const CATEGORY_DIRS: Record<string, VirQueryCategory> = {
  patterns: "pattern",
  gotchas: "gotcha",
  decisions: "decision",
  tools: "tool",
  articles: "article",
};

const WIRE_CATEGORIES = new Set<string>([
  "pattern",
  "gotcha",
  "decision",
  "tool",
  "article",
]);

// Minimal YAML-block parser, kebab-flat. Mirrors mcp/server.ts deliberately —
// the JSON contract is its own isolated surface and must not couple to the MCP
// facade. Notes are emitted by pipeline/writer.ts with quoted string values.
function parseFrontmatter(content: string): Record<string, string> {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  const block = m?.[1];
  if (block === undefined) return {};
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key.length === 0) continue;
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    }
    out[key] = val;
  }
  return out;
}

function excerpt(content: string): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

function categoryOf(
  fm: Record<string, string>,
  relPath: string,
): VirQueryCategory {
  if (fm.type === "article") return "article";
  if (fm.category && WIRE_CATEGORIES.has(fm.category)) {
    return fm.category as VirQueryCategory;
  }
  const dir = relPath.split("/")[0] ?? "";
  return CATEGORY_DIRS[dir] ?? "pattern";
}

// Maps retriever SearchHits (already ordered by score desc) onto the wire
// schema. Pure: derives every field from the hit's path + frontmatter + body.
export function buildQueryResults(
  hits: SearchHit[],
  vaultRoot: string,
): VirQueryResult[] {
  return hits.map((h) => {
    const fm = parseFrontmatter(h.content);
    const relPath = relative(vaultRoot, h.filePath);
    const conf = Number(fm.confidence);
    return {
      path: relPath,
      score: h.score,
      category: categoryOf(fm, relPath),
      confidence: Number.isFinite(conf) ? conf : 0,
      preview: excerpt(h.content),
      project: fm.project && fm.project.length > 0 ? fm.project : null,
      date: fm.date ?? "",
    };
  });
}

export function errorPayload(
  kind: VirErrorKind,
  message: string,
): VirErrorPayload {
  return { error: message, kind };
}

// daemon health: "ok" within 2× the polling interval, "stale" past it, "down"
// when the scheduler is missing or no poll has ever been recorded. Pure so the
// time-window logic is testable without a real clock or scheduler.
export function classifyDaemonHealth(
  installed: boolean,
  lastPollAt: string | null,
  cadenceHours: number,
  now: Date = new Date(),
): "ok" | "stale" | "down" {
  if (!installed || !lastPollAt) return "down";
  const pollMs = Date.parse(lastPollAt);
  if (Number.isNaN(pollMs)) return "down";
  const windowMs = 2 * cadenceHours * 3_600_000;
  return now.getTime() - pollMs <= windowMs ? "ok" : "stale";
}

export interface DoctorInputs {
  daemonInstalled: boolean;
  lastPollAt: string | null;
  lastDistillAt: string | null;
  dbSizeMb: number;
  vaultPath: string;
  configValid: boolean;
  ollamaReachable: boolean;
  ollamaModel: string | null;
  cadenceHours: number;
  version: string;
  now?: Date;
}

export function buildDoctorResult(i: DoctorInputs): VirDoctorResult {
  return {
    daemon: classifyDaemonHealth(
      i.daemonInstalled,
      i.lastPollAt,
      i.cadenceHours,
      i.now,
    ),
    lastPollAt: i.lastPollAt,
    lastDistillAt: i.lastDistillAt,
    dbSizeMb: i.dbSizeMb,
    vaultPath: i.vaultPath,
    configValid: i.configValid,
    ollama: { reachable: i.ollamaReachable, model: i.ollamaModel },
    version: i.version,
  };
}

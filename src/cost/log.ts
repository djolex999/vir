import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import type { Provider } from "./pricing.js";

export const COST_LOG_PATH = join(homedir(), ".vir", "cost.log");

export interface CostRecord {
  ts: string;
  session: string | null;
  project: string | null;
  stage: string;
  model: string;
  provider: Provider;
  input_tokens: number;
  output_tokens: number;
  token_source: "real" | "estimated";
  estimated_cost_usd: number;
}

export function appendCostRecord(rec: CostRecord): void {
  try {
    mkdirSync(dirname(COST_LOG_PATH), { recursive: true });
    appendFileSync(COST_LOG_PATH, JSON.stringify(rec) + "\n", "utf8");
  } catch {
    // best-effort: cost-log failures must never fail a distill
  }
}

export function readCostLog(cutoffMs?: number): CostRecord[] {
  let raw: string;
  try {
    raw = readFileSync(COST_LOG_PATH, "utf8");
  } catch {
    return [];
  }

  const results: CostRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as CostRecord;
      if (cutoffMs !== undefined && new Date(rec.ts).getTime() < cutoffMs) continue;
      results.push(rec);
    } catch {
      // skip malformed lines
    }
  }
  return results;
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

export function parseDuration(s: string): number {
  // Bare integer → days
  if (/^\d+$/.test(s)) {
    return parseInt(s, 10) * UNIT_MS["d"]!;
  }

  const match = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(s);
  if (!match) throw new Error(`invalid duration: ${s}`);

  const value = parseFloat(match[1]!);
  const unit  = match[2]!;
  return value * UNIT_MS[unit]!;
}

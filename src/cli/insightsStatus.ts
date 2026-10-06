import type { InsightRow } from "../connect/types.js";

export interface InsightCounts {
  proposed: number;
  accepted: number;
  awaiting: number; // accepted, not yet promoted or declined in sync-claude
}

export function insightCounts(rows: InsightRow[]): InsightCounts {
  return {
    proposed: rows.filter((r) => r.status === "proposed").length,
    accepted: rows.filter((r) => r.status === "accepted").length,
    awaiting: rows.filter((r) => r.status === "accepted" && r.promotion === "none").length,
  };
}

export function renderInsightsLine(c: InsightCounts): string | null {
  if (c.proposed + c.accepted === 0) return null;
  return `insights: ${c.proposed} proposed · ${c.accepted} accepted · ${c.awaiting} awaiting CLAUDE.md approval`;
}

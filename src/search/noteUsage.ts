import type { QueryHitRecord, QueryLogRecord } from "./queryLog.js";

// Per-note retrieval usage from ~/.vir/queries.jsonl. A "surface" is a note
// appearing in a query's results; it is exposure, not proof the note was used.

export interface NoteUsage {
  surfaced: number;
  // Surfaced at rank 1-3: the hits an agent most likely read.
  top3: number;
  lastSurfacedAt: string;
}

// A query whose text is a note itself (the Obsidian sidebar's related-notes
// lookup sends the open note: its slug, then its body) returns that note at
// rank 1. Counting that hit inflated the most-surfaced list: on the reference
// vault 24 of 26 such queries hit themselves, putting the notes the user
// happened to have open at the top.
export function isSelfHit(query: string, hit: QueryHitRecord): boolean {
  const firstLine = query.trimStart().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine === "") return false;
  const base = hit.slug.slice(hit.slug.lastIndexOf("/") + 1);
  return firstLine === base;
}

export function buildNoteUsage(records: QueryLogRecord[]): Map<string, NoteUsage> {
  const usage = new Map<string, NoteUsage>();
  for (const r of records) {
    for (const h of r.hits) {
      if (isSelfHit(r.query, h)) continue;
      const u = usage.get(h.slug) ?? { surfaced: 0, top3: 0, lastSurfacedAt: r.ts };
      u.surfaced += 1;
      if (h.rank <= 3) u.top3 += 1;
      if (r.ts > u.lastSurfacedAt) u.lastSurfacedAt = r.ts;
      usage.set(h.slug, u);
    }
  }
  return usage;
}

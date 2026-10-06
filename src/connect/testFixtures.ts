import type { InsightRow } from "./types.js";

// Shared test fixture (not a test file, so importing it registers no tests).
export function sampleInsight(over: Partial<InsightRow> = {}): InsightRow {
  return {
    id: "3f9a1c2e-0000-4000-8000-000000000000", slug: "use-proxy-ts-in-next-16-3f9a1c2e",
    insightType: "recurring-rule", status: "proposed", promotion: "none", scope: "global",
    rule: "Use proxy.ts in Next 16", why: "middleware.ts is deprecated and warns.",
    memberSessionIds: ["s1", "s2", "s3"], memberHashes: ["h1", "h2", "h3"],
    sources: ["note-a", "note-b", "note-c"],
    evidence: [
      { sessionId: "s1", citeSlug: "note-a", project: "growthq", date: "2026-06-02", quote: "renames middleware" },
      { sessionId: "s2", citeSlug: "note-b", project: "vir", date: "2026-06-20", quote: "use proxy.ts" },
    ],
    sessions: 3, projects: ["growthq", "vir"], firstSeen: "2026-06-02", lastSeen: "2026-06-20",
    evidenceChanged: false, pending: null, model: "claude-sonnet-5",
    createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z",
    ...over,
  };
}

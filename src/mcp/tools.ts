// The tools `vir mcp` exposes. `vir mcp install` prints this list and the
// server registers exactly these — a test pins the two together, because the
// printed list had quietly drifted two tools behind the server.
export const VIR_TOOLS = [
  "vir_query",
  "vir_status",
  "vir_recent_notes",
  "vir_recent_articles",
  "vir_project_summary",
  "vir_compose",
] as const;

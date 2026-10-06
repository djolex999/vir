import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { kebab } from "../pipeline/slug.js";
import { ruleText } from "./text.js";
import type { InsightRow } from "./types.js";

export const INSIGHTS_RULES_DIR = "insights/rules";

export function insightSlug(rule: string, id: string): string {
  const base = kebab(rule).slice(0, 60).replace(/-+$/, "");
  const suffix = id.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return base.length > 0 ? `${base}-${suffix}` : `rule-${suffix}`;
}

const q = (s: string): string => JSON.stringify(s);

export function renderInsight(row: InsightRow): string {
  const fm = [
    "---",
    "type: insight",
    `insight_type: ${row.insightType}`,
    `status: ${row.status}`,
    `promotion: ${row.promotion}`,
    `verified: ${row.status === "accepted"}`,
    `scope: ${row.scope}`,
    `sessions: ${row.sessions}`,
    `projects: [${row.projects.map(q).join(", ")}]`,
    `first_seen: ${row.firstSeen.slice(0, 10)}`,
    `last_seen: ${row.lastSeen.slice(0, 10)}`,
    "sources:",
    ...row.sources.map((s) => `  - ${q(`[[${s}]]`)}`),
    `generated: ${row.createdAt}`,
    `model: ${row.model}`,
    "---",
  ];
  const evidence = row.evidence.map(
    (e) => `- [[${e.citeSlug}]] (${e.project || "-"}, ${e.date.slice(0, 10)}${e.merged ? ", merged" : ""}): ${q(e.quote)}`,
  );
  return [
    ...fm,
    `**Rule:** ${row.rule}`,
    "",
    `**Why:** ${row.why}`,
    "",
    "## Evidence",
    "",
    ...evidence,
    "",
  ].join("\n");
}

// The owner edits only the **Rule:** and **Why:** lines; everything else is
// re-rendered from the DB on the next state write.
export function parseRuleEdit(raw: string): { rule: string; why: string } | null {
  const rule = ruleText(raw.match(/^\*\*Rule:\*\*[ \t]*(.+)$/m)?.[1] ?? "");
  if (rule.length === 0) return null;
  const why = ruleText(raw.match(/^\*\*Why:\*\*[ \t]*(.+)$/m)?.[1] ?? "");
  return { rule, why };
}

export function writeInsightFile(vaultRoot: string, row: InsightRow): string {
  const path = join(vaultRoot, INSIGHTS_RULES_DIR, `${row.slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.vir-${process.pid}.tmp`;
  writeFileSync(tmp, renderInsight(row));
  renameSync(tmp, path);
  return path;
}

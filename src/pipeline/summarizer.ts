import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { DistilledRow, StateDb } from "../state/db.js";
import {
  buildAnthropicClient,
  callLLM,
  normalizeModelName,
  withRateLimitRetry,
} from "./distiller.js";
import type { Category } from "./types.js";
import { kebab } from "./writer.js";

const EXCERPT_LEN = 200;
const CHANGELOG_HEADER = "## Changelog";

export interface ProjectGroup {
  slug: string;
  displayName: string;
  rows: DistilledRow[];
}

export interface ProjectCounts {
  patterns: number;
  gotchas: number;
  decisions: number;
  tools: number;
  total: number;
}

export function groupByProject(rows: DistilledRow[]): Map<string, ProjectGroup> {
  const out = new Map<string, ProjectGroup>();
  for (const r of rows) {
    const slug = kebab(r.project);
    if (slug.length === 0) continue;
    let g = out.get(slug);
    if (!g) {
      g = { slug, displayName: r.project, rows: [] };
      out.set(slug, g);
    }
    g.rows.push(r);
  }
  return out;
}

export function countByCategory(rows: DistilledRow[]): ProjectCounts {
  let patterns = 0,
    gotchas = 0,
    decisions = 0,
    tools = 0;
  for (const r of rows) {
    if (r.category === "pattern") patterns += 1;
    else if (r.category === "gotcha") gotchas += 1;
    else if (r.category === "decision") decisions += 1;
    else if (r.category === "tool") tools += 1;
  }
  return { patterns, gotchas, decisions, tools, total: rows.length };
}

export async function summarizeProject(
  cfg: Config,
  projectSlug: string,
  db: StateDb,
): Promise<{ slug: string; path: string; counts: ProjectCounts } | null> {
  const allRows = db.listDistilled();
  const grouped = groupByProject(allRows);
  const group = grouped.get(projectSlug);
  if (!group || group.rows.length === 0) return null;

  const counts = countByCategory(group.rows);
  const prompt = buildPrompt(group, counts);

  const client = buildAnthropicClient(cfg);
  const model = normalizeModelName(cfg.models.distill, cfg.provider);
  const body = await withRateLimitRetry(() =>
    callLLM(cfg, client, { prompt, model, maxTokens: 1500 }),
  );

  const outPath = writeSummaryFile(cfg, projectSlug, body.trim(), counts);
  return { slug: projectSlug, path: outPath, counts };
}

export async function summarizeAll(
  cfg: Config,
  db: StateDb,
): Promise<Array<{ slug: string; path: string; counts: ProjectCounts }>> {
  const grouped = groupByProject(db.listDistilled());
  const results: Array<{ slug: string; path: string; counts: ProjectCounts }> =
    [];
  for (const slug of grouped.keys()) {
    const res = await summarizeProject(cfg, slug, db);
    if (res) results.push(res);
  }
  return results;
}

function buildPrompt(group: ProjectGroup, counts: ProjectCounts): string {
  const byCat: Record<Category, DistilledRow[]> = {
    pattern: [],
    gotcha: [],
    decision: [],
    tool: [],
  };
  for (const r of group.rows) byCat[r.category].push(r);

  const renderList = (rows: DistilledRow[]): string => {
    if (rows.length === 0) return "(none)";
    return rows
      .map((r) => {
        const excerpt = r.content
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, EXCERPT_LEN);
        return `- ${r.topic}: ${excerpt}`;
      })
      .join("\n");
  };

  return `You are synthesizing a project knowledge summary from distilled Claude Code session notes.

Project: ${group.slug}
Total sessions: ${counts.total}

Patterns (${counts.patterns}):
${renderList(byCat.pattern)}

Gotchas (${counts.gotchas}):
${renderList(byCat.gotcha)}

Decisions (${counts.decisions}):
${renderList(byCat.decision)}

Tools (${counts.tools}):
${renderList(byCat.tool)}

Write a project summary with these exact sections:
## Overview
2-3 sentences: what this project is, what stack/approach dominates

## Key Patterns
Bullet list of the most reusable patterns, 1 sentence each

## Watch Out For
Bullet list of the most important gotchas, 1 sentence each

## Architecture Decisions
Bullet list of significant decisions made, 1 sentence each

## Knowledge Gaps
1-2 sentences: what topics appear underrepresented or missing

Be specific and direct. Use the actual topic names.`;
}

function writeSummaryFile(
  cfg: Config,
  projectSlug: string,
  body: string,
  counts: ProjectCounts,
): string {
  const dir = join(cfg.vaultPath, cfg.outputDir, "projects");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${projectSlug}.md`);

  const generated = new Date().toISOString();
  const date = generated.slice(0, 10);
  const newEntry = `- ${date}: ${counts.total} sessions, ${counts.patterns} patterns, ${counts.gotchas} gotchas, ${counts.decisions} decisions, ${counts.tools} tools`;

  const existingChangelog = readExistingChangelog(filePath);
  const changelog = [CHANGELOG_HEADER, newEntry, ...existingChangelog].join("\n");

  const frontmatter = [
    "---",
    `project: ${projectSlug}`,
    `generated: ${generated}`,
    `sessions: ${counts.total}`,
    "---",
    "",
    `Project: [[${projectSlug}]]`,
    "",
  ].join("\n");

  const content = `${frontmatter}${body}\n\n---\n${changelog}\n`;
  writeFileSync(filePath, content);
  return filePath;
}

// Returns the existing changelog entries (the lines after `## Changelog`),
// excluding the header itself. Empty array if file is missing or has no
// changelog section yet.
function readExistingChangelog(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const idx = raw.indexOf(CHANGELOG_HEADER);
  if (idx === -1) return [];
  const rest = raw.slice(idx + CHANGELOG_HEADER.length).trim();
  if (rest.length === 0) return [];
  return rest.split("\n").filter((l) => l.trim().length > 0);
}

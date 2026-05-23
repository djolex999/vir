/**
 * vir MCP server — exposes the distilled knowledge vault to MCP clients
 * (Claude Code) as queryable tools over stdio.
 *
 * Register with Claude Code by adding to ~/.claude/claude_desktop_config.json:
 *
 *   {
 *     "mcpServers": {
 *       "vir": {
 *         "command": "vir",
 *         "args": ["mcp"]
 *       }
 *     }
 *   }
 *
 * After restarting Claude Code, the agent can call vir_query, vir_status,
 * vir_recent_notes, and vir_project_summary as tools.
 *
 * Transport is stdio: stdout is reserved for the MCP JSON-RPC protocol, so
 * every log line goes to stderr. The SQLite DB is opened read-only — this
 * server is a thin facade over the existing search/summarize modules and
 * must never mutate state.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exit } from "node:process";
import { z } from "zod";
import { STATE_PATH, type Config } from "../config.js";
import type { Category } from "../pipeline/types.js";
import { kebab } from "../pipeline/writer.js";
import { search, type SearchHit } from "../search/retriever.js";
import { synthesize } from "../search/synthesizer.js";
import { StateDb } from "../state/db.js";

const CATEGORIES = ["pattern", "gotcha", "decision", "tool"] as const;

// Maps the vault subdirectory back to the canonical category, used as a
// fallback when a hit's frontmatter is missing (e.g. older notes).
const CATEGORY_DIRS: Record<string, Category> = {
  patterns: "pattern",
  gotchas: "gotcha",
  decisions: "decision",
  tools: "tool",
};

function log(msg: string): void {
  process.stderr.write(`[vir-mcp] ${msg}\n`);
}

function ok(payload: unknown) {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// Notes carry their classification in YAML frontmatter (see pipeline/writer.ts).
// SearchHit only exposes title/content/score, so parse the frontmatter back to
// recover category/project without a second DB round-trip.
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

function categoryFromTitle(title: string): string {
  const dir = title.split("/")[0] ?? "";
  return CATEGORY_DIRS[dir] ?? "";
}

function hitMeta(hit: SearchHit): {
  topic: string;
  category: string;
  project: string;
} {
  const fm = parseFrontmatter(hit.content);
  const base = hit.title.split("/").pop() ?? hit.title;
  return {
    topic: fm.topic ?? base,
    category: fm.category ?? categoryFromTitle(hit.title),
    project: fm.project ?? "",
  };
}

function excerpt(content: string): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

export async function runMcpServer(cfg: Config): Promise<void> {
  let db: StateDb;
  try {
    db = new StateDb(STATE_PATH, { readonly: true });
  } catch (err) {
    log(`could not open ${STATE_PATH} read-only: ${(err as Error).message}`);
    log("run `vir run --full` first to build the knowledge database.");
    exit(1);
  }

  const server = new McpServer({ name: "vir", version: "0.1.1" });

  server.registerTool(
    "vir_query",
    {
      description:
        "Search the knowledge vault for patterns, gotchas, decisions, and " +
        "tool insights from past Claude Code sessions. Use this before " +
        "working on a task to consult prior learnings.",
      inputSchema: {
        query: z.string().describe("The question or topic to search for"),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("Number of notes to retrieve (default 5, max 10)"),
        category: z
          .enum(CATEGORIES)
          .optional()
          .describe("Restrict results to one category"),
        project: z
          .string()
          .optional()
          .describe("Restrict results to one project slug"),
      },
    },
    async ({ query, top_k, category, project }) => {
      try {
        const topK = Math.min(Math.max(top_k ?? 5, 1), 10);
        const hasFilter = Boolean(category || project);
        // Over-fetch when filtering so post-filtering can still fill top_k.
        const fetchK = hasFilter ? Math.min(30, topK * 5) : topK;
        const projSlug = project ? kebab(project) : null;

        const hits = await search(cfg, db, query, fetchK);
        const selected = hits
          .filter((h) => {
            const meta = hitMeta(h);
            if (category && meta.category !== category) return false;
            if (projSlug && kebab(meta.project) !== projSlug) return false;
            return true;
          })
          .slice(0, topK);

        if (selected.length === 0) {
          return ok({
            answer: "No matching notes found in the vault.",
            sources: [],
          });
        }

        const answer = await synthesize(cfg, query, selected);
        const sources = selected.map((h) => {
          const meta = hitMeta(h);
          return {
            topic: meta.topic,
            category: meta.category,
            project: meta.project,
            score: h.score,
            file: h.title,
          };
        });
        return ok({ answer: answer.trim(), sources });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "vir_status",
    {
      description:
        "Get an overview of the user's knowledge vault: total notes, " +
        "projects, categories, confidence distribution. Use this to " +
        "understand what the user knows about and where gaps might exist.",
      inputSchema: {},
    },
    async () => {
      try {
        const k = db.getStats();
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const projects = Object.entries(k.byProject)
          .sort((a, b) => b[1].total - a[1].total)
          .map(([name, p]) => ({
            name,
            total: p.total,
            patterns: p.patterns,
            gotchas: p.gotchas,
            decisions: p.decisions,
            tools: p.tools,
            avgConfidence: round2(p.avgConfidence),
            lastSeen: p.lastSeen || null,
          }));

        const gaps: string[] = [];
        for (const p of projects) {
          if (p.total === 0) continue;
          if (p.gotchas === 0) gaps.push(`${p.name}: no gotchas recorded`);
          if (p.decisions === 0) {
            gaps.push(`${p.name}: no architecture decisions recorded`);
          }
          if (p.avgConfidence < 0.65) {
            gaps.push(
              `${p.name}: low average confidence (${p.avgConfidence.toFixed(2)})`,
            );
          }
        }

        return ok({
          totalNotes: k.total,
          avgConfidence: round2(k.avgConfidence),
          confidence: { high: k.highConf, low: k.lowConf },
          categories: k.byCategory,
          projects,
          dateRange: {
            oldest: k.oldestNote || null,
            newest: k.newestNote || null,
          },
          gaps,
        });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "vir_recent_notes",
    {
      description:
        "Get the most recently distilled knowledge from Claude Code " +
        "sessions. Use this to see what the user has been working on lately.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max notes to return (default 10, max 20)"),
        category: z.enum(CATEGORIES).optional(),
        project: z.string().optional().describe("Project slug filter"),
        since_days: z
          .number()
          .positive()
          .optional()
          .describe("Only notes from the last N days"),
      },
    },
    async ({ limit, category, project, since_days }) => {
      try {
        const max = Math.min(Math.max(limit ?? 10, 1), 20);
        const projSlug = project ? kebab(project) : null;
        const cutoff =
          typeof since_days === "number"
            ? Date.now() - since_days * 86_400_000
            : null;

        const notes = db
          .listDistilled()
          .filter((r) => {
            if (category && r.category !== category) return false;
            if (projSlug && kebab(r.project) !== projSlug) return false;
            if (cutoff !== null) {
              if (!r.startedAt) return false;
              const t = Date.parse(r.startedAt);
              if (!Number.isFinite(t) || t < cutoff) return false;
            }
            return true;
          })
          .sort((a, b) => {
            const ta = a.startedAt ? Date.parse(a.startedAt) : 0;
            const tb = b.startedAt ? Date.parse(b.startedAt) : 0;
            return tb - ta;
          })
          .slice(0, max)
          .map((r) => ({
            topic: r.topic,
            category: r.category,
            project: r.project,
            confidence: r.confidence,
            date: r.startedAt,
            summary: excerpt(r.content),
          }));

        return ok(notes);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "vir_project_summary",
    {
      description:
        "Get a synthesized summary of what the user has learned about a " +
        "specific project. Includes key patterns, gotchas, decisions, and " +
        "tools.",
      inputSchema: {
        project: z.string().describe("Project slug, e.g. 'growthq'"),
      },
    },
    async ({ project }) => {
      try {
        const slug = kebab(project);
        const file = join(
          cfg.vaultPath,
          cfg.outputDir,
          "projects",
          `${slug}.md`,
        );

        // Read-only facade: never generate a summary here — that's an LLM
        // call and a vault write. If it isn't cached, point the user at the
        // CLI command that produces it under explicit intent.
        if (!existsSync(file)) {
          return ok({
            error: `Project summary not yet generated. Run: vir summarize ${slug}`,
            project_slug: slug,
          });
        }

        const content = readFileSync(file, "utf8");
        const fm = parseFrontmatter(content);
        return ok({
          project: slug,
          content,
          sessions_count: fm.sessions ? Number(fm.sessions) : null,
          generated: fm.generated ?? null,
        });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("vir MCP server ready on stdio (4 tools)");

  const shutdown = async (sig: string): Promise<void> => {
    log(`received ${sig}, shutting down`);
    try {
      await server.close();
    } catch {
      // best-effort
    }
    try {
      db.close();
    } catch {
      // best-effort
    }
    exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

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
import { composeSlug, TOPICS_SUBDIR } from "../pipeline/composer.js";
import type { Category } from "../pipeline/types.js";
import { kebab, makeSlug } from "../pipeline/writer.js";
import { search, type SearchHit } from "../search/retriever.js";
import { synthesize } from "../search/synthesizer.js";
import { StateDb } from "../state/db.js";

const CATEGORIES = ["pattern", "gotcha", "decision", "tool"] as const;
const ARTICLE_CATEGORIES = [
  "concept",
  "technique",
  "reference",
  "opinion",
] as const;
export const QUERY_TYPES = [
  "session",
  "article",
  "topic",
  "pdf",
  "all",
] as const;

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

export function hitMeta(hit: SearchHit): {
  topic: string;
  category: string;
  project: string;
  type: "session" | "article" | "topic" | "pdf";
  url?: string;
} {
  const fm = parseFrontmatter(hit.content);
  const base = hit.title.split("/").pop() ?? hit.title;
  if (fm.type === "article") {
    return {
      topic: fm.source_title ?? base,
      category: fm.category ?? "",
      project: fm.source_author ?? "",
      type: "article",
      url: fm.source_url,
    };
  }
  // PDFs carry `type: pdf` + `source_title` + the pdf sub-taxonomy in `category`
  // (paper/reference/notes/other); project is empty (a PDF has no project).
  if (fm.type === "pdf") {
    return {
      topic: fm.source_title ?? base,
      category: fm.category ?? "",
      project: "",
      type: "pdf",
    };
  }
  // Topic pages (`vir compose`) carry `type: topic` and a synthesized title but
  // no category/project — the fixed "topic" taxonomy mirrors buildQueryResults
  // so the `type: topic` query filter actually matches them.
  if (fm.type === "topic") {
    return {
      topic: fm.title ?? base,
      category: "topic",
      project: "",
      type: "topic",
    };
  }
  return {
    topic: fm.topic ?? base,
    category: fm.category ?? categoryFromTitle(hit.title),
    project: fm.project ?? "",
    type: "session",
  };
}

// Pure lookup behind vir_compose. Given the topic and a reader that returns the
// cached topic file's content (or null if absent), produce the MCP payload.
// Read-only by design: synthesis (an LLM call + vault write + db upsert) only
// runs via the CLI `vir compose`, so a missing page returns a pointer to that
// command — mirroring vir_project_summary's cached-or-pointer contract rather
// than spending tokens or writing from a read-only server. Pure (I/O injected)
// so both branches are unit-testable without the SDK transport.
export function composeLookup(
  topic: string,
  read: (slug: string) => string | null,
): Record<string, unknown> {
  const slug = composeSlug(topic);
  const content = read(slug);
  if (content === null) {
    return {
      error: `Topic page not yet composed. Run: vir compose "${topic}"`,
      topic_slug: slug,
    };
  }
  const fm = parseFrontmatter(content);
  return {
    topic: slug,
    title: fm.title ?? slug,
    content,
    confidence: fm.confidence ? Number(fm.confidence) : null,
    model: fm.model ?? null,
    created: fm.created ?? null,
    updated: fm.updated ?? null,
  };
}

function excerpt(content: string): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

function isVerifiedContent(content: string): boolean {
  return parseFrontmatter(content).verified === "true";
}

// Verified status lives in the note file's frontmatter, not SQLite — so a
// DB-backed lister (vir_recent_notes) must reconstruct the path and read it.
function noteIsVerified(vaultRoot: string, dir: string, fileBase: string): boolean {
  try {
    const fp = join(vaultRoot, dir, fileBase);
    return existsSync(fp) && isVerifiedContent(readFileSync(fp, "utf8"));
  } catch {
    return false;
  }
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
        "tool insights from past Claude Code sessions, concepts, techniques, " +
        "references, and opinions distilled from web articles, and notes " +
        "distilled from PDFs/papers. " +
        "Use this before working on a task to consult prior learnings. " +
        "Human-verified notes (approved via `vir review`) are ranked above " +
        "unverified ones.",
      inputSchema: {
        query: z.string().describe("The question or topic to search for"),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("Number of notes to retrieve (default 5, max 10)"),
        type: z
          .enum(QUERY_TYPES)
          .optional()
          .describe(
            "Restrict to 'session' notes (Claude Code), 'article' notes " +
              "(web articles), 'topic' pages (synthesized via `vir compose`), " +
              "'pdf' notes (distilled papers/PDFs), or 'all' (default).",
          ),
        category: z
          .enum(CATEGORIES)
          .optional()
          .describe("Restrict results to one session category"),
        project: z
          .string()
          .optional()
          .describe("Restrict results to one project slug"),
        verified_only: z
          .boolean()
          .optional()
          .describe(
            "Return only human-verified notes (approved via `vir review`). " +
              "Default false.",
          ),
      },
    },
    async ({ query, top_k, type, category, project, verified_only }) => {
      try {
        const topK = Math.min(Math.max(top_k ?? 5, 1), 10);
        const typeFilter = type ?? "all";
        const hasFilter = Boolean(
          category || project || verified_only || typeFilter !== "all",
        );
        // Over-fetch when filtering so post-filtering can still fill top_k.
        const fetchK = hasFilter ? Math.min(30, topK * 5) : topK;
        const projSlug = project ? kebab(project) : null;

        const hits = await search(cfg, db, query, fetchK);
        const selected = hits
          .filter((h) => {
            const meta = hitMeta(h);
            if (typeFilter !== "all" && meta.type !== typeFilter) return false;
            if (category && meta.category !== category) return false;
            if (projSlug && kebab(meta.project) !== projSlug) return false;
            if (verified_only && !isVerifiedContent(h.content)) return false;
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
            type: meta.type,
            ...(meta.url ? { url: meta.url } : {}),
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
        verified_only: z
          .boolean()
          .optional()
          .describe(
            "Return only human-verified notes (approved via `vir review`). " +
              "Default false.",
          ),
      },
    },
    async ({ limit, category, project, since_days, verified_only }) => {
      try {
        const max = Math.min(Math.max(limit ?? 10, 1), 20);
        const projSlug = project ? kebab(project) : null;
        const cutoff =
          typeof since_days === "number"
            ? Date.now() - since_days * 86_400_000
            : null;
        const vaultRoot = join(cfg.vaultPath, cfg.outputDir);

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
            if (
              verified_only &&
              !noteIsVerified(
                vaultRoot,
                `${r.category}s`,
                `${makeSlug(r.topic, r.sessionId)}.md`,
              )
            ) {
              return false;
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
    "vir_recent_articles",
    {
      description:
        "Get the most recently distilled web articles (clipped via Obsidian " +
        "Web Clipper or saved as markdown). Use this to see what the user has " +
        "been reading and saving, with source URLs for follow-up.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max articles to return (default 10, max 20)"),
        category: z
          .enum(ARTICLE_CATEGORIES)
          .optional()
          .describe("Restrict to one article category"),
        since_days: z
          .number()
          .positive()
          .optional()
          .describe("Only articles from the last N days"),
      },
    },
    async ({ limit, category, since_days }) => {
      try {
        const max = Math.min(Math.max(limit ?? 10, 1), 20);
        const cutoff =
          typeof since_days === "number"
            ? Date.now() - since_days * 86_400_000
            : null;
        const dateOf = (a: { published: string | null; distilledAt: string | null }) => {
          const raw = a.published ?? a.distilledAt;
          const t = raw ? Date.parse(raw) : NaN;
          return Number.isFinite(t) ? t : 0;
        };

        const articles = db
          .listArticles()
          .filter((a) => {
            if (category && a.category !== category) return false;
            if (cutoff !== null && dateOf(a) < cutoff) return false;
            return true;
          })
          .sort((a, b) => dateOf(b) - dateOf(a))
          .slice(0, max)
          .map((a) => ({
            title: a.title,
            category: a.category,
            url: a.url,
            author: a.author,
            published: a.published,
            confidence: a.confidence,
            summary: excerpt(a.content),
          }));

        return ok(articles);
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

  server.registerTool(
    "vir_compose",
    {
      description:
        "Fetch a synthesized topic page — one reference woven from related " +
        "session and article notes via `vir compose`. Returns the cached page " +
        "if it exists; otherwise points to the CLI command that generates it. " +
        "Synthesis is an LLM call plus a vault write, which this read-only " +
        "server never performs — so a missing topic is created from the CLI.",
      inputSchema: {
        topic: z
          .string()
          .describe("The topic to fetch a composed page for"),
      },
    },
    async ({ topic }) => {
      try {
        const topicsDir = cfg.topicsDir ?? TOPICS_SUBDIR;
        return ok(
          composeLookup(topic, (slug) => {
            const file = join(
              cfg.vaultPath,
              cfg.outputDir,
              topicsDir,
              `${slug}.md`,
            );
            return existsSync(file) ? readFileSync(file, "utf8") : null;
          }),
        );
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("vir MCP server ready on stdio (6 tools)");

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

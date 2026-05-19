import Database from "better-sqlite3";
import { dirname } from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { LEGACY_STATE_PATH, STATE_PATH } from "../config.js";
import type { Category } from "../pipeline/types.js";

export interface SessionRow {
  path: string;
  hash: string;
  processed_at: string;
  skipped: number;
  note_paths: string;
  error: string | null;
  content: string | null;
  category: string | null;
  topic: string | null;
  project: string | null;
  confidence: number | null;
  started_at: string | null;
}

export interface EmbeddingRow {
  sessionId: string;
  topic: string;
  category: string;
  project: string;
  filePath: string;
  embedding: number[];
}

export interface ProjectStats {
  total: number;
  patterns: number;
  gotchas: number;
  decisions: number;
  tools: number;
  avgConfidence: number;
  lastSeen: string;
}

export interface KnowledgeStats {
  total: number;
  byProject: Record<string, ProjectStats>;
  byCategory: Record<string, number>;
  avgConfidence: number;
  highConf: number;
  lowConf: number;
  oldestNote: string;
  newestNote: string;
}

export interface DistilledRow {
  path: string;
  sessionId: string;
  startedAt: string | null;
  category: Category;
  topic: string;
  project: string;
  confidence: number;
  content: string;
}

interface ColumnInfo {
  name: string;
}

const ADDED_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "content", ddl: "ALTER TABLE sessions ADD COLUMN content TEXT" },
  { name: "category", ddl: "ALTER TABLE sessions ADD COLUMN category TEXT" },
  { name: "topic", ddl: "ALTER TABLE sessions ADD COLUMN topic TEXT" },
  { name: "project", ddl: "ALTER TABLE sessions ADD COLUMN project TEXT" },
  {
    name: "confidence",
    ddl: "ALTER TABLE sessions ADD COLUMN confidence REAL",
  },
  {
    name: "started_at",
    ddl: "ALTER TABLE sessions ADD COLUMN started_at TEXT",
  },
  {
    name: "archived",
    ddl: "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
  },
  { name: "embedding", ddl: "ALTER TABLE sessions ADD COLUMN embedding TEXT" },
];

export class StateDb {
  private db: Database.Database;

  constructor(path: string = STATE_PATH) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // One-shot rename: docs always referred to vir.db, but earlier builds
    // wrote to state.db. Migrate transparently so deleting `vir.db` does
    // what the user expects.
    if (
      path === STATE_PATH &&
      !existsSync(STATE_PATH) &&
      existsSync(LEGACY_STATE_PATH)
    ) {
      try {
        renameSync(LEGACY_STATE_PATH, STATE_PATH);
      } catch {
        // If rename fails (cross-device, perms), fall through — better-sqlite3
        // will simply open a fresh DB at STATE_PATH.
      }
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        skipped INTEGER NOT NULL DEFAULT 0,
        note_paths TEXT NOT NULL DEFAULT '[]',
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(hash);
    `);
    this.migrate();
  }

  private migrate(): void {
    const rows = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all() as ColumnInfo[];
    const existing = new Set(rows.map((r) => r.name));
    for (const col of ADDED_COLUMNS) {
      if (!existing.has(col.name)) this.db.exec(col.ddl);
    }
  }

  getByPath(path: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE path = ?")
      .get(path) as SessionRow | undefined;
  }

  isProcessed(path: string, hash: string): boolean {
    const row = this.getByPath(path);
    return row !== undefined && row.hash === hash;
  }

  record(opts: {
    path: string;
    hash: string;
    skipped: boolean;
    notePaths: string[];
    error?: string | null;
    content?: string | null;
    category?: string | null;
    topic?: string | null;
    project?: string | null;
    confidence?: number | null;
    startedAt?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (
           path, hash, processed_at, skipped, note_paths, error,
           content, category, topic, project, confidence, started_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           hash = excluded.hash,
           processed_at = excluded.processed_at,
           skipped = excluded.skipped,
           note_paths = excluded.note_paths,
           error = excluded.error,
           content = COALESCE(excluded.content, sessions.content),
           category = COALESCE(excluded.category, sessions.category),
           topic = COALESCE(excluded.topic, sessions.topic),
           project = COALESCE(excluded.project, sessions.project),
           confidence = COALESCE(excluded.confidence, sessions.confidence),
           started_at = COALESCE(excluded.started_at, sessions.started_at)`,
      )
      .run(
        opts.path,
        opts.hash,
        new Date().toISOString(),
        opts.skipped ? 1 : 0,
        JSON.stringify(opts.notePaths),
        opts.error ?? null,
        opts.content ?? null,
        opts.category ?? null,
        opts.topic ?? null,
        opts.project ?? null,
        opts.confidence ?? null,
        opts.startedAt ?? null,
      );
  }

  listDistilled(): DistilledRow[] {
    const rows = this.db
      .prepare(
        `SELECT path, content, category, topic, project, confidence, started_at
         FROM sessions
         WHERE skipped = 0
           AND error IS NULL
           AND content IS NOT NULL
           AND category IS NOT NULL
           AND topic IS NOT NULL
           AND COALESCE(archived, 0) = 0`,
      )
      .all() as Array<{
      path: string;
      content: string;
      category: string;
      topic: string;
      project: string | null;
      confidence: number | null;
      started_at: string | null;
    }>;
    return rows.map((r) => ({
      path: r.path,
      sessionId: deriveSessionId(r.path),
      startedAt: r.started_at,
      category: r.category as Category,
      topic: r.topic,
      project: r.project ?? "",
      confidence: r.confidence ?? 0,
      content: r.content,
    }));
  }

  stats(): {
    total: number;
    skipped: number;
    distilled: number;
    errored: number;
    lastRun: string | null;
  } {
    const total = (
      this.db.prepare("SELECT COUNT(*) as c FROM sessions").get() as {
        c: number;
      }
    ).c;
    const skipped = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM sessions WHERE skipped = 1")
        .get() as { c: number }
    ).c;
    const errored = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM sessions WHERE error IS NOT NULL")
        .get() as { c: number }
    ).c;
    const lastRow = this.db
      .prepare(
        "SELECT processed_at FROM sessions ORDER BY processed_at DESC LIMIT 1",
      )
      .get() as { processed_at: string } | undefined;
    return {
      total,
      skipped,
      distilled: total - skipped - errored,
      errored,
      lastRun: lastRow?.processed_at ?? null,
    };
  }

  getStats(): KnowledgeStats {
    const rows = this.db
      .prepare(
        `SELECT category, project, confidence, started_at
         FROM sessions
         WHERE skipped = 0
           AND error IS NULL
           AND content IS NOT NULL
           AND COALESCE(archived, 0) = 0`,
      )
      .all() as Array<{
      category: string | null;
      project: string | null;
      confidence: number | null;
      started_at: string | null;
    }>;

    const byProject: Record<string, ProjectStats> = {};
    const byCategory: Record<string, number> = {
      pattern: 0,
      gotcha: 0,
      decision: 0,
      tool: 0,
    };
    let confSum = 0;
    let confCount = 0;
    let highConf = 0;
    let lowConf = 0;
    let oldest: string | null = null;
    let newest: string | null = null;

    const projectConfSum: Record<string, number> = {};
    const projectConfCount: Record<string, number> = {};

    for (const r of rows) {
      const cat = r.category ?? "";
      const proj = r.project ?? "unknown";
      const conf = typeof r.confidence === "number" ? r.confidence : 0;
      const started = r.started_at;

      if (cat in byCategory) byCategory[cat] = (byCategory[cat] ?? 0) + 1;

      let p = byProject[proj];
      if (!p) {
        p = {
          total: 0,
          patterns: 0,
          gotchas: 0,
          decisions: 0,
          tools: 0,
          avgConfidence: 0,
          lastSeen: "",
        };
        byProject[proj] = p;
        projectConfSum[proj] = 0;
        projectConfCount[proj] = 0;
      }
      p.total += 1;
      if (cat === "pattern") p.patterns += 1;
      else if (cat === "gotcha") p.gotchas += 1;
      else if (cat === "decision") p.decisions += 1;
      else if (cat === "tool") p.tools += 1;
      projectConfSum[proj] = (projectConfSum[proj] ?? 0) + conf;
      projectConfCount[proj] = (projectConfCount[proj] ?? 0) + 1;
      if (started && (p.lastSeen === "" || started > p.lastSeen)) {
        p.lastSeen = started;
      }

      confSum += conf;
      confCount += 1;
      if (conf >= 0.8) highConf += 1;
      if (conf < 0.5) lowConf += 1;

      if (started) {
        if (oldest === null || started < oldest) oldest = started;
        if (newest === null || started > newest) newest = started;
      }
    }

    for (const proj of Object.keys(byProject)) {
      const sum = projectConfSum[proj] ?? 0;
      const n = projectConfCount[proj] ?? 0;
      const p = byProject[proj];
      if (p) p.avgConfidence = n > 0 ? sum / n : 0;
    }

    return {
      total: confCount,
      byProject,
      byCategory,
      avgConfidence: confCount > 0 ? confSum / confCount : 0,
      highConf,
      lowConf,
      oldestNote: oldest ?? "",
      newestNote: newest ?? "",
    };
  }

  // Embedding storage is keyed by sessionId (the JSONL basename), since callers
  // typically have that handy and not the full path. Match suffix-anchored:
  // `path LIKE '%/<sessionId>.jsonl'`.
  storeEmbedding(sessionId: string, embedding: number[]): void {
    this.db
      .prepare("UPDATE sessions SET embedding = ? WHERE path LIKE ?")
      .run(JSON.stringify(embedding), `%/${sessionId}.jsonl`);
  }

  getEmbeddings(vaultRoot: string): EmbeddingRow[] {
    const rows = this.db
      .prepare(
        `SELECT path, embedding, topic, category, project
         FROM sessions
         WHERE skipped = 0
           AND error IS NULL
           AND embedding IS NOT NULL
           AND COALESCE(archived, 0) = 0
           AND topic IS NOT NULL
           AND category IS NOT NULL`,
      )
      .all() as Array<{
      path: string;
      embedding: string;
      topic: string;
      category: string;
      project: string | null;
    }>;

    const out: EmbeddingRow[] = [];
    for (const r of rows) {
      let vec: number[];
      try {
        const parsed = JSON.parse(r.embedding) as unknown;
        if (!Array.isArray(parsed)) continue;
        vec = parsed.map((x) => Number(x));
        if (vec.some((n) => !Number.isFinite(n))) continue;
      } catch {
        continue;
      }
      const sessionId = deriveSessionId(r.path);
      const slug = kebabLite(r.topic);
      const suffix = sessionId.slice(0, 8);
      const dir = `${r.category}s`;
      const filePath = `${vaultRoot}/${dir}/${slug}-${suffix}.md`;
      out.push({
        sessionId,
        topic: r.topic,
        category: r.category,
        project: r.project ?? "",
        filePath,
        embedding: vec,
      });
    }
    return out;
  }

  archive(path: string): void {
    this.db
      .prepare("UPDATE sessions SET archived = 1 WHERE path = ?")
      .run(path);
  }

  updateContent(path: string, content: string): void {
    this.db
      .prepare("UPDATE sessions SET content = ? WHERE path = ?")
      .run(content, path);
  }

  reset(): void {
    this.db.exec("DELETE FROM sessions");
  }

  close(): void {
    this.db.close();
  }
}

function deriveSessionId(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.jsonl$/, "");
}

// Local copy of `kebab()` so db.ts doesn't pull in pipeline/writer.ts (which
// would create an import cycle once writer.ts depends on db state).
function kebabLite(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

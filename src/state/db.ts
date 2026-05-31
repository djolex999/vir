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

// A distilled session that still has no embedding — the backfill set for the
// self-heal sweep (and the "pending embedding" count). Carries just the columns
// the pure selector `selectEmbeddingTargets` needs to mirror the SQL filter.
export interface EmbeddingTargetRow {
  path: string;
  content: string | null;
  skipped: number;
  error: string | null;
  embedding: string | null;
  topic: string | null;
  category: string | null;
  archived: number | null;
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

export interface ArticleRow {
  path: string;
  notePath: string | null;
  title: string;
  url: string | null;
  author: string | null;
  published: string | null;
  category: string;
  confidence: number;
  distilledAt: string | null;
  content: string;
}

export interface TopicRow {
  id: string;
  topicText: string;
  title: string;
  content: string;
  sourceNoteIds: string[];
  confidence: number | null;
  model: string;
  createdAt: string;
  updatedAt: string;
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

  constructor(path: string = STATE_PATH, opts: { readonly?: boolean } = {}) {
    if (opts.readonly) {
      // Read-only consumers (the `vir mcp` server) must never mutate state.
      // Open read-only and skip the WAL pragma + migrations — both are writes.
      // The DB must already exist; a fresh install has nothing to serve yet.
      this.db = new Database(path, { readonly: true, fileMustExist: true });
      return;
    }
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
      CREATE TABLE IF NOT EXISTS articles (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        skipped INTEGER NOT NULL DEFAULT 0,
        note_path TEXT,
        error TEXT,
        content TEXT,
        category TEXT,
        title TEXT,
        url TEXT,
        author TEXT,
        published TEXT,
        confidence REAL,
        distilled_at TEXT,
        embedding TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_articles_hash ON articles(hash);
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        topic_text TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_note_ids TEXT NOT NULL,
        confidence REAL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        embedding TEXT
      );
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

  // Rows the reconcile flow looks for: sessions that the pipeline thought it
  // had distilled (`skipped = 0`) but that ended up with no content. Two
  // shapes for the same symptom — pre-0.7.2 silent failures landed as
  // `content = ''` (the Kie-200 bug yielded an empty distill text), and
  // anything that errored landed as `content IS NULL`. The selector covers
  // both. Pure SQL filter for performance + a pure-function counterpart
  // (`selectReconcileTargets`) for unit tests against fixture rows.
  listReconcileTargets(): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE skipped = 0
           AND (content IS NULL OR content = '')`,
      )
      .all() as SessionRow[];
  }

  // Distilled notes that still have no embedding — the exact complement of
  // getEmbeddings()'s filter (same gates, but `embedding IS NULL`). A row here,
  // once embedded, becomes a getEmbeddings() hit. Drives the self-heal sweep and
  // the "pending embedding" count. Pure-function counterpart
  // `selectEmbeddingTargets` mirrors this SQL for unit tests against fixtures.
  // Empty/errored rows are reconcile's domain, not ours — never embed nothing.
  listEmbeddingTargets(): EmbeddingTargetRow[] {
    return this.db
      .prepare(
        `SELECT path, content, skipped, error, embedding, topic, category, archived
         FROM sessions
         WHERE skipped = 0
           AND error IS NULL
           AND content IS NOT NULL
           AND content != ''
           AND embedding IS NULL
           AND topic IS NOT NULL
           AND category IS NOT NULL
           AND COALESCE(archived, 0) = 0`,
      )
      .all() as EmbeddingTargetRow[];
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

  // ── articles ────────────────────────────────────────────────────────────
  // Articles live in their own table so the article taxonomy
  // (concept/technique/reference/opinion) never pollutes session listings,
  // stats, or the rewrite path. Read methods guard against a missing table:
  // the read-only MCP path skips migrations, so an install that upgraded but
  // never ran a writable pass won't have the articles table yet.

  private hasArticlesTable(): boolean {
    try {
      const r = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='articles'",
        )
        .get();
      return r !== undefined;
    } catch {
      return false;
    }
  }

  isArticleProcessed(path: string, hash: string): boolean {
    if (!this.hasArticlesTable()) return false;
    const row = this.db
      .prepare("SELECT hash FROM articles WHERE path = ?")
      .get(path) as { hash: string } | undefined;
    return row !== undefined && row.hash === hash;
  }

  recordArticle(opts: {
    path: string;
    hash: string;
    skipped: boolean;
    notePath?: string | null;
    error?: string | null;
    content?: string | null;
    category?: string | null;
    title?: string | null;
    url?: string | null;
    author?: string | null;
    published?: string | null;
    confidence?: number | null;
    distilledAt?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO articles (
           path, hash, processed_at, skipped, note_path, error,
           content, category, title, url, author, published,
           confidence, distilled_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           hash = excluded.hash,
           processed_at = excluded.processed_at,
           skipped = excluded.skipped,
           error = excluded.error,
           note_path = COALESCE(excluded.note_path, articles.note_path),
           content = COALESCE(excluded.content, articles.content),
           category = COALESCE(excluded.category, articles.category),
           title = COALESCE(excluded.title, articles.title),
           url = COALESCE(excluded.url, articles.url),
           author = COALESCE(excluded.author, articles.author),
           published = COALESCE(excluded.published, articles.published),
           confidence = COALESCE(excluded.confidence, articles.confidence),
           distilled_at = COALESCE(excluded.distilled_at, articles.distilled_at)`,
      )
      .run(
        opts.path,
        opts.hash,
        new Date().toISOString(),
        opts.skipped ? 1 : 0,
        opts.notePath ?? null,
        opts.error ?? null,
        opts.content ?? null,
        opts.category ?? null,
        opts.title ?? null,
        opts.url ?? null,
        opts.author ?? null,
        opts.published ?? null,
        opts.confidence ?? null,
        opts.distilledAt ?? null,
      );
  }

  listArticles(): ArticleRow[] {
    if (!this.hasArticlesTable()) return [];
    const rows = this.db
      .prepare(
        `SELECT path, note_path, title, url, author, published,
                category, confidence, distilled_at, content
         FROM articles
         WHERE skipped = 0 AND error IS NULL AND content IS NOT NULL`,
      )
      .all() as Array<{
      path: string;
      note_path: string | null;
      title: string | null;
      url: string | null;
      author: string | null;
      published: string | null;
      category: string | null;
      confidence: number | null;
      distilled_at: string | null;
      content: string;
    }>;
    return rows.map((r) => ({
      path: r.path,
      notePath: r.note_path,
      title: r.title ?? "",
      url: r.url,
      author: r.author,
      published: r.published,
      category: r.category ?? "",
      confidence: r.confidence ?? 0,
      distilledAt: r.distilled_at,
      content: r.content,
    }));
  }

  storeArticleEmbedding(path: string, embedding: number[]): void {
    this.db
      .prepare("UPDATE articles SET embedding = ? WHERE path = ?")
      .run(JSON.stringify(embedding), path);
  }

  // Article embeddings, shaped like session EmbeddingRow so the retriever can
  // concat both lists. filePath is the stored note path; project is empty
  // (articles have no project), category is the article taxonomy.
  getArticleEmbeddings(): EmbeddingRow[] {
    if (!this.hasArticlesTable()) return [];
    const rows = this.db
      .prepare(
        `SELECT note_path, embedding, title, category
         FROM articles
         WHERE skipped = 0
           AND error IS NULL
           AND embedding IS NOT NULL
           AND note_path IS NOT NULL`,
      )
      .all() as Array<{
      note_path: string;
      embedding: string;
      title: string | null;
      category: string | null;
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
      out.push({
        sessionId: deriveSessionId(r.note_path),
        topic: r.title ?? "",
        category: r.category ?? "",
        project: "",
        filePath: r.note_path,
        embedding: vec,
      });
    }
    return out;
  }

  // ── topics ──────────────────────────────────────────────────────────────
  // Synthesized topic pages (`vir compose`). Their own table so the `topic`
  // taxonomy never pollutes session/article listings, stats, or the rewrite
  // path. Read methods guard against a missing table — the read-only MCP path
  // skips migrations, so an upgraded-but-never-rewritten install lacks it.

  private hasTopicsTable(): boolean {
    try {
      const r = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='topics'",
        )
        .get();
      return r !== undefined;
    } catch {
      return false;
    }
  }

  getTopic(id: string): TopicRow | undefined {
    if (!this.hasTopicsTable()) return undefined;
    const r = this.db
      .prepare("SELECT * FROM topics WHERE id = ?")
      .get(id) as
      | {
          id: string;
          topic_text: string;
          title: string;
          content: string;
          source_note_ids: string;
          confidence: number | null;
          model: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!r) return undefined;
    return mapTopicRow(r);
  }

  recordTopic(opts: {
    id: string;
    topicText: string;
    title: string;
    content: string;
    sourceNoteIds: string[];
    confidence?: number | null;
    model: string;
    createdAt: string;
    updatedAt: string;
  }): void {
    // ON CONFLICT preserves created_at (re-composing a topic keeps its birth
    // date) and bumps updated_at — the idempotency contract from the spec.
    this.db
      .prepare(
        `INSERT INTO topics (
           id, topic_text, title, content, source_note_ids,
           confidence, model, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           topic_text = excluded.topic_text,
           title = excluded.title,
           content = excluded.content,
           source_note_ids = excluded.source_note_ids,
           confidence = excluded.confidence,
           model = excluded.model,
           updated_at = excluded.updated_at`,
      )
      .run(
        opts.id,
        opts.topicText,
        opts.title,
        opts.content,
        JSON.stringify(opts.sourceNoteIds),
        opts.confidence ?? null,
        opts.model,
        opts.createdAt,
        opts.updatedAt,
      );
  }

  listTopics(): TopicRow[] {
    if (!this.hasTopicsTable()) return [];
    const rows = this.db
      .prepare(
        `SELECT id, topic_text, title, content, source_note_ids,
                confidence, model, created_at, updated_at
         FROM topics`,
      )
      .all() as Array<{
      id: string;
      topic_text: string;
      title: string;
      content: string;
      source_note_ids: string;
      confidence: number | null;
      model: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map(mapTopicRow);
  }

  // Future-proofing for v0.7.3 (topic-aware retrieval). Stored now so topics
  // are searchable then without a backfill; the retriever does not read these
  // yet — keeping topics out of `vir query` per the plugin-compat contract.
  storeTopicEmbedding(id: string, embedding: number[]): void {
    this.db
      .prepare("UPDATE topics SET embedding = ? WHERE id = ?")
      .run(JSON.stringify(embedding), id);
  }

  close(): void {
    this.db.close();
  }
}

function mapTopicRow(r: {
  id: string;
  topic_text: string;
  title: string;
  content: string;
  source_note_ids: string;
  confidence: number | null;
  model: string;
  created_at: string;
  updated_at: string;
}): TopicRow {
  let sourceNoteIds: string[] = [];
  try {
    const parsed = JSON.parse(r.source_note_ids) as unknown;
    if (Array.isArray(parsed)) sourceNoteIds = parsed.map((x) => String(x));
  } catch {
    sourceNoteIds = [];
  }
  return {
    id: r.id,
    topicText: r.topic_text,
    title: r.title,
    content: r.content,
    sourceNoteIds,
    confidence: r.confidence,
    model: r.model,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function deriveSessionId(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.jsonl$/, "");
}

// Re-export for callers outside db.ts (reconcile) that need the same path → id
// mapping cost.log uses, so the collateral-count join lines up.
export { deriveSessionId };

// Local copy of `kebab()` so db.ts doesn't pull in pipeline/writer.ts (which
// would create an import cycle once writer.ts depends on db state).
function kebabLite(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

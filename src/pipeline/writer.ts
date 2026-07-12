import chalk from "chalk";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "../config.js";
import {
  cosineSimilarity,
  embeddingForNote,
  isOllamaAvailableCached,
} from "../search/embedder.js";
import type { StateDb } from "../state/db.js";
import type { Category, DistilledNote, ParsedSession } from "./types.js";
import type { ParsedArticle } from "./articleReader.js";
import {
  ARTICLES_SUBDIR,
  articleRelPath,
  buildArticleFrontmatter,
  type DistilledArticle,
} from "./articleDistiller.js";
import type { ParsedPdf } from "./pdfReader.js";
import {
  PDFS_SUBDIR,
  buildPdfFrontmatter,
  pdfRelPath,
  type DistilledPdf,
} from "./pdfDistiller.js";
import {
  TOPICS_SUBDIR,
  buildComposeFrontmatter,
  composeRelPath,
  type ComposedTopic,
} from "./composer.js";
import { kebab, makeSlug } from "./slug.js";

const CATEGORY_DIR: Record<Category, string> = {
  pattern: "patterns",
  gotcha: "gotchas",
  decision: "decisions",
  tool: "tools",
};

export class VaultWriter {
  private root: string;
  private db: StateDb | null;
  private topicsDir: string;
  // Count of notes whose write-time embedding was skipped because Ollama was
  // down. run.ts reads this to emit one traceable daemon.log line — a silent
  // no-op is what turned a transient outage into a permanent retrieval blind
  // spot; the self-heal sweep back-fills them next run.
  embedSkipped = 0;

  constructor(cfg: Config, db: StateDb | null = null) {
    this.root = join(cfg.vaultPath, cfg.outputDir);
    this.db = db;
    this.topicsDir = cfg.topicsDir ?? TOPICS_SUBDIR;
    for (const sub of [
      ...Object.values(CATEGORY_DIR),
      ARTICLES_SUBDIR,
      PDFS_SUBDIR,
      this.topicsDir,
    ]) {
      const p = join(this.root, sub);
      if (!existsSync(p)) mkdirSync(p, { recursive: true });
    }
    this.ensureIndex();
    this.ensureLog();
  }

  async write(
    session: ParsedSession,
    note: DistilledNote,
    mode: "append" | "rewrite" = "append",
  ): Promise<string[]> {
    const { classification, markdown } = note;
    const slug = makeSlug(classification.topic, session.sessionId);
    const subDir = CATEGORY_DIR[classification.category];
    const relPath = join(subDir, `${slug}.md`);
    const fullPath = join(this.root, relPath);

    // themes is a fresh classify signal but isn't a DB column, so a rewrite-only
    // pass carries none — fall back to the existing note's themes block then,
    // exactly like the review fields. A fresh distill (or --full) re-emits them.
    const themesLines =
      classification.themes.length > 0
        ? renderThemesLines(classification.themes)
        : this.preservedThemesBlock(fullPath);

    // Obsidian resolves [[bare-kebab-topic]] (what wikilinkRelated emits in
    // OTHER notes' Related sections) to this note only via an alias — the
    // filename carries a -<8hex> suffix the link text can't know.
    const alias = kebab(classification.topic);
    const frontmatter = [
      "---",
      `topic: "${classification.topic.replace(/"/g, '\\"')}"`,
      ...(alias.length > 0 ? ["aliases:", `  - "${alias}"`] : []),
      `category: ${classification.category}`,
      `project: "${classification.project.replace(/"/g, '\\"')}"`,
      `session_id: ${session.sessionId}`,
      `date: ${session.startedAt ?? new Date().toISOString()}`,
      `confidence: ${classification.confidence}`,
      ...themesLines,
      // A user's review verdict (set by `vir review`) lives in frontmatter, not
      // SQLite — so any rewrite of the file (rewrite-only OR a --full re-distill
      // that re-emits an existing note) would clobber it. Carry it over verbatim.
      ...this.preservedReviewFields(fullPath),
      "---",
      "",
    ].join("\n");

    const projectSlug = kebab(classification.project);
    const categorySlug = classification.category;
    const wikilinkHeader =
      `Project: [[${projectSlug}]]\n` +
      `Category: [[${categorySlug}]]\n\n`;

    // The LLM's Related bullets name topics it can't see (1/2261 resolved on a
    // real vault) — they are discarded and rebuilt from embedding neighbors.
    // Embed BEFORE composing Related: the vector must not depend on the links
    // it selects, and the embedded text keeps the title (frontmatter) so
    // retrieval ranking still weights it.
    const strippedBody = stripRelatedSection(markdown);
    const vec = await this.computeNoteEmbedding(
      frontmatter + wikilinkHeader + strippedBody,
    );
    const related = vec ? this.neighborLinks(vec, session.sessionId) : [];
    const body = strippedBody + renderRelatedSection(related);

    const finalContent = frontmatter + wikilinkHeader + body + "\n";
    writeFileSync(fullPath, finalContent);
    if (vec && this.db) {
      try {
        this.db.storeEmbedding(session.sessionId, vec);
        console.log(
          chalk.dim(`  embedded ${note.classification.topic} (${vec.length}d)`),
        );
      } catch {
        // never crash the writer on embedding failure
      }
    }
    // Rewrite mode re-renders existing notes from stored content; the index is
    // rebuilt wholesale via regenerateIndex() afterward and log.md is left
    // untouched, so appending per-note here would duplicate every row.
    if (mode === "append") {
      this.appendIndex({
        date: (session.startedAt ?? new Date().toISOString()).slice(0, 10),
        topic: classification.topic,
        category: classification.category,
        project: classification.project,
        relPath,
      });
      this.appendLog({
        ts: new Date().toISOString().slice(0, 16).replace("T", " "),
        category: classification.category,
        topic: classification.topic,
        project: classification.project,
      });
    }
    return [fullPath];
  }

  // Write a distilled web article into articles/<slug>.md. Parallel to write()
  // but uses the article taxonomy + frontmatter, and always preserves the
  // source URL as a clickable backlink. Returns the note's absolute path.
  async writeArticle(
    article: ParsedArticle,
    distilled: DistilledArticle,
    mode: "append" | "rewrite" = "append",
  ): Promise<string> {
    const relPath = articleRelPath(article);
    const fullPath = join(this.root, relPath);

    const frontmatter = buildArticleFrontmatter(article, distilled);
    const sourceLine = article.url
      ? `Source: [${article.title.replace(/[[\]]/g, "")}](${article.url})\n`
      : "";
    const header =
      sourceLine + `Category: [[${distilled.classification.category}]]\n\n`;
    const body = wikilinkRelated(distilled.markdown);

    const finalContent = frontmatter + header + body + "\n";
    writeFileSync(fullPath, finalContent);
    await this.maybeEmbedArticle(article, finalContent);

    const indexProject = article.author ?? "web";
    if (mode === "append") {
      this.appendIndex({
        date: (article.publishedAt ?? new Date().toISOString()).slice(0, 10),
        topic: article.title,
        category: distilled.classification.category,
        project: indexProject,
        relPath,
      });
      this.appendLog({
        ts: new Date().toISOString().slice(0, 16).replace("T", " "),
        category: distilled.classification.category,
        topic: article.title,
        project: indexProject,
      });
    }
    return fullPath;
  }

  // Best-effort article embedding — mirrors maybeEmbed() but keyed by the
  // article's source path in the articles table. Failure never fails a write.
  private async maybeEmbedArticle(
    article: ParsedArticle,
    fileContent: string,
  ): Promise<void> {
    if (!this.db) return;
    try {
      if (!(await isOllamaAvailableCached())) return;
      const vec = await embeddingForNote(fileContent);
      if (!vec) return;
      this.db.storeArticleEmbedding(article.filePath, vec);
    } catch {
      // never crash the writer on embedding failure
    }
  }

  // Write a distilled PDF note into pdfs/<slug>.md. Parallel to writeArticle()
  // but uses the PDF frontmatter; the source is a local file path (no URL).
  async writePdf(
    parsed: ParsedPdf,
    distilled: DistilledPdf,
    mode: "append" | "rewrite" = "append",
  ): Promise<string> {
    const relPath = pdfRelPath(parsed);
    const fullPath = join(this.root, relPath);

    const frontmatter = buildPdfFrontmatter(parsed, distilled);
    const header = `Category: [[${distilled.classification.category}]]\n\n`;
    const body = wikilinkRelated(distilled.markdown);

    const finalContent = frontmatter + header + body + "\n";
    writeFileSync(fullPath, finalContent);
    await this.maybeEmbedPdf(parsed, finalContent);

    if (mode === "append") {
      this.appendIndex({
        date: new Date().toISOString().slice(0, 10),
        topic: parsed.title,
        category: distilled.classification.category,
        project: "pdf",
        relPath,
      });
      this.appendLog({
        ts: new Date().toISOString().slice(0, 16).replace("T", " "),
        category: distilled.classification.category,
        topic: parsed.title,
        project: "pdf",
      });
    }
    return fullPath;
  }

  // Best-effort PDF embedding — mirrors maybeEmbedArticle but keyed by the PDF's
  // source path in the pdfs table. Failure never fails a write.
  private async maybeEmbedPdf(
    parsed: ParsedPdf,
    fileContent: string,
  ): Promise<void> {
    if (!this.db) return;
    try {
      if (!(await isOllamaAvailableCached())) return;
      const vec = await embeddingForNote(fileContent);
      if (!vec) return;
      this.db.storePdfEmbedding(parsed.filePath, vec);
    } catch {
      // never crash the writer on embedding failure
    }
  }

  // Write a synthesized topic page into topics/<slug>.md. Parallel to write()/
  // writeArticle() but uses the topic frontmatter and a deterministic Sources
  // section built from the real source slugs (so every wikilink resolves and
  // backlinks the topic into each source's graph). Idempotent: re-composing the
  // same slug overwrites the body; created/updated come from the caller, which
  // preserves the original created date via the topics table.
  async writeTopic(
    topic: ComposedTopic,
    mode: "append" | "rewrite" = "append",
  ): Promise<string> {
    const relPath = composeRelPath(topic.slug, this.topicsDir);
    const fullPath = join(this.root, relPath);

    const frontmatter = buildComposeFrontmatter({
      title: topic.title,
      topicQuery: topic.topicQuery,
      sources: topic.sources,
      confidence: topic.confidence,
      model: topic.model,
      created: topic.createdAt.slice(0, 10),
      updated: topic.updatedAt.slice(0, 10),
    });

    const sourcesSection =
      topic.sources.length > 0
        ? "\n## Sources\n\n" +
          topic.sources.map((s) => `- [[${s.slug}]]`).join("\n") +
          "\n"
        : "";
    const body = wikilinkRelated(topic.content);
    const finalContent =
      `${frontmatter}# ${topic.title}\n\n${body}\n${sourcesSection}`;

    writeFileSync(fullPath, finalContent);
    await this.maybeEmbedTopic(topic.slug, finalContent);

    if (mode === "append") {
      this.appendIndex({
        date: topic.updatedAt.slice(0, 10),
        topic: topic.title,
        category: "topic",
        project: "topics",
        relPath,
      });
      this.appendLog({
        ts: new Date().toISOString().slice(0, 16).replace("T", " "),
        category: "topic",
        topic: topic.title,
        project: "topics",
      });
    }
    return fullPath;
  }

  // Best-effort topic embedding, keyed by the topic id (slug) in the topics
  // table. Stored for future topic-aware retrieval; failure never fails a write.
  private async maybeEmbedTopic(
    id: string,
    fileContent: string,
  ): Promise<void> {
    if (!this.db) return;
    try {
      if (!(await isOllamaAvailableCached())) return;
      const vec = await embeddingForNote(fileContent);
      if (!vec) return;
      this.db.storeTopicEmbedding(id, vec);
    } catch {
      // never crash the writer on embedding failure
    }
  }

  // Rebuild index.md from scratch off the distilled rows in SQLite, sorted by
  // date descending. Used by the --rewrite-only run so re-rendering notes never
  // appends duplicate index rows. Never touches log.md. No-op without a db.
  regenerateIndex(): void {
    if (!this.db) return;
    type Entry = {
      date: string;
      topic: string;
      category: string;
      project: string;
      link: string;
    };
    const entries: Entry[] = [];
    for (const r of this.db.listDistilled()) {
      const relPath = join(
        CATEGORY_DIR[r.category],
        `${makeSlug(r.topic, r.sessionId)}.md`,
      );
      entries.push({
        date: (r.startedAt ?? "").slice(0, 10),
        topic: r.topic,
        category: r.category,
        project: r.project,
        link: `[[${relPath.replace(/\.md$/, "")}|${r.topic}]]`,
      });
    }
    for (const a of this.db.listArticles()) {
      if (!a.notePath) continue;
      const rel = relative(this.root, a.notePath).replace(/\.md$/, "");
      entries.push({
        date: (a.published ?? a.distilledAt ?? "").slice(0, 10),
        topic: a.title,
        category: a.category,
        project: a.author ?? "web",
        link: `[[${rel}|${a.title}]]`,
      });
    }
    for (const t of this.db.listTopics()) {
      const rel = composeRelPath(t.id, this.topicsDir).replace(/\.md$/, "");
      entries.push({
        date: (t.updatedAt ?? t.createdAt ?? "").slice(0, 10),
        topic: t.title,
        category: "topic",
        project: "topics",
        link: `[[${rel}|${t.title}]]`,
      });
    }
    entries.sort((x, y) => y.date.localeCompare(x.date));
    const header =
      "# vir — Distilled Knowledge\n\n" +
      "| Date | Topic | Category | Project | Link |\n" +
      "|------|-------|----------|---------|------|\n";
    const body = entries
      .map(
        (e) =>
          `| ${e.date} | ${e.topic} | ${e.category} | ${e.project} | ${e.link} |`,
      )
      .join("\n");
    writeFileSync(
      join(this.root, "index.md"),
      body.length > 0 ? `${header}${body}\n` : header,
    );
  }

  // Read back any review verdict already stamped on an existing note so a
  // rewrite preserves it. Returns the raw frontmatter lines (e.g.
  // `verified: true`) in stable order; [] for a brand-new note or no fields.
  private preservedReviewFields(fullPath: string): string[] {
    if (!existsSync(fullPath)) return [];
    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      return [];
    }
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (!m?.[1]) return [];
    const keep = ["verified", "reviewed_at", "rejected_at"];
    const found = new Map<string, string>();
    for (const line of m[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      if (keep.includes(key) && !found.has(key)) found.set(key, line.trim());
    }
    return keep.filter((k) => found.has(k)).map((k) => found.get(k)!);
  }

  // Read back the multi-line `themes:` block from an existing note so a
  // rewrite-only pass (which has no themes — it's not a DB column) preserves it
  // instead of dropping it. Returns the `themes:` line plus its indented `- `
  // items in order; [] when the note has no themes block. The single-line
  // preservedReviewFields can't handle a YAML list, hence the separate walker.
  private preservedThemesBlock(fullPath: string): string[] {
    if (!existsSync(fullPath)) return [];
    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      return [];
    }
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (!m?.[1]) return [];
    const out: string[] = [];
    let inThemes = false;
    for (const line of m[1].split("\n")) {
      if (!inThemes) {
        if (/^themes:\s*$/.test(line)) {
          inThemes = true;
          out.push("themes:");
        }
        continue;
      }
      // Collect indented list items; the first non-item line ends the block.
      if (/^\s+-\s/.test(line)) out.push(line);
      else break;
    }
    // A bare `themes:` with no items isn't worth re-emitting.
    return out.length > 1 ? out : [];
  }

  // Best-effort: embed the freshly-written note via Ollama and store the
  // vector. Any failure (Ollama down, timeout, model missing) is swallowed —
  // an embedding miss must never fail a write.
  // Best-effort note embedding, computed up front so write() can pick
  // Related neighbors from it before composing the body. Storage happens in
  // write() after the file lands.
  private async computeNoteEmbedding(text: string): Promise<number[] | null> {
    if (!this.db) return null;
    try {
      const available = await isOllamaAvailableCached();
      if (!available) {
        // Traceable, not loud — run.ts logs the aggregate once after the loop.
        // The self-heal sweep back-fills this note next run with Ollama up.
        this.embedSkipped += 1;
        return null;
      }
      return await embeddingForNote(text);
    } catch {
      // never crash the writer on embedding failure
      return null;
    }
  }

  // Top-K nearest EXISTING session notes by cosine similarity — the Related
  // section links only to files that are actually on disk, never to
  // LLM-guessed topics.
  private neighborLinks(
    vec: number[],
    selfSessionId: string,
  ): RelatedLink[] {
    if (!this.db) return [];
    try {
      return this.db
        .getEmbeddings(this.root)
        .filter((r) => r.sessionId !== selfSessionId)
        .map((r) => ({ r, sim: cosineSimilarity(vec, r.embedding) }))
        .filter((x) => x.sim >= RELATED_MIN_SIM && existsSync(x.r.filePath))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, RELATED_K)
        .map((x) => ({
          slug: makeSlug(x.r.topic, x.r.sessionId),
          topic: x.r.topic,
        }));
    } catch {
      return [];
    }
  }

  private ensureIndex(): void {
    const p = join(this.root, "index.md");
    if (!existsSync(p)) {
      writeFileSync(
        p,
        "# vir — Distilled Knowledge\n\n| Date | Topic | Category | Project | Link |\n|------|-------|----------|---------|------|\n",
      );
    }
  }

  private ensureLog(): void {
    const p = join(this.root, "log.md");
    if (!existsSync(p)) {
      writeFileSync(p, "# vir — Run Log\n\n");
    }
  }

  private appendIndex(row: {
    date: string;
    topic: string;
    category: string;
    project: string;
    relPath: string;
  }): void {
    const p = join(this.root, "index.md");
    const link = `[[${row.relPath.replace(/\.md$/, "")}|${row.topic}]]`;
    const line = `| ${row.date} | ${row.topic} | ${row.category} | ${row.project} | ${link} |\n`;
    const current = readFileSync(p, "utf8");
    // Insert after the table header (first occurrence of '|------')
    const headerIdx = current.indexOf("|------");
    if (headerIdx === -1) {
      appendFileSync(p, line);
      return;
    }
    const newlineAfter = current.indexOf("\n", headerIdx);
    const updated =
      current.slice(0, newlineAfter + 1) + line + current.slice(newlineAfter + 1);
    writeFileSync(p, updated);
  }

  private appendLog(entry: {
    ts: string;
    category: string;
    topic: string;
    project: string;
  }): void {
    const p = join(this.root, "log.md");
    appendFileSync(
      p,
      `## [${entry.ts}] ${entry.category} | ${entry.topic} | ${entry.project}\n\n`,
    );
  }

  noteCount(): number {
    let n = 0;
    for (const sub of [
      ...Object.values(CATEGORY_DIR),
      ARTICLES_SUBDIR,
      PDFS_SUBDIR,
    ]) {
      const dir = join(this.root, sub);
      if (!existsSync(dir)) continue;
      try {
        n += readdirSync(dir).filter((f) => f.endsWith(".md")).length;
      } catch {
        // ignore
      }
    }
    return n;
  }
}

// Definitions live in slug.ts (dependency-free, so db.ts/merger/linter can
// share them without import cycles); re-exported here for existing importers.
export { kebab, makeSlug } from "./slug.js";

// Render a non-empty themes list as YAML frontmatter lines: a `themes:` key
// then one quoted `- ` item per theme (quoted + escaped like topic/project, so
// a colon or quote in a theme label can't corrupt the block). Caller guarantees
// non-empty; an empty list omits the key entirely.
export function renderThemesLines(themes: string[]): string[] {
  return [
    "themes:",
    ...themes.map((t) => `  - "${t.replace(/"/g, '\\"')}"`),
  ];
}

const RELATED_K = 5;
// nomic-embed-text cosine floor: unrelated dev notes sit ≈0.4–0.55, genuine
// neighbors ≥0.6. Below the floor a link is noise, not knowledge.
const RELATED_MIN_SIM = 0.6;

interface RelatedLink {
  slug: string;
  topic: string;
}

// Drops the LLM's `## Related` section (heading + its bullets, up to the
// next heading or EOF). Session notes rebuild Related from embedding
// neighbors; legacy stored content still carries the old section, so the
// rewrite path must strip it too.
export function stripRelatedSection(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inRelated = false;
  for (const line of lines) {
    if (/^##\s+related\b/i.test(line)) {
      inRelated = true;
      continue;
    }
    if (inRelated && /^#{1,6}\s+/.test(line)) inRelated = false;
    if (!inRelated) out.push(line);
  }
  return out.join("\n").replace(/\n+$/, "");
}

// Renders neighbor links as the note's Related section — id-suffixed targets
// (always resolvable) with the human topic as the display alias.
export function renderRelatedSection(links: RelatedLink[]): string {
  if (links.length === 0) return "";
  return (
    "\n\n## Related\n\n" +
    links.map((l) => `- [[${l.slug}|${l.topic}]]`).join("\n")
  );
}

// Rewrites the bullet list under a `## Related` heading so each item
// becomes an Obsidian wikilink to a kebab-cased slug of the item's text.
// Still used by the article/PDF/topic writers; session notes now build
// Related from embedding neighbors instead.
export function wikilinkRelated(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inRelated = false;

  for (const line of lines) {
    if (/^##\s+related\b/i.test(line)) {
      inRelated = true;
      out.push(line);
      continue;
    }
    if (inRelated && /^#{1,6}\s+/.test(line)) {
      inRelated = false;
      out.push(line);
      continue;
    }
    if (inRelated) {
      const bullet = line.match(/^(\s*[-*]\s+)(.*)$/);
      if (bullet) {
        const prefix = bullet[1] ?? "- ";
        const text = (bullet[2] ?? "").trim();
        if (text.length === 0) {
          out.push(line);
        } else if (/^\[\[.+\]\]$/.test(text)) {
          // already a wikilink — leave it
          out.push(line);
        } else {
          const slug = kebab(stripWikilink(text));
          out.push(`${prefix}[[${slug}]]`);
        }
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function stripWikilink(s: string): string {
  // If the model already partially wrapped it like "[[Something]]" or
  // "[Something](url)", reduce to the inner text before kebab-casing.
  const wiki = s.match(/^\[\[(.+?)\]\]$/);
  if (wiki) return wiki[1] ?? s;
  const md = s.match(/^\[(.+?)\]\(.+\)$/);
  if (md) return md[1] ?? s;
  return s;
}

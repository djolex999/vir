import chalk from "chalk";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import {
  embeddingForNote,
  isOllamaAvailableCached,
} from "../search/embedder.js";
import type { StateDb } from "../state/db.js";
import type { Category, DistilledNote, ParsedSession } from "./types.js";

const CATEGORY_DIR: Record<Category, string> = {
  pattern: "patterns",
  gotcha: "gotchas",
  decision: "decisions",
  tool: "tools",
};

export class VaultWriter {
  private root: string;
  private db: StateDb | null;

  constructor(cfg: Config, db: StateDb | null = null) {
    this.root = join(cfg.vaultPath, cfg.outputDir);
    this.db = db;
    for (const sub of Object.values(CATEGORY_DIR)) {
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

    const frontmatter = [
      "---",
      `topic: "${classification.topic.replace(/"/g, '\\"')}"`,
      `category: ${classification.category}`,
      `project: "${classification.project.replace(/"/g, '\\"')}"`,
      `session_id: ${session.sessionId}`,
      `date: ${session.startedAt ?? new Date().toISOString()}`,
      `confidence: ${classification.confidence}`,
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

    const body = wikilinkRelated(markdown);

    const finalContent = frontmatter + wikilinkHeader + body + "\n";
    writeFileSync(fullPath, finalContent);
    await this.maybeEmbed(session, note, finalContent);
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

  // Rebuild index.md from scratch off the distilled rows in SQLite, sorted by
  // date descending. Used by the --rewrite-only run so re-rendering notes never
  // appends duplicate index rows. Never touches log.md. No-op without a db.
  regenerateIndex(): void {
    if (!this.db) return;
    const rows = [...this.db.listDistilled()].sort((a, b) =>
      (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
    );
    const header =
      "# vir — Distilled Knowledge\n\n" +
      "| Date | Topic | Category | Project | Link |\n" +
      "|------|-------|----------|---------|------|\n";
    const body = rows
      .map((r) => {
        const date = (r.startedAt ?? "").slice(0, 10);
        const relPath = join(CATEGORY_DIR[r.category], `${makeSlug(r.topic, r.sessionId)}.md`);
        const link = `[[${relPath.replace(/\.md$/, "")}|${r.topic}]]`;
        return `| ${date} | ${r.topic} | ${r.category} | ${r.project} | ${link} |`;
      })
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

  // Best-effort: embed the freshly-written note via Ollama and store the
  // vector. Any failure (Ollama down, timeout, model missing) is swallowed —
  // an embedding miss must never fail a write.
  private async maybeEmbed(
    session: ParsedSession,
    note: DistilledNote,
    fileContent: string,
  ): Promise<void> {
    if (!this.db) return;
    try {
      const available = await isOllamaAvailableCached();
      if (!available) return;
      const vec = await embeddingForNote(fileContent);
      if (!vec) return;
      this.db.storeEmbedding(session.sessionId, vec);
      console.log(
        chalk.dim(
          `  embedded ${note.classification.topic} (${vec.length}d)`,
        ),
      );
    } catch {
      // never crash the writer on embedding failure
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
    category: Category;
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
    category: Category;
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
    for (const sub of Object.values(CATEGORY_DIR)) {
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

export function makeSlug(topic: string, sessionId: string): string {
  const base = kebab(topic).slice(0, 50);
  const suffix = sessionId.slice(0, 8);
  return base.length > 0 ? `${base}-${suffix}` : `note-${suffix}`;
}

export function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Rewrites the bullet list under a `## Related` heading so each item
// becomes an Obsidian wikilink to a kebab-cased slug of the item's text.
// Stops at the next heading or end of document.
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

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface ParsedArticle {
  filePath: string;
  hash: string; // SHA-256 of raw file content
  title: string; // from frontmatter or first H1
  url?: string; // from frontmatter (Obsidian Web Clipper writes `source`)
  publishedAt?: string; // from frontmatter
  author?: string; // from frontmatter
  tags: string[]; // from frontmatter
  body: string; // article text, frontmatter stripped
  wordCount: number;
}

// Frontmatter keys that may carry the canonical source URL. Obsidian Web
// Clipper writes `source`; hand-authored notes might use `url`/`source_url`.
const URL_KEYS = ["source", "url", "source_url"];

export function parseArticle(filePath: string): ParsedArticle {
  const raw = readFileSync(filePath);
  const hash = createHash("sha256").update(raw).digest("hex");
  const text = raw.toString("utf8");

  const { frontmatter, body } = splitFrontmatter(text);

  const title =
    asString(frontmatter.title) ??
    firstH1(body) ??
    basename(filePath).replace(/\.md$/i, "");

  let url: string | undefined;
  for (const key of URL_KEYS) {
    const v = asString(frontmatter[key]);
    if (v) {
      url = v;
      break;
    }
  }

  const tagsRaw = frontmatter.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
    : typeof tagsRaw === "string" && tagsRaw.trim().length > 0
      ? [tagsRaw.trim()]
      : [];

  const wordCount = body.trim().length === 0 ? 0 : body.trim().split(/\s+/).length;

  return {
    filePath,
    hash,
    title,
    url,
    publishedAt: asString(frontmatter.published),
    author: asString(frontmatter.author),
    tags,
    body,
    wordCount,
  };
}

export function scanArticles(rawDir: string): ParsedArticle[] {
  const files: string[] = [];
  walk(rawDir, files);
  const out: ParsedArticle[] = [];
  for (const f of files) {
    try {
      out.push(parseArticle(f));
    } catch {
      // unreadable / mid-write file — skip, never fail the whole scan
    }
  }
  return out;
}

function walk(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, acc);
    else if (st.isFile() && name.toLowerCase().endsWith(".md")) acc.push(full);
  }
}

function splitFrontmatter(text: string): {
  frontmatter: Record<string, string | string[]>;
  body: string;
} {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m || m[1] === undefined) {
    return { frontmatter: {}, body: text.trimStart() };
  }
  return {
    frontmatter: parseFrontmatterBlock(m[1]),
    body: text.slice(m[0].length).trimStart(),
  };
}

function parseFrontmatterBlock(
  block: string,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = (kv[1] ?? "").trim();
    const rest = (kv[2] ?? "").trim();
    if (key.length === 0) continue;

    if (rest.length === 0) {
      // Possible block-style list: subsequent `  - item` lines.
      const items: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const item = (lines[j] ?? "").match(/^\s*-\s+(.*)$/);
        if (!item) break;
        items.push(stripQuotes((item[1] ?? "").trim()));
      }
      if (items.length > 0) {
        out[key] = items;
        i = j - 1;
      } else {
        out[key] = "";
      }
      continue;
    }

    if (rest.startsWith("[")) {
      out[key] = parseInlineArray(rest);
      continue;
    }

    out[key] = stripQuotes(rest);
  }
  return out;
}

function parseInlineArray(s: string): string[] {
  const inner = s.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((part) => stripQuotes(part.trim()))
    .filter((part) => part.length > 0);
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function asString(v: string | string[] | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function firstH1(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return (m[1] ?? "").trim();
  }
  return undefined;
}

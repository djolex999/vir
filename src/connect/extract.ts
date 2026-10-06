import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "../cli/review.js";
import { kebab } from "../pipeline/slug.js";
import type { Category } from "../pipeline/types.js";
import { CATEGORY_DIR } from "../pipeline/writer.js";
import type { Lesson } from "./types.js";

const ITEM_RE = /^(?:[-*]|\d+\.)?\s*(?:\*\*|__)/;
const HEADING_RE = /^#{1,2}\s/;

function section(lines: string[], title: RegExp): string[] | null {
  const start = lines.findIndex((l) => title.test(l));
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (HEADING_RE.test(line)) break;
    out.push(line);
  }
  return out;
}

// A lesson starts on a base-indent line beginning with an optional list marker
// and bold; its body runs to the next base-indent item or heading. Nested
// (indented) bold lines belong to their parent. Mid-line bold is not an item.
export function extractLessonTexts(markdown: string): string[] {
  const lines = markdown.split("\n");
  const learned = section(lines, /^##\s+What Was Learned\s*$/);
  if (learned === null) {
    const summary = section(lines, /^##\s+Summary\s*$/);
    const text = (summary ?? []).join("\n").trim();
    return text.length > 0 ? [text] : [];
  }
  const items: string[][] = [];
  let cur: string[] | null = null;
  for (const line of learned) {
    // ### subheadings group lessons; they end the current item and are not text.
    if (/^#{3,6}\s/.test(line)) {
      cur = null;
    } else if (ITEM_RE.test(line) && !/^\s/.test(line)) {
      cur = [line];
      items.push(cur);
    } else if (cur) {
      cur.push(line);
    }
  }
  return items.map((l) => l.join("\n").trim()).filter((t) => t.length > 0);
}

export function normalizeLesson(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))
    .join(" ")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function lessonHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function archivedDuplicateSlugs(markdown: string): string[] {
  const lines = section(markdown.split("\n"), /^##\s+Archived Duplicates\s*$/) ?? [];
  return lines
    .map((l) => l.match(/^\s*-\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/)?.[1]?.trim())
    .filter((s): s is string => typeof s === "string" && s.length > 0);
}

function lessonsFromNote(
  path: string,
  citeSlug: string,
  archivedVia: string | null,
): Lesson[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const fm = parseFrontmatter(raw);
  const sessionId = fm.session_id ?? "";
  if (sessionId.length === 0) return [];
  const noteSlug = basename(path, ".md");
  return extractLessonTexts(raw).map((t, itemIndex) => {
    const text = normalizeLesson(t);
    return {
      id: `${noteSlug}#${itemIndex}`,
      noteSlug,
      citeSlug,
      sessionId,
      noteDate: fm.date ?? "",
      project: kebab(fm.project ?? ""),
      category: (fm.category ?? "pattern") as Category,
      itemIndex,
      text,
      contentHash: lessonHash(text),
      archivedVia,
    };
  });
}

export function collectLessons(vaultRoot: string): Lesson[] {
  const out: Lesson[] = [];
  for (const dir of Object.values(CATEGORY_DIR)) {
    const full = join(vaultRoot, dir);
    let names: string[];
    try {
      names = readdirSync(full).filter((n) => n.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(full, name);
      const slug = basename(name, ".md");
      out.push(...lessonsFromNote(path, slug, null));
      let raw = "";
      try { raw = readFileSync(path, "utf8"); } catch { continue; }
      for (const loser of archivedDuplicateSlugs(raw)) {
        const lp = join(vaultRoot, "archived", `${loser}.md`);
        if (existsSync(lp)) out.push(...lessonsFromNote(lp, slug, slug));
      }
    }
  }
  return out;
}

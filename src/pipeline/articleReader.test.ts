import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArticle, scanArticles } from "./articleReader.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-articles-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const CLIPPER = `---
title: "The Compounding Codebase"
source: "https://djordje.dev/compounding-codebase"
author: "Djordje Markovic"
published: "2026-05-22"
created: "2026-05-24"
tags: ["AI", "Claude Code"]
---

# The Compounding Codebase

Codebases that feed their own learnings back in compound over time.
`;

describe("parseArticle — Obsidian Web Clipper frontmatter", () => {
  it("parses title, source URL, author, published, and tags", () => {
    const a = parseArticle(fixture("clip.md", CLIPPER));
    expect(a.title).toBe("The Compounding Codebase");
    expect(a.url).toBe("https://djordje.dev/compounding-codebase");
    expect(a.author).toBe("Djordje Markovic");
    expect(a.publishedAt).toBe("2026-05-22");
    expect(a.tags).toEqual(["AI", "Claude Code"]);
  });

  it("strips frontmatter from the body and counts words", () => {
    const a = parseArticle(fixture("clip.md", CLIPPER));
    expect(a.body).not.toContain("source:");
    expect(a.body).toContain("compound over time");
    expect(a.wordCount).toBeGreaterThan(5);
  });

  it("parses block-style (dash list) tags", () => {
    const md = `---
title: Block Tags
tags:
  - alpha
  - beta gamma
---

Body here.
`;
    const a = parseArticle(fixture("block.md", md));
    expect(a.tags).toEqual(["alpha", "beta gamma"]);
  });
});

describe("parseArticle — title fallback", () => {
  it("uses the first H1 when frontmatter has no title", () => {
    const md = `---
source: "https://example.com/post"
---

# Heading From Body

Some text.
`;
    const a = parseArticle(fixture("noTitle.md", md));
    expect(a.title).toBe("Heading From Body");
    expect(a.url).toBe("https://example.com/post");
  });
});

describe("parseArticle — no frontmatter", () => {
  it("derives title from the first H1, leaves url undefined, tags empty", () => {
    const md = `# Plain Markdown Note

No Web Clipper frontmatter here.
`;
    const a = parseArticle(fixture("plain.md", md));
    expect(a.title).toBe("Plain Markdown Note");
    expect(a.url).toBeUndefined();
    expect(a.tags).toEqual([]);
    expect(a.body).toContain("No Web Clipper frontmatter");
  });

  it("falls back to the filename when there is no frontmatter and no H1", () => {
    const a = parseArticle(fixture("my-saved-article.md", "just a paragraph\n"));
    expect(a.title).toBe("my-saved-article");
  });
});

describe("parseArticle — hashing", () => {
  it("computes a consistent SHA-256 hash for identical content", () => {
    const a = parseArticle(fixture("a.md", CLIPPER));
    const b = parseArticle(fixture("b.md", CLIPPER));
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different hash when content differs", () => {
    const a = parseArticle(fixture("a.md", CLIPPER));
    const b = parseArticle(fixture("b.md", CLIPPER + "\nextra line\n"));
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("scanArticles", () => {
  it("returns one ParsedArticle per markdown file, ignoring non-md", () => {
    fixture("one.md", CLIPPER);
    fixture("two.md", "# Two\n\nbody\n");
    fixture("notes.txt", "ignored");
    const found = scanArticles(dir);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.title).sort()).toEqual([
      "The Compounding Codebase",
      "Two",
    ]);
  });

  it("returns an empty array for a missing directory", () => {
    expect(scanArticles(join(dir, "does-not-exist"))).toEqual([]);
  });
});

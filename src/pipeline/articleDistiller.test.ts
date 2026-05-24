import { describe, expect, it } from "vitest";
import type { ParsedArticle } from "./articleReader.js";
import {
  ARTICLE_CATEGORIES,
  articleRelPath,
  articleSlug,
  buildArticleFrontmatter,
  parseArticleClassification,
  type DistilledArticle,
} from "./articleDistiller.js";

const ARTICLE: ParsedArticle = {
  filePath: "/raw/the-compounding-codebase.md",
  hash: "a".repeat(64),
  title: "The Compounding Codebase",
  url: "https://djordje.dev/compounding-codebase",
  publishedAt: "2026-05-22",
  author: "Djordje Markovic",
  tags: ["AI", "Claude Code"],
  body: "...",
  wordCount: 100,
};

const DISTILLED: DistilledArticle = {
  classification: { category: "concept", confidence: 0.91 },
  markdown: "## Summary\n\nCodebases compound.\n",
};

describe("parseArticleClassification", () => {
  it("parses a valid article category", () => {
    const r = parseArticleClassification(
      '{"category": "technique", "confidence": 0.8}',
    );
    expect(r.category).toBe("technique");
    expect(r.confidence).toBeCloseTo(0.8);
  });

  it("only ever returns one of the four article categories", () => {
    for (const cat of ARTICLE_CATEGORIES) {
      const r = parseArticleClassification(`{"category": "${cat}"}`);
      expect(r.category).toBe(cat);
    }
    // session-style categories are not valid for articles → fall back
    const bad = parseArticleClassification('{"category": "pattern"}');
    expect(ARTICLE_CATEGORIES).toContain(bad.category);
  });

  it("falls back to a valid category on garbage input", () => {
    const r = parseArticleClassification("not json at all");
    expect(ARTICLE_CATEGORIES).toContain(r.category);
    expect(r.confidence).toBe(0);
  });

  it("clamps confidence to [0,1]", () => {
    expect(
      parseArticleClassification('{"category":"opinion","confidence":5}')
        .confidence,
    ).toBe(1);
    expect(
      parseArticleClassification('{"category":"opinion","confidence":-2}')
        .confidence,
    ).toBe(0);
  });
});

describe("buildArticleFrontmatter", () => {
  it("includes type, category, source_url and source_title", () => {
    const fm = buildArticleFrontmatter(ARTICLE, DISTILLED);
    expect(fm).toMatch(/^---\n/);
    expect(fm).toContain("type: article");
    expect(fm).toContain("category: concept");
    expect(fm).toContain(
      "source_url: https://djordje.dev/compounding-codebase",
    );
    expect(fm).toContain('source_title: "The Compounding Codebase"');
    expect(fm).toContain("confidence: 0.91");
    expect(fm).toContain(`hash: ${"a".repeat(64)}`);
  });

  it("carries source author, published date, and tags through", () => {
    const fm = buildArticleFrontmatter(ARTICLE, DISTILLED);
    expect(fm).toContain('source_author: "Djordje Markovic"');
    expect(fm).toContain("source_published: 2026-05-22");
    expect(fm).toContain("tags: [AI, Claude Code]");
  });

  it("omits optional source fields when the article lacks them", () => {
    const bare: ParsedArticle = {
      ...ARTICLE,
      url: undefined,
      author: undefined,
      publishedAt: undefined,
      tags: [],
    };
    const fm = buildArticleFrontmatter(bare, DISTILLED);
    expect(fm).not.toContain("source_url:");
    expect(fm).not.toContain("source_author:");
    expect(fm).not.toContain("source_published:");
  });
});

describe("articleSlug / articleRelPath", () => {
  it("files notes under the articles/ subdirectory", () => {
    expect(articleRelPath(ARTICLE)).toMatch(/^articles\//);
    expect(articleRelPath(ARTICLE).endsWith(".md")).toBe(true);
  });

  it("derives a kebab slug from the title", () => {
    expect(articleSlug(ARTICLE)).toContain("the-compounding-codebase");
  });

  it("is stable for the same source across content edits", () => {
    const edited: ParsedArticle = { ...ARTICLE, hash: "b".repeat(64), body: "x" };
    expect(articleSlug(edited)).toBe(articleSlug(ARTICLE));
  });
});

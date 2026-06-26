import { describe, expect, it } from "vitest";
import type { SearchHit } from "../search/retriever.js";
import { QUERY_TYPES, composeLookup, hitMeta } from "./server.js";

function hit(content: string, title: string): SearchHit {
  return { filePath: `/vault/${title}.md`, title, content, score: 1, method: "tfidf" };
}

const TOPIC_NOTE = `---
type: topic
title: "Auth flow patterns"
topic_query: "auth flows"
confidence: 0.8
model: claude-sonnet-4-6
created: 2026-06-01
updated: 2026-06-02
---

## Body
synthesized stuff`;

const ARTICLE_NOTE = `---
type: article
source_title: "Some Article"
category: technique
source_url: https://example.com
---
body`;

const SESSION_NOTE = `---
topic: A session lesson
category: gotcha
project: vir
---
body`;

describe("QUERY_TYPES", () => {
  it("includes topic alongside session, article, and all", () => {
    expect([...QUERY_TYPES]).toEqual(["session", "article", "topic", "all"]);
  });
});

describe("hitMeta", () => {
  it("classifies a topic note as type and category 'topic'", () => {
    const meta = hitMeta(hit(TOPIC_NOTE, "topics/auth-flow-patterns"));
    expect(meta.type).toBe("topic");
    expect(meta.category).toBe("topic");
    expect(meta.topic).toBe("Auth flow patterns");
  });

  it("still classifies an article note as type 'article'", () => {
    const meta = hitMeta(hit(ARTICLE_NOTE, "articles/some-article"));
    expect(meta.type).toBe("article");
    expect(meta.category).toBe("technique");
  });

  it("still classifies a session note as type 'session'", () => {
    const meta = hitMeta(hit(SESSION_NOTE, "gotchas/a-session-lesson"));
    expect(meta.type).toBe("session");
    expect(meta.category).toBe("gotcha");
  });
});

describe("composeLookup", () => {
  it("returns a CLI pointer (no synthesis) when the topic page is absent", () => {
    const res = composeLookup("kie error handling", () => null);
    expect(res.topic_slug).toBe("kie-error-handling");
    expect(String(res.error)).toContain('vir compose "kie error handling"');
  });

  it("returns the cached topic page when it exists", () => {
    const res = composeLookup("auth flows", () => TOPIC_NOTE);
    expect(res.title).toBe("Auth flow patterns");
    expect(res.content).toBe(TOPIC_NOTE);
    expect(res.confidence).toBe(0.8);
    expect(res.model).toBe("claude-sonnet-4-6");
  });
});

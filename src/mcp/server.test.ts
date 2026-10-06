import { describe, expect, it, vi } from "vitest";
import type { SearchHit } from "../search/retriever.js";
import {
  QUERY_TYPES,
  VIR_QUERY_DESCRIPTION,
  buildQueryResult,
  composeLookup,
  hitMeta,
} from "./server.js";

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

const PDF_NOTE = `---
type: pdf
category: paper
source_path: /papers/attention.pdf
source_title: "Attention Is All You Need"
pages: 11
---
body about self-attention`;

describe("QUERY_TYPES", () => {
  it("includes pdf and insight alongside session, article, topic, and all", () => {
    expect([...QUERY_TYPES]).toEqual([
      "session",
      "article",
      "topic",
      "pdf",
      "insight",
      "all",
    ]);
  });
});

describe("hitMeta — insights", () => {
  it("reads an accepted rule as type insight, titled by its rule", () => {
    const meta = hitMeta({
      title: "insights/rules/use-proxy-ts-3f9a1c2e",
      content: "---\ntype: insight\nstatus: accepted\nscope: global\n---\n**Rule:** Use proxy.ts in Next 16\n\n**Why:** w\n",
    } as Parameters<typeof hitMeta>[0]);
    expect(meta).toEqual({ topic: "Use proxy.ts in Next 16", category: "insight", project: "", type: "insight" });
  });
});

describe("hitMeta — project-scoped insight", () => {
  it("reports the project from scope so project filters keep the rule", () => {
    const meta = hitMeta({
      title: "insights/rules/x", content: "---\ntype: insight\nscope: project:pripremi-rs\n---\n**Rule:** R\n",
    } as Parameters<typeof hitMeta>[0]);
    expect(meta.project).toBe("pripremi-rs");
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

  it("classifies a pdf note as type 'pdf' with its source_title and pdf sub-category", () => {
    const meta = hitMeta(hit(PDF_NOTE, "pdfs/attention-is-all-you-need-abc12345"));
    expect(meta.type).toBe("pdf");
    expect(meta.category).toBe("paper");
    expect(meta.topic).toBe("Attention Is All You Need");
    expect(meta.project).toBe("");
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

describe("vir_query synthesis is opt-out and labelled as billed", () => {
  const hits = [hit(SESSION_NOTE, "gotchas/a-session-lesson-abcd1234")];

  it("synthesize: false returns sources without calling the LLM", async () => {
    const synth = vi.fn(async () => "answer");
    const result = await buildQueryResult(hits, { synthesize: false }, synth);
    expect(synth).not.toHaveBeenCalled();
    expect(result.answer).toBeNull();
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ category: "gotcha", project: "vir" });
  });

  it("synthesizes by default", async () => {
    const synth = vi.fn(async () => "  the answer  ");
    const result = await buildQueryResult(hits, {}, synth);
    expect(synth).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe("the answer");
  });

  it("no hits: no LLM call either way", async () => {
    const synth = vi.fn(async () => "answer");
    const result = await buildQueryResult([], {}, synth);
    expect(synth).not.toHaveBeenCalled();
    expect(result).toEqual({ answer: "No matching notes found in the vault.", sources: [] });
  });

  it("the tool description says synthesis is billed and how to skip it", () => {
    expect(VIR_QUERY_DESCRIPTION).toMatch(/billed/i);
    expect(VIR_QUERY_DESCRIPTION).toContain("synthesize: false");
  });
});

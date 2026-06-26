import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArticleEmbeddingTargetRow,
  EmbeddingTargetRow,
  PdfEmbeddingTargetRow,
  StateDb,
  TopicEmbeddingTargetRow,
} from "../state/db.js";
import {
  selectArticleEmbeddingTargets,
  selectEmbeddingTargets,
  selectPdfEmbeddingTargets,
  selectTopicEmbeddingTargets,
  sweepEmbeddings,
} from "./embeddingSweep.js";

// Mock the embedder so the sweep never touches Ollama/network. Each test sets
// the availability + embed behavior it needs.
vi.mock("../search/embedder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../search/embedder.js")>();
  return {
    ...actual,
    isOllamaAvailableCached: vi.fn(async () => true),
    embeddingForNote: vi.fn(async () => [0.1, 0.2, 0.3]),
  };
});

import {
  embeddingForNote,
  isOllamaAvailableCached,
} from "../search/embedder.js";

function row(overrides: Partial<EmbeddingTargetRow>): EmbeddingTargetRow {
  return {
    path: "/Users/x/.claude/projects/p/aaaaaaaa-0000-0000-0000-000000000000.jsonl",
    content: "real distilled markdown",
    skipped: 0,
    error: null,
    embedding: null,
    topic: "some topic",
    category: "pattern",
    archived: 0,
    ...overrides,
  };
}

function trow(
  overrides: Partial<TopicEmbeddingTargetRow>,
): TopicEmbeddingTargetRow {
  return {
    id: "auth-flow-patterns",
    content: "synthesized topic body about auth flows",
    embedding: null,
    ...overrides,
  };
}

function arow(
  overrides: Partial<ArticleEmbeddingTargetRow>,
): ArticleEmbeddingTargetRow {
  return {
    path: "/Users/x/vault/raw/some-article.md",
    notePath: "/Users/x/vault/vir/articles/some-article.md",
    content: "distilled article body",
    skipped: 0,
    error: null,
    embedding: null,
    ...overrides,
  };
}

function prow(
  overrides: Partial<PdfEmbeddingTargetRow>,
): PdfEmbeddingTargetRow {
  return {
    path: "/Users/x/papers/attention.pdf",
    notePath: "/Users/x/vault/vir/pdfs/attention-is-all-you-need-abc12345.md",
    content: "distilled pdf body",
    skipped: 0,
    error: null,
    embedding: null,
    ...overrides,
  };
}

describe("selectEmbeddingTargets", () => {
  it("includes a distilled note with content but a NULL embedding", () => {
    const rows = [row({ path: "/a.jsonl" })];
    expect(selectEmbeddingTargets(rows).map((r) => r.path)).toEqual([
      "/a.jsonl",
    ]);
  });

  it("excludes a note that already has an embedding", () => {
    const rows = [row({ path: "/b.jsonl", embedding: "[0.1,0.2]" })];
    expect(selectEmbeddingTargets(rows)).toEqual([]);
  });

  it("excludes skipped, errored, archived, and empty/null-content rows", () => {
    const rows = [
      row({ path: "/skipped.jsonl", skipped: 1 }),
      row({ path: "/errored.jsonl", error: "boom" }),
      row({ path: "/archived.jsonl", archived: 1 }),
      row({ path: "/empty.jsonl", content: "" }),
      row({ path: "/null.jsonl", content: null }),
      row({ path: "/no-topic.jsonl", topic: null }),
      row({ path: "/no-cat.jsonl", category: null }),
    ];
    expect(selectEmbeddingTargets(rows)).toEqual([]);
  });

  it("treats archived=null (legacy rows) as not archived", () => {
    const rows = [row({ path: "/legacy.jsonl", archived: null })];
    expect(selectEmbeddingTargets(rows).map((r) => r.path)).toEqual([
      "/legacy.jsonl",
    ]);
  });
});

describe("selectTopicEmbeddingTargets", () => {
  it("includes a topic with content but a NULL embedding", () => {
    expect(selectTopicEmbeddingTargets([trow({ id: "a" })]).map((r) => r.id)).toEqual([
      "a",
    ]);
  });

  it("excludes a topic that already has an embedding", () => {
    expect(
      selectTopicEmbeddingTargets([trow({ id: "b", embedding: "[0.1,0.2]" })]),
    ).toEqual([]);
  });

  it("excludes empty/null-content topics", () => {
    expect(
      selectTopicEmbeddingTargets([
        trow({ id: "c", content: "" }),
        trow({ id: "d", content: null }),
      ]),
    ).toEqual([]);
  });
});

describe("selectArticleEmbeddingTargets", () => {
  it("includes an article with content but a NULL embedding", () => {
    expect(
      selectArticleEmbeddingTargets([arow({ path: "/a.md" })]).map((r) => r.path),
    ).toEqual(["/a.md"]);
  });

  it("excludes an article that already has an embedding", () => {
    expect(
      selectArticleEmbeddingTargets([arow({ path: "/b.md", embedding: "[0.1,0.2]" })]),
    ).toEqual([]);
  });

  it("excludes skipped, errored, empty/null-content, and unwritten (null note_path) articles", () => {
    expect(
      selectArticleEmbeddingTargets([
        arow({ path: "/skipped.md", skipped: 1 }),
        arow({ path: "/errored.md", error: "boom" }),
        arow({ path: "/empty.md", content: "" }),
        arow({ path: "/null.md", content: null }),
        arow({ path: "/no-note.md", notePath: null }),
      ]),
    ).toEqual([]);
  });
});

describe("selectPdfEmbeddingTargets", () => {
  it("includes a pdf with content but a NULL embedding", () => {
    expect(
      selectPdfEmbeddingTargets([prow({ path: "/a.pdf" })]).map((r) => r.path),
    ).toEqual(["/a.pdf"]);
  });

  it("excludes a pdf that already has an embedding", () => {
    expect(
      selectPdfEmbeddingTargets([prow({ path: "/b.pdf", embedding: "[0.1,0.2]" })]),
    ).toEqual([]);
  });

  it("excludes skipped, errored, empty/null-content, and unwritten (null note_path) pdfs", () => {
    expect(
      selectPdfEmbeddingTargets([
        prow({ path: "/skipped.pdf", skipped: 1 }),
        prow({ path: "/errored.pdf", error: "boom" }),
        prow({ path: "/empty.pdf", content: "" }),
        prow({ path: "/null.pdf", content: null }),
        prow({ path: "/no-note.pdf", notePath: null }),
      ]),
    ).toEqual([]);
  });
});

function fakeDb(
  targets: EmbeddingTargetRow[],
  topicTargets: TopicEmbeddingTargetRow[] = [],
  articleTargets: ArticleEmbeddingTargetRow[] = [],
  pdfTargets: PdfEmbeddingTargetRow[] = [],
): {
  db: StateDb;
  stored: Array<{ sessionId: string; vec: number[] }>;
  topicStored: Array<{ id: string; vec: number[] }>;
  articleStored: Array<{ path: string; vec: number[] }>;
  pdfStored: Array<{ path: string; vec: number[] }>;
} {
  const stored: Array<{ sessionId: string; vec: number[] }> = [];
  const topicStored: Array<{ id: string; vec: number[] }> = [];
  const articleStored: Array<{ path: string; vec: number[] }> = [];
  const pdfStored: Array<{ path: string; vec: number[] }> = [];
  const db = {
    listEmbeddingTargets: () => targets,
    listTopicEmbeddingTargets: () => topicTargets,
    listArticleEmbeddingTargets: () => articleTargets,
    listPdfEmbeddingTargets: () => pdfTargets,
    storeEmbedding: (sessionId: string, vec: number[]) =>
      stored.push({ sessionId, vec }),
    storeTopicEmbedding: (id: string, vec: number[]) =>
      topicStored.push({ id, vec }),
    storeArticleEmbedding: (path: string, vec: number[]) =>
      articleStored.push({ path, vec }),
    storePdfEmbedding: (path: string, vec: number[]) =>
      pdfStored.push({ path, vec }),
  } as unknown as StateDb;
  return { db, stored, topicStored, articleStored, pdfStored };
}

describe("sweepEmbeddings", () => {
  afterEach(() => vi.clearAllMocks());

  it("skips entirely (no-op, no error) when Ollama is down — retries next run", async () => {
    vi.mocked(isOllamaAvailableCached).mockResolvedValueOnce(false);
    const { db, stored } = fakeDb([row({ path: "/p1.jsonl" }), row({ path: "/p2.jsonl" })]);

    const res = await sweepEmbeddings(db);

    expect(res).toEqual({ ran: false, embedded: 0, errors: 0, pending: 2 });
    expect(embeddingForNote).not.toHaveBeenCalled();
    expect(stored).toEqual([]);
  });

  it("backfills NULL-embedding notes when Ollama is up", async () => {
    vi.mocked(isOllamaAvailableCached).mockResolvedValue(true);
    const { db, stored } = fakeDb([
      row({
        path: "/Users/x/.claude/projects/p/11111111-2222-3333-4444-555555555555.jsonl",
      }),
    ]);

    const res = await sweepEmbeddings(db);

    expect(res).toEqual({ ran: true, embedded: 1, errors: 0, pending: 0 });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.sessionId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("counts an embedding failure as pending, not stored", async () => {
    vi.mocked(isOllamaAvailableCached).mockResolvedValue(true);
    vi.mocked(embeddingForNote).mockResolvedValueOnce(null);
    const { db, stored } = fakeDb([row({ path: "/fail.jsonl" })]);

    const res = await sweepEmbeddings(db);

    expect(res).toEqual({ ran: true, embedded: 0, errors: 1, pending: 1 });
    expect(stored).toEqual([]);
  });

  it("backfills a NULL-embedding topic when Ollama is up (by topic id)", async () => {
    vi.mocked(isOllamaAvailableCached).mockResolvedValue(true);
    const { db, stored, topicStored } = fakeDb(
      [],
      [trow({ id: "auth-flow-patterns" })],
    );

    const res = await sweepEmbeddings(db);

    expect(res).toEqual({ ran: true, embedded: 1, errors: 0, pending: 0 });
    expect(topicStored).toEqual([
      { id: "auth-flow-patterns", vec: [0.1, 0.2, 0.3] },
    ]);
    expect(stored).toEqual([]);
  });

  it("counts pending topics (alongside sessions) when Ollama is down", async () => {
    vi.mocked(isOllamaAvailableCached).mockResolvedValueOnce(false);
    const { db, topicStored } = fakeDb(
      [row({ path: "/s.jsonl" })],
      [trow({ id: "t" })],
    );

    const res = await sweepEmbeddings(db);

    // 1 session target + 1 topic target, neither embedded — retries next run.
    expect(res).toEqual({ ran: false, embedded: 0, errors: 0, pending: 2 });
    expect(topicStored).toEqual([]);
  });

  it("backfills a NULL-embedding article when Ollama is up (by article path)", async () => {
    vi.mocked(isOllamaAvailableCached).mockResolvedValue(true);
    const { db, articleStored } = fakeDb(
      [],
      [],
      [arow({ path: "/Users/x/vault/raw/llm-routing.md" })],
    );

    const res = await sweepEmbeddings(db);

    expect(res).toEqual({ ran: true, embedded: 1, errors: 0, pending: 0 });
    expect(articleStored).toEqual([
      { path: "/Users/x/vault/raw/llm-routing.md", vec: [0.1, 0.2, 0.3] },
    ]);
  });

  it("counts an article embedding failure as pending, not stored", async () => {
    vi.mocked(isOllamaAvailableCached).mockResolvedValue(true);
    vi.mocked(embeddingForNote).mockResolvedValueOnce(null);
    const { db, articleStored } = fakeDb([], [], [arow({ path: "/fail.md" })]);

    const res = await sweepEmbeddings(db);

    expect(res).toEqual({ ran: true, embedded: 0, errors: 1, pending: 1 });
    expect(articleStored).toEqual([]);
  });

  it("counts pending articles (alongside sessions + topics) when Ollama is down", async () => {
    vi.mocked(isOllamaAvailableCached).mockResolvedValueOnce(false);
    const { db, articleStored } = fakeDb(
      [row({ path: "/s.jsonl" })],
      [trow({ id: "t" })],
      [arow({ path: "/a.md" })],
    );

    const res = await sweepEmbeddings(db);

    // 1 session + 1 topic + 1 article target, none embedded — retries next run.
    expect(res).toEqual({ ran: false, embedded: 0, errors: 0, pending: 3 });
    expect(articleStored).toEqual([]);
  });

  it("backfills a NULL-embedding pdf when Ollama is up (by pdf path)", async () => {
    vi.mocked(isOllamaAvailableCached).mockResolvedValue(true);
    const { db, pdfStored } = fakeDb(
      [],
      [],
      [],
      [prow({ path: "/Users/x/papers/transformer.pdf" })],
    );

    const res = await sweepEmbeddings(db);

    expect(res).toEqual({ ran: true, embedded: 1, errors: 0, pending: 0 });
    expect(pdfStored).toEqual([
      { path: "/Users/x/papers/transformer.pdf", vec: [0.1, 0.2, 0.3] },
    ]);
  });

  it("counts a pdf embedding failure as pending, not stored", async () => {
    vi.mocked(isOllamaAvailableCached).mockResolvedValue(true);
    vi.mocked(embeddingForNote).mockResolvedValueOnce(null);
    const { db, pdfStored } = fakeDb([], [], [], [prow({ path: "/fail.pdf" })]);

    const res = await sweepEmbeddings(db);

    expect(res).toEqual({ ran: true, embedded: 0, errors: 1, pending: 1 });
    expect(pdfStored).toEqual([]);
  });

  it("counts pending pdfs (alongside sessions + topics + articles) when Ollama is down", async () => {
    vi.mocked(isOllamaAvailableCached).mockResolvedValueOnce(false);
    const { db, pdfStored } = fakeDb(
      [row({ path: "/s.jsonl" })],
      [trow({ id: "t" })],
      [arow({ path: "/a.md" })],
      [prow({ path: "/p.pdf" })],
    );

    const res = await sweepEmbeddings(db);

    // 1 session + 1 topic + 1 article + 1 pdf target, none embedded.
    expect(res).toEqual({ ran: false, embedded: 0, errors: 0, pending: 4 });
    expect(pdfStored).toEqual([]);
  });
});

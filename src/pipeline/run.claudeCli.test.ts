import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATE_PATH, type Config } from "../config.js";
import { CLAUDE_CLI_SESSION_CAP, runPipeline } from "./run.js";
import { ClaudeCliLimitError } from "./claudeCli.js";
import { MAX_DISTILL_ATTEMPTS } from "../state/db.js";

// Two claude-cli-specific run-loop behaviors:
// 1. A subscription limit is ONE environmental fact — halt the loop, burn no
//    attempt counters (the preflight-probe lesson).
// 2. Batch cap: quota has no meter, so a run through the subscription is
//    bounded; the remainder is deferred to the next cycle.
// 3. After a halt, the article/PDF/project-summary phases must not run: they
//    would hit the same wall and, before the fix, record every new article and
//    PDF as processed-with-error, never to be retried.
//
// StateDb is the real class with the session methods stubbed: article and PDF
// rows go through real SQL in the sandboxed $HOME, so the retry contract is
// tested against the actual isArticleProcessed / isPdfProcessed queries.

const spies = vi.hoisted(() => ({
  distill: vi.fn(async (): Promise<unknown> => null),
  recordError: vi.fn(),
  scan: vi.fn((): Array<{ path: string; hash: string }> => []),
  articles: vi.fn((): unknown[] => []),
  distillArticle: vi.fn(async (): Promise<unknown> => null),
  pdfs: vi.fn((): Array<{ filePath: string; hash: string }> => []),
  parsePdf: vi.fn(async (filePath: string) => ({
    filePath,
    hash: "unused",
    title: "Paper",
    text: "body",
    pageCount: 1,
  })),
  distillPdf: vi.fn(async (): Promise<unknown> => null),
  summarize: vi.fn(async () => null),
}));

vi.mock("../state/db.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../state/db.js")>();
  return {
    ...real,
    StateDb: class extends real.StateDb {
      isProcessed = vi.fn(() => false);
      retryExhausted = vi.fn(() => false);
      isPruned = vi.fn(() => false);
      record = vi.fn();
      recordError = spies.recordError;
      getByPath = vi.fn(() => undefined);
      listDistilled = vi.fn(() => []);
      listEmbeddingTargets = vi.fn(() => []);
      listTopicEmbeddingTargets = vi.fn(() => []);
      listArticleEmbeddingTargets = vi.fn(() => []);
      listPdfEmbeddingTargets = vi.fn(() => []);
    },
  };
});

vi.mock("./writer.js", () => ({
  kebab: (s: string) => s,
  VaultWriter: class {
    write = vi.fn(async (): Promise<string[]> => []);
    writeArticle = vi.fn(async () => "/vault/vir/articles/a.md");
    writePdf = vi.fn(async () => "/vault/vir/pdfs/p.md");
    flushPendingEmbeddings = vi.fn();
    embeddingText = undefined;
    regenerateIndex = vi.fn();
  },
}));

vi.mock("./articleReader.js", () => ({
  scanArticles: () => spies.articles(),
}));

vi.mock("./articleDistiller.js", () => ({
  distillArticle: spies.distillArticle,
}));

vi.mock("./pdfReader.js", () => ({
  scanPdfs: () => spies.pdfs(),
  parsePdf: spies.parsePdf,
}));

vi.mock("./pdfDistiller.js", () => ({
  distillPdf: spies.distillPdf,
}));

vi.mock("./summarizer.js", () => ({
  summarizeProject: spies.summarize,
}));

vi.mock("./scanner.js", () => ({
  scanSessions: () => spies.scan(),
}));

vi.mock("./parser.js", () => ({
  parseSession: (path: string) => ({
    path,
    hash: "h-new",
    sessionId: path,
    projectSlug: "demo",
    startedAt: null,
    endedAt: null,
    lineCount: 10,
    toolCallCount: 0,
    filesTouched: [],
    assistantText: "a",
    userText: "u",
    rawSummary: "s",
    transcriptText: "t",
  }),
}));

vi.mock("./filter.js", () => ({
  scoreSession: () => ({ passes: true, score: 10 }),
}));

vi.mock("./distiller.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./distiller.js")>();
  return {
    ...real,
    probeProvider: vi.fn(async () => {}),
    Distiller: class {
      run = spies.distill;
    },
  };
});

vi.mock("./embeddingSweep.js", () => ({
  sweepEmbeddings: async () => ({ ran: false, embedded: 0, errors: 0, pending: 0 }),
}));

function sessions(n: number): Array<{ path: string; hash: string }> {
  return Array.from({ length: n }, (_, i) => ({
    path: `/t/sess-${i}.jsonl`,
    hash: `h-${i}`,
  }));
}

function cfg(provider: "anthropic" | "claude-cli"): Config {
  return {
    vaultPath: "/tmp/vir-test-vault",
    outputDir: "Vir",
    claudeProjectsDir: "/tmp/vir-test-projects",
    provider,
    anthropicApiKey: "sk-ant-test",
    filterThreshold: 1,
    projects: { t: "include" },
    models: { classify: "claude-haiku-4-5-20251001", distill: "claude-sonnet-5" },
  } as unknown as Config;
}

function withDocs(provider: "anthropic" | "claude-cli"): Config {
  return {
    ...cfg(provider),
    articlesDir: "/tmp/vir-test-articles",
    distillArticles: true,
    pdfsDir: "/tmp/vir-test-pdfs",
    distillPdfs: true,
  } as Config;
}

function article(filePath: string, hash: string): unknown {
  return { filePath, hash, title: "Clip", tags: [], body: "b", wordCount: 1 };
}

const sessionNote = {
  markdown: "note",
  classification: {
    category: "patterns",
    topic: "t",
    project: "demo",
    confidence: 0.7,
  },
};
const docNote = {
  markdown: "doc note",
  classification: { category: "concept", confidence: 0.7 },
};

// Raw view of the doc tables, independent of the code under test.
function docRow(
  table: "articles" | "pdfs",
  path: string,
): { hash: string; error: string | null } | undefined {
  const db = new Database(STATE_PATH, { readonly: true });
  try {
    return db
      .prepare(`SELECT hash, error FROM ${table} WHERE path = ?`)
      .get(path) as { hash: string; error: string | null } | undefined;
  } finally {
    db.close();
  }
}

// The run loop sleeps 2s after every successful distill; tests that distill
// for real skip that pacing delay and nothing else.
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    if (ms === 2000) {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);
});
afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  spies.distill.mockReset();
  spies.distill.mockResolvedValue(null);
  spies.recordError.mockClear();
  spies.scan.mockReset();
  spies.articles.mockReset();
  spies.articles.mockReturnValue([]);
  spies.distillArticle.mockReset();
  spies.pdfs.mockReset();
  spies.pdfs.mockReturnValue([]);
  spies.parsePdf.mockClear();
  spies.distillPdf.mockReset();
  spies.summarize.mockClear();
});

describe("runPipeline — subscription limit halts the run", () => {
  it("stops after the first ClaudeCliLimitError, burns NO attempt counters, reports the halt", async () => {
    spies.scan.mockReturnValue(sessions(3));
    spies.distill.mockRejectedValue(
      new ClaudeCliLimitError("session", "3:45pm"),
    );

    const summary = await runPipeline(cfg("claude-cli"), { quiet: true });

    // One environmental fact, not three individual failures.
    expect(spies.distill).toHaveBeenCalledTimes(1);
    // The wall must not increment the 3-strike park counter.
    expect(spies.recordError).not.toHaveBeenCalled();
    expect(summary.limitHalted).toContain("3:45pm");
    expect(summary.errored).toBe(0);
  });

  it("an ordinary distill error still records per-session and continues (halt is limit-only)", async () => {
    spies.scan.mockReturnValue(sessions(2));
    spies.distill.mockRejectedValue(new Error("plain failure"));

    const summary = await runPipeline(cfg("claude-cli"), { quiet: true });

    expect(spies.distill).toHaveBeenCalledTimes(2);
    expect(spies.recordError).toHaveBeenCalledTimes(2);
    expect(summary.limitHalted).toBeNull();
  });
});

describe("runPipeline — claude-cli batch cap", () => {
  it("caps distills per run and reports the deferred remainder", async () => {
    spies.scan.mockReturnValue(sessions(CLAUDE_CLI_SESSION_CAP + 4));

    const summary = await runPipeline(cfg("claude-cli"), { quiet: true });

    expect(spies.distill).toHaveBeenCalledTimes(CLAUDE_CLI_SESSION_CAP);
    expect(summary.capDeferred).toBe(4);
  });

  it("does not cap the API path", async () => {
    spies.scan.mockReturnValue(sessions(CLAUDE_CLI_SESSION_CAP + 4));

    const summary = await runPipeline(cfg("anthropic"), { quiet: true });

    expect(spies.distill).toHaveBeenCalledTimes(CLAUDE_CLI_SESSION_CAP + 4);
    expect(summary.capDeferred).toBe(0);
  });
});

describe("runPipeline — a limit halt skips the later LLM phases", () => {
  it("halt in the session loop → no article/PDF distill, no doc rows, no project summary", async () => {
    // Three notes for "demo" would normally trigger a project summary.
    spies.scan.mockReturnValue(sessions(4));
    spies.distill
      .mockResolvedValueOnce(sessionNote)
      .mockResolvedValueOnce(sessionNote)
      .mockResolvedValueOnce(sessionNote)
      .mockRejectedValue(new ClaudeCliLimitError("session", "3:45pm"));
    // Were the phases to run, every item would hit the same wall.
    spies.articles.mockReturnValue([article("/a/halted.md", "ha")]);
    spies.distillArticle.mockRejectedValue(
      new ClaudeCliLimitError("session", "3:45pm"),
    );
    spies.pdfs.mockReturnValue([{ filePath: "/p/halted.pdf", hash: "hp" }]);
    spies.distillPdf.mockRejectedValue(
      new ClaudeCliLimitError("session", "3:45pm"),
    );

    const summary = await runPipeline(withDocs("claude-cli"), { quiet: true });

    expect(summary.limitHalted).toContain("3:45pm");
    expect(spies.distillArticle).not.toHaveBeenCalled();
    expect(spies.parsePdf).not.toHaveBeenCalled();
    expect(spies.distillPdf).not.toHaveBeenCalled();
    expect(spies.summarize).not.toHaveBeenCalled();
    expect(docRow("articles", "/a/halted.md")).toBeUndefined();
    expect(docRow("pdfs", "/p/halted.pdf")).toBeUndefined();
    expect(summary.articlesErrored).toBe(0);
    expect(summary.pdfsErrored).toBe(0);
  });

  it("without a halt the doc phases and project summary still run", async () => {
    spies.scan.mockReturnValue(sessions(3));
    spies.distill.mockResolvedValue(sessionNote);
    spies.articles.mockReturnValue([article("/a/normal.md", "hn")]);
    spies.distillArticle.mockResolvedValue(docNote);

    const summary = await runPipeline(withDocs("claude-cli"), { quiet: true });

    expect(summary.limitHalted).toBeNull();
    expect(spies.distillArticle).toHaveBeenCalledTimes(1);
    expect(spies.summarize).toHaveBeenCalledTimes(1);
    expect(docRow("articles", "/a/normal.md")).toEqual({ hash: "hn", error: null });
  });
});

describe("runPipeline — errored articles and PDFs retry", () => {
  it("an errored article is retried on the next run and recorded clean", async () => {
    spies.articles.mockReturnValue([article("/a/flaky.md", "hf")]);
    spies.distillArticle
      .mockRejectedValueOnce(new Error("kie 500"))
      .mockResolvedValueOnce(docNote);

    const first = await runPipeline(withDocs("anthropic"), { quiet: true });
    expect(first.articlesErrored).toBe(1);
    expect(docRow("articles", "/a/flaky.md")).toEqual({
      hash: "hf",
      error: "kie 500",
    });

    const second = await runPipeline(withDocs("anthropic"), { quiet: true });
    expect(spies.distillArticle).toHaveBeenCalledTimes(2);
    expect(second.articlesDistilled).toBe(1);
    expect(docRow("articles", "/a/flaky.md")).toEqual({ hash: "hf", error: null });
  });

  it("an errored PDF is retried on the next run and recorded clean", async () => {
    spies.pdfs.mockReturnValue([{ filePath: "/p/flaky.pdf", hash: "hpf" }]);
    spies.parsePdf.mockImplementation(async (filePath: string) => ({
      filePath,
      hash: "hpf",
      title: "Paper",
      text: "body",
      pageCount: 1,
    }));
    spies.distillPdf
      .mockRejectedValueOnce(new Error("kie 500"))
      .mockResolvedValueOnce(docNote);

    await runPipeline(withDocs("anthropic"), { quiet: true });
    expect(docRow("pdfs", "/p/flaky.pdf")?.error).toBe("kie 500");

    const second = await runPipeline(withDocs("anthropic"), { quiet: true });
    expect(spies.distillPdf).toHaveBeenCalledTimes(2);
    expect(second.pdfsDistilled).toBe(1);
    expect(docRow("pdfs", "/p/flaky.pdf")).toEqual({ hash: "hpf", error: null });
  });
});

describe("runPipeline — errored doc rows left by earlier versions", () => {
  it("an article and a PDF already stored with error + the same hash are retried on the first run", async () => {
    // Create the schema, then write the rows with raw SQL, exactly as the
    // pre-fix error path left them (skipped=0, error set, source hash).
    new (await import("../state/db.js")).StateDb().close();
    const raw = new Database(STATE_PATH);
    const at = "2026-09-01T00:00:00.000Z";
    raw
      .prepare("INSERT INTO articles (path, hash, processed_at, skipped, error) VALUES (?, ?, ?, 0, ?)")
      .run("/a/legacy.md", "hl", at, "claude-cli limit reached");
    raw
      .prepare("INSERT INTO pdfs (path, hash, processed_at, skipped, error) VALUES (?, ?, ?, 0, ?)")
      .run("/p/legacy.pdf", "hlp", at, "claude-cli limit reached");
    raw.close();

    spies.articles.mockReturnValue([article("/a/legacy.md", "hl")]);
    spies.distillArticle.mockResolvedValue(docNote);
    spies.pdfs.mockReturnValue([{ filePath: "/p/legacy.pdf", hash: "hlp" }]);
    spies.parsePdf.mockImplementation(async (filePath: string) => ({
      filePath,
      hash: "hlp",
      title: "Paper",
      text: "body",
      pageCount: 1,
    }));
    spies.distillPdf.mockResolvedValue(docNote);

    const summary = await runPipeline(withDocs("anthropic"), { quiet: true });

    expect(spies.distillArticle).toHaveBeenCalledTimes(1);
    expect(spies.distillPdf).toHaveBeenCalledTimes(1);
    expect(summary.articlesDistilled).toBe(1);
    expect(summary.pdfsDistilled).toBe(1);
    expect(docRow("articles", "/a/legacy.md")).toEqual({ hash: "hl", error: null });
    expect(docRow("pdfs", "/p/legacy.pdf")).toEqual({ hash: "hlp", error: null });
  });
});

describe("runPipeline — doc retry bound", () => {
  it(`an article failing ${MAX_DISTILL_ATTEMPTS} runs in a row is not tried again; editing it retries`, async () => {
    spies.articles.mockReturnValue([article("/a/stubborn.md", "hs")]);
    spies.distillArticle.mockRejectedValue(new Error("context too long"));

    for (let i = 0; i < MAX_DISTILL_ATTEMPTS + 1; i++) {
      await runPipeline(withDocs("anthropic"), { quiet: true });
    }
    expect(spies.distillArticle).toHaveBeenCalledTimes(MAX_DISTILL_ATTEMPTS);

    spies.articles.mockReturnValue([article("/a/stubborn.md", "hs-edited")]);
    spies.distillArticle.mockResolvedValue(docNote);
    const summary = await runPipeline(withDocs("anthropic"), { quiet: true });
    expect(summary.articlesDistilled).toBe(1);
    expect(docRow("articles", "/a/stubborn.md")).toEqual({ hash: "hs-edited", error: null });
  });

  it("a limit first hit in the article phase halts both doc phases and records nothing", async () => {
    spies.articles.mockReturnValue([
      article("/a/wall-1.md", "hw1"),
      article("/a/wall-2.md", "hw2"),
    ]);
    spies.distillArticle.mockRejectedValue(new ClaudeCliLimitError("session", "3:45pm"));
    spies.pdfs.mockReturnValue([{ filePath: "/p/wall.pdf", hash: "hwp" }]);

    const summary = await runPipeline(withDocs("claude-cli"), { quiet: true });

    expect(summary.limitHalted).toContain("3:45pm");
    expect(spies.distillArticle).toHaveBeenCalledTimes(1);
    expect(spies.parsePdf).not.toHaveBeenCalled();
    expect(summary.articlesErrored).toBe(0);
    // No row means no attempt burned: the wall is not the article's fault.
    expect(docRow("articles", "/a/wall-1.md")).toBeUndefined();
    expect(docRow("articles", "/a/wall-2.md")).toBeUndefined();
  });

  it("a limit first hit in the PDF phase halts it and records nothing", async () => {
    spies.pdfs.mockReturnValue([
      { filePath: "/p/wall-1.pdf", hash: "hp1" },
      { filePath: "/p/wall-2.pdf", hash: "hp2" },
    ]);
    spies.distillPdf.mockRejectedValue(new ClaudeCliLimitError("session", "3:45pm"));

    const summary = await runPipeline(withDocs("claude-cli"), { quiet: true });

    expect(summary.limitHalted).toContain("3:45pm");
    expect(spies.distillPdf).toHaveBeenCalledTimes(1);
    expect(summary.pdfsErrored).toBe(0);
    expect(docRow("pdfs", "/p/wall-1.pdf")).toBeUndefined();
    expect(docRow("pdfs", "/p/wall-2.pdf")).toBeUndefined();
  });
});

describe("runPipeline --full also re-processes articles and PDFs", () => {
  it("re-distills a clean, already-processed article and PDF", async () => {
    spies.articles.mockReturnValue([article("/a/full.md", "hfull")]);
    spies.distillArticle.mockResolvedValue(docNote);
    spies.pdfs.mockReturnValue([{ filePath: "/p/full.pdf", hash: "hfullp" }]);
    spies.parsePdf.mockImplementation(async (filePath: string) => ({
      filePath,
      hash: "hfullp",
      title: "Paper",
      text: "body",
      pageCount: 1,
    }));
    spies.distillPdf.mockResolvedValue(docNote);

    await runPipeline(withDocs("anthropic"), { quiet: true });
    await runPipeline(withDocs("anthropic"), { quiet: true });
    expect(spies.distillArticle).toHaveBeenCalledTimes(1);
    expect(spies.distillPdf).toHaveBeenCalledTimes(1);

    await runPipeline(withDocs("anthropic"), { quiet: true, full: true });
    expect(spies.distillArticle).toHaveBeenCalledTimes(2);
    expect(spies.distillPdf).toHaveBeenCalledTimes(2);
  });
});

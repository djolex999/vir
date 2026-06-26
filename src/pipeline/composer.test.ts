import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { StateDb } from "../state/db.js";
import { callLLM } from "./distiller.js";
import { VaultWriter } from "./writer.js";
import {
  buildComposeFrontmatter,
  buildComposePrompt,
  composeFromSources,
  composeRelPath,
  composeSlug,
  gatherSources,
  parseComposeResponse,
  type SourceNote,
} from "./composer.js";

// Stub the LLM so the orchestrator runs end-to-end offline and deterministically.
vi.mock("./distiller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./distiller.js")>();
  return {
    ...actual,
    callLLM: vi.fn(
      async () =>
        "TITLE: Auth Flow Patterns\nCONFIDENCE: 0.9\n\n## Overview\n\nAll three notes converge on JWT access tokens with refresh rotation.",
    ),
  };
});

// Force search down the TF-IDF path (no embeddings) and make the writer's
// best-effort embed a no-op, so the test never touches the network.
vi.mock("../search/embedder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../search/embedder.js")>();
  return {
    ...actual,
    isOllamaAvailable: vi.fn(async () => false),
    isOllamaAvailableCached: vi.fn(async () => false),
  };
});

const SOURCES: SourceNote[] = [
  {
    slug: "auth-flow-abc12345",
    title: "patterns/auth-flow-abc12345",
    content: "---\ntopic: auth flow\n---\nUse JWT with refresh tokens.",
    score: 0.91,
  },
  {
    slug: "oauth-pkce-def67890",
    title: "articles/oauth-pkce-def67890",
    content: "---\ntype: article\n---\nPKCE protects public clients.",
    score: 0.77,
  },
];

describe("composeSlug", () => {
  it("kebab-cases a topic", () => {
    expect(composeSlug("Auth Flow Patterns")).toBe("auth-flow-patterns");
  });

  it("strips punctuation and collapses separators", () => {
    expect(composeSlug("OAuth 2.0 / PKCE!!")).toBe("oauth-2-0-pkce");
  });

  it("caps slug length at 60 chars with no trailing dash", () => {
    const slug = composeSlug("word ".repeat(40));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back to 'topic' for empty or symbol-only input", () => {
    expect(composeSlug("")).toBe("topic");
    expect(composeSlug("!!!")).toBe("topic");
  });

  it("is stable: same topic yields the same slug", () => {
    expect(composeSlug("auth flow")).toBe(composeSlug("auth flow"));
  });
});

describe("composeRelPath", () => {
  it("files topic pages under topics/<slug>.md", () => {
    expect(composeRelPath("auth-flow-patterns")).toBe(
      "topics/auth-flow-patterns.md",
    );
  });
});

describe("buildComposePrompt", () => {
  it("includes the topic and every source's body", () => {
    const p = buildComposePrompt("auth flow patterns", SOURCES);
    expect(p).toContain("auth flow patterns");
    expect(p).toContain("Use JWT with refresh tokens.");
    expect(p).toContain("PKCE protects public clients.");
  });

  it("asks for TITLE/CONFIDENCE markers and forbids a Sources section", () => {
    const p = buildComposePrompt("x", SOURCES);
    expect(p).toContain("TITLE:");
    expect(p).toContain("CONFIDENCE:");
    expect(p).toContain("Sources section");
  });
});

describe("parseComposeResponse", () => {
  it("extracts title, confidence, and the markdown content", () => {
    const r = parseComposeResponse(
      "TITLE: Auth Flow Patterns\nCONFIDENCE: 0.9\n\n## Overview\n\nUse JWT.",
    );
    expect(r.title).toBe("Auth Flow Patterns");
    expect(r.confidence).toBeCloseTo(0.9);
    expect(r.content).toBe("## Overview\n\nUse JWT.");
  });

  it("clamps confidence to [0,1]", () => {
    expect(
      parseComposeResponse("TITLE: X\nCONFIDENCE: 5\n\nbody").confidence,
    ).toBe(1);
    expect(
      parseComposeResponse("TITLE: X\nCONFIDENCE: -3\n\nbody").confidence,
    ).toBe(0);
  });

  it("defaults title to '' and confidence to 0 when markers are absent", () => {
    const r = parseComposeResponse("## Just content\n\nno header here");
    expect(r.title).toBe("");
    expect(r.confidence).toBe(0);
    expect(r.content).toContain("## Just content");
  });

  it("strips a redundant leading H1 the model may emit", () => {
    const r = parseComposeResponse("TITLE: T\nCONFIDENCE: 0.5\n\n# T\n\nbody");
    expect(r.content).toBe("body");
  });
});

describe("buildComposeFrontmatter", () => {
  const base = {
    title: 'Auth "Flow" Patterns',
    topicQuery: "auth flow patterns",
    sources: SOURCES,
    confidence: 0.88,
    model: "claude-sonnet-4-6",
    created: "2026-05-28",
    updated: "2026-05-29",
  };

  it("emits type:topic and every scalar field", () => {
    const fm = buildComposeFrontmatter(base);
    expect(fm).toMatch(/^---\n/);
    expect(fm).toContain("type: topic");
    expect(fm).toContain('title: "Auth \\"Flow\\" Patterns"');
    expect(fm).toContain('topic_query: "auth flow patterns"');
    expect(fm).toContain("confidence: 0.88");
    expect(fm).toContain("model: claude-sonnet-4-6");
    expect(fm).toContain("created: 2026-05-28");
    expect(fm).toContain("updated: 2026-05-29");
  });

  it("lists sources as quoted wikilinks under a sources: block", () => {
    const fm = buildComposeFrontmatter(base);
    expect(fm).toContain("sources:");
    expect(fm).toContain('  - "[[auth-flow-abc12345]]"');
    expect(fm).toContain('  - "[[oauth-pkce-def67890]]"');
  });

  it("closes the frontmatter block", () => {
    expect(buildComposeFrontmatter(base).endsWith("---\n")).toBe(true);
  });
});

describe("compose orchestration (end-to-end, LLM mocked)", () => {
  let vault: string;
  let dbPath: string;
  let db: StateDb;

  function cfg(): Config {
    return {
      vaultPath: vault,
      outputDir: "vir",
      topicsDir: "topics",
      claudeProjectsDir: "/tmp/claude-projects",
      cadenceHours: 3,
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
      kieTopUpTier: "standard",
      filterThreshold: 0.4,
      distillArticles: true,
      distillPdfs: true,
      filterToolCalls: "moderate",
      retrievalDiversity: 0.3,
      models: {
        classify: "claude-haiku-4-5-20251001",
        distill: "claude-sonnet-4-6",
      },
    };
  }

  function writeNote(slug: string, body: string): void {
    writeFileSync(
      join(vault, "vir", "patterns", `${slug}.md`),
      `---\ntopic: ${slug}\ncategory: pattern\n---\n${body}\n`,
    );
  }

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "vir-compose-"));
    dbPath = join(vault, "state.db");
    db = new StateDb(dbPath);
    mkdirSync(join(vault, "vir", "patterns"), { recursive: true });
    // Three notes about the topic + one decoy. The decoy keeps document
    // frequency below the corpus size so TF-IDF idf is nonzero for "auth"/"flow".
    writeNote("auth-jwt-aaa11111", "The auth flow issues a short JWT access token.");
    writeNote("auth-refresh-bbb22222", "The auth flow rotates a refresh token on every login.");
    writeNote("auth-oauth-ccc33333", "The auth flow delegates login to an OAuth provider.");
    writeNote("db-migrations-ddd44444", "Database migrations should always be additive only.");
  });

  afterEach(() => {
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("materializes a topic note linking every gathered source", async () => {
    const sources = await gatherSources(cfg(), db, "auth flow", 10);
    expect(sources.length).toBe(3);
    expect(sources.some((s) => s.slug.startsWith("db-migrations"))).toBe(false);

    const writer = new VaultWriter(cfg(), db);
    const result = await composeFromSources(cfg(), db, "auth flow", sources, writer);

    expect(result.relPath).toBe("topics/auth-flow.md");
    expect(result.title).toBe("Auth Flow Patterns");
    expect(result.sourceCount).toBe(3);

    const note = readFileSync(join(vault, "vir", result.relPath), "utf8");
    expect(note).toContain("type: topic");
    expect(note).toContain("# Auth Flow Patterns");
    expect(note).toContain("## Sources");
    for (const s of sources) expect(note).toContain(`[[${s.slug}]]`);

    const row = db.getTopic("auth-flow");
    expect(row?.sourceNoteIds).toHaveLength(3);
    expect(row?.confidence).toBeCloseTo(0.9);
  });

  it("preserves created_at but bumps updated_at on re-compose", async () => {
    const sources = await gatherSources(cfg(), db, "auth flow", 10);
    const writer = new VaultWriter(cfg(), db);

    await composeFromSources(cfg(), db, "auth flow", sources, writer);
    const first = db.getTopic("auth-flow");
    expect(first).toBeDefined();

    await new Promise((r) => setTimeout(r, 5));
    await composeFromSources(cfg(), db, "auth flow", sources, writer);
    const second = db.getTopic("auth-flow");

    expect(second!.createdAt).toBe(first!.createdAt);
    expect(second!.updatedAt >= first!.updatedAt).toBe(true);
  });

  it("throws (writes nothing) when synthesis returns empty content", async () => {
    const sources = await gatherSources(cfg(), db, "auth flow", 10);
    const writer = new VaultWriter(cfg(), db);
    vi.mocked(callLLM).mockResolvedValueOnce("   \n  ");

    await expect(
      composeFromSources(cfg(), db, "auth flow", sources, writer),
    ).rejects.toThrow(/no content/i);
    expect(db.getTopic("auth-flow")).toBeUndefined();
  });
});

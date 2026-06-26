import { describe, expect, it } from "vitest";
import {
  buildDoctorResult,
  buildQueryResults,
  classifyDaemonHealth,
  errorPayload,
  type DoctorInputs,
} from "./json.js";
import type { SearchHit } from "../search/retriever.js";

const VAULT_ROOT = "/vault/vir";

function hit(partial: Partial<SearchHit> & { filePath: string; content: string }): SearchHit {
  return {
    title: partial.filePath.replace(/\.md$/, ""),
    score: 0.5,
    method: "tfidf",
    ...partial,
  };
}

const sessionNote = (overrides: Record<string, string> = {}) => {
  const fm = {
    type: "session",
    category: "pattern",
    topic: "Auth flow",
    project: "growthq",
    confidence: "0.82",
    date: "2026-05-12T09:30:00.000Z",
    ...overrides,
  };
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${yaml}\n---\n\nThe auth flow   uses JWT\nwith refresh tokens.`;
};

describe("buildQueryResults", () => {
  it("maps a session hit to the wire schema", () => {
    const hits = [
      hit({
        filePath: "/vault/vir/patterns/auth-flow-2026-05-12.md",
        content: sessionNote(),
        score: 0.91,
      }),
    ];
    const [r] = buildQueryResults(hits, VAULT_ROOT);
    expect(r).toEqual({
      path: "patterns/auth-flow-2026-05-12.md",
      score: 0.91,
      category: "pattern",
      confidence: 0.82,
      preview: "The auth flow uses JWT with refresh tokens.",
      project: "growthq",
      date: "2026-05-12T09:30:00.000Z",
    });
  });

  it("collapses whitespace and caps preview near 200 chars", () => {
    const long = "word ".repeat(100);
    const [r] = buildQueryResults(
      [hit({ filePath: "/vault/vir/gotchas/x.md", content: `---\ncategory: gotcha\n---\n${long}` })],
      VAULT_ROOT,
    );
    expect(r!.preview.length).toBeLessThanOrEqual(200);
    expect(r!.preview).not.toContain("  ");
  });

  it("classifies article notes as the 'article' category", () => {
    const [r] = buildQueryResults(
      [
        hit({
          filePath: "/vault/vir/articles/some-essay.md",
          content: "---\ntype: article\ncategory: concept\nsource_url: https://x.dev\n---\nBody.",
        }),
      ],
      VAULT_ROOT,
    );
    expect(r!.category).toBe("article");
  });

  it("falls back to the directory when category frontmatter is missing", () => {
    const [r] = buildQueryResults(
      [hit({ filePath: "/vault/vir/decisions/d.md", content: "---\ntopic: t\n---\nBody." })],
      VAULT_ROOT,
    );
    expect(r!.category).toBe("decision");
  });

  it("returns null project when empty and 0 confidence when absent", () => {
    const [r] = buildQueryResults(
      [hit({ filePath: "/vault/vir/tools/t.md", content: "---\ncategory: tool\nproject:\n---\nBody." })],
      VAULT_ROOT,
    );
    expect(r!.project).toBeNull();
    expect(r!.confidence).toBe(0);
  });

  it("preserves input order and returns [] for no hits", () => {
    expect(buildQueryResults([], VAULT_ROOT)).toEqual([]);
  });

  it("includes topic notes with category 'topic' (plugin parses permissively)", () => {
    const results = buildQueryResults(
      [
        hit({
          filePath: "/vault/vir/patterns/auth-flow-abc.md",
          content: sessionNote(),
        }),
        hit({
          filePath: "/vault/vir/topics/auth-flow-patterns.md",
          content:
            "---\ntype: topic\ntitle: Auth\nconfidence: 0.9\n---\n# Auth\n\nbody",
        }),
      ],
      VAULT_ROOT,
    );
    expect(results).toHaveLength(2);
    const topic = results.find((r) => r.path.startsWith("topics/"));
    expect(topic).toBeDefined();
    expect(topic!.category).toBe("topic");
  });

  it("surfaces a topics/ note with category 'topic' and an excerpt", () => {
    const [r] = buildQueryResults(
      [
        hit({
          filePath: "/vault/vir/topics/jwt-refresh.md",
          content:
            '---\ntype: topic\ntitle: "JWT refresh"\nconfidence: 0.9\n---\n# JWT refresh\n\nRotate refresh tokens on every use.',
          score: 0.77,
        }),
      ],
      VAULT_ROOT,
    );
    expect(r).toEqual({
      path: "topics/jwt-refresh.md",
      score: 0.77,
      category: "topic",
      confidence: 0.9,
      preview: "# JWT refresh Rotate refresh tokens on every use.",
      project: null,
      date: "",
    });
  });

  it("surfaces a pdfs/ note with category 'pdf' (sub-taxonomy collapses to the wire bucket)", () => {
    const [r] = buildQueryResults(
      [
        hit({
          filePath: "/vault/vir/pdfs/attention-abc12345.md",
          content:
            '---\ntype: pdf\ncategory: paper\nsource_title: "Attention"\nconfidence: 0.92\n---\nBody about self-attention.',
          score: 0.81,
        }),
      ],
      VAULT_ROOT,
    );
    expect(r!.path).toBe("pdfs/attention-abc12345.md");
    expect(r!.category).toBe("pdf");
    expect(r!.confidence).toBe(0.92);
  });

  it("honors a configured topicsDir when classifying by directory", () => {
    // No `type: topic` frontmatter, so classification falls through to the
    // directory — which is the renamed topicsDir, not the default "topics".
    const [r] = buildQueryResults(
      [hit({ filePath: "/vault/vir/syntheses/jwt.md", content: "---\ntitle: JWT\n---\nBody about jwt." })],
      VAULT_ROOT,
      "syntheses",
    );
    expect(r!.category).toBe("topic");
  });
});

describe("errorPayload", () => {
  it("returns a kind + human message", () => {
    expect(errorPayload("no_vault", "config missing")).toEqual({
      error: "config missing",
      kind: "no_vault",
    });
  });
});

describe("classifyDaemonHealth", () => {
  const cadence = 3; // hours → window is 6h
  const now = new Date("2026-05-27T12:00:00.000Z");

  it("is 'down' when the scheduler is not installed", () => {
    expect(classifyDaemonHealth(false, now.toISOString(), cadence, now)).toBe("down");
  });

  it("is 'down' when no poll record exists", () => {
    expect(classifyDaemonHealth(true, null, cadence, now)).toBe("down");
  });

  it("is 'down' when the poll timestamp is unparseable", () => {
    expect(classifyDaemonHealth(true, "not-a-date", cadence, now)).toBe("down");
  });

  it("is 'ok' when the last poll is within 2x the polling interval", () => {
    const poll = new Date(now.getTime() - 5 * 3600_000).toISOString(); // 5h ago < 6h
    expect(classifyDaemonHealth(true, poll, cadence, now)).toBe("ok");
  });

  it("is 'stale' when the last poll is older than 2x the polling interval", () => {
    const poll = new Date(now.getTime() - 7 * 3600_000).toISOString(); // 7h ago > 6h
    expect(classifyDaemonHealth(true, poll, cadence, now)).toBe("stale");
  });
});

describe("buildDoctorResult", () => {
  const base: DoctorInputs = {
    daemonInstalled: true,
    lastPollAt: "2026-05-27T11:00:00.000Z",
    lastDistillAt: "2026-05-27T10:30:00.000Z",
    dbSizeMb: 1.5,
    vaultPath: "/vault/vir",
    configValid: true,
    ollamaReachable: true,
    ollamaModel: "nomic-embed-text",
    cadenceHours: 3,
    version: "0.7.1",
    now: new Date("2026-05-27T12:00:00.000Z"),
  };

  it("assembles the wire schema and classifies the daemon", () => {
    expect(buildDoctorResult(base)).toEqual({
      daemon: "ok",
      lastPollAt: "2026-05-27T11:00:00.000Z",
      lastDistillAt: "2026-05-27T10:30:00.000Z",
      dbSizeMb: 1.5,
      vaultPath: "/vault/vir",
      configValid: true,
      ollama: { reachable: true, model: "nomic-embed-text" },
      version: "0.7.1",
    });
  });

  it("reports ollama model as null when unreachable", () => {
    const r = buildDoctorResult({ ...base, ollamaReachable: false, ollamaModel: null });
    expect(r.ollama).toEqual({ reachable: false, model: null });
  });
});

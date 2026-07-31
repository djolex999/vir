import { describe, expect, it } from "vitest";
import {
  categorizeTranscriptHead,
  classifyTranscript,
  decideProject,
  decodeProjectName,
  estimateSessionCost,
  groupByProject,
  sniffAgentEntrypoint,
} from "./projects.js";

// Fixture mirroring the real shapes under ~/.claude/projects and the real
// directory tree they decode against — including every ambiguity class seen
// on a live machine: dashes in project names (vir-obsidian), dots encoded as
// dashes (pripremi.rs), an exact name with a longer sibling (TRAIN vs
// TRAIN-codex), a since-deleted cwd (~/qrmenu), and a transcript dir whose
// leaf no longer exists in any decodable form (venac3d-showcase-local).
const TREE: Record<string, string[]> = {
  "/": ["Users"],
  "/Users": ["djmarkovic999"],
  "/Users/djmarkovic999": ["projects", "Documents"],
  "/Users/djmarkovic999/projects": [
    "vir",
    "vir-obsidian",
    "pripremi.rs",
    "TRAIN",
    "TRAIN-codex",
    "sk2-detailing",
    "growthq",
    "Lume",
    "venac3d",
    "venac3d web showcase local",
  ],
  "/Users/djmarkovic999/projects/vir": ["src"],
  "/Users/djmarkovic999/projects/venac3d": ["src"],
};

const deps = { readDir: (p: string) => TREE[p] ?? [] };
const PROJECTS_DIR = "/Users/djmarkovic999/.claude/projects";

const decode = (dirName: string): string =>
  decodeProjectName(dirName, PROJECTS_DIR, deps);

describe("decodeProjectName", () => {
  it("decodes a simple project dir to its basename", () => {
    expect(decode("-Users-djmarkovic999-projects-vir")).toBe("vir");
  });

  it("resolves dash-ambiguity by longest on-disk match", () => {
    expect(decode("-Users-djmarkovic999-projects-vir-obsidian")).toBe(
      "vir-obsidian",
    );
  });

  it("recovers a real name whose dot was encoded as a dash", () => {
    expect(decode("-Users-djmarkovic999-projects-pripremi-rs")).toBe(
      "pripremi.rs",
    );
  });

  it("prefers the exact match when a longer sibling exists", () => {
    expect(decode("-Users-djmarkovic999-projects-TRAIN")).toBe("TRAIN");
  });

  it("keeps a dashed name that exists literally on disk", () => {
    expect(decode("-Users-djmarkovic999-projects-sk2-detailing")).toBe(
      "sk2-detailing",
    );
  });

  it("decodes a session run in the home dir to the home basename", () => {
    expect(decode("-Users-djmarkovic999")).toBe("djmarkovic999");
  });

  it("falls back to the raw dir name when the cwd no longer exists", () => {
    // ~/qrmenu was deleted; only ~/projects/qrmenu exists, which is a
    // different path — must not be guessed.
    expect(decode("-Users-djmarkovic999-qrmenu")).toBe(
      "-Users-djmarkovic999-qrmenu",
    );
  });

  it("falls back raw when the leaf resolves nowhere (backtracks out of a wrong prefix dir)", () => {
    // "venac3d" exists and matches a prefix, but nothing inside it completes
    // "showcase-local" — resolution must backtrack and give up, not return
    // a partial guess like "showcase-local".
    expect(decode("-Users-djmarkovic999-projects-venac3d-showcase-local")).toBe(
      "-Users-djmarkovic999-projects-venac3d-showcase-local",
    );
  });

  it("returns a non-pattern dir name unchanged", () => {
    expect(decode("some-random-dir")).toBe("some-random-dir");
  });

  it("accepts a full path under the projects dir", () => {
    expect(
      decode(`${PROJECTS_DIR}/-Users-djmarkovic999-projects-vir`),
    ).toBe("vir");
  });

  it("never throws when the filesystem is unreadable", () => {
    expect(
      decodeProjectName("-Users-djmarkovic999-projects-vir", PROJECTS_DIR, {
        readDir: () => [],
      }),
    ).toBe("-Users-djmarkovic999-projects-vir");
  });
});

describe("classifyTranscript — transcript category from real on-disk layout", () => {
  const enc = "-Users-djmarkovic999-projects-serbeval";

  it("a top-level session transcript is a session", () => {
    expect(
      classifyTranscript(`${PROJECTS_DIR}/${enc}/2ce5eb51-baba.jsonl`, PROJECTS_DIR),
    ).toBe("session");
  });

  it("subagents/workflows/wf_*/agent-*.jsonl is a workflow transcript", () => {
    expect(
      classifyTranscript(
        `${PROJECTS_DIR}/${enc}/2ce5eb51-baba/subagents/workflows/wf_eda96847-49f/agent-a01.jsonl`,
        PROJECTS_DIR,
      ),
    ).toBe("workflow");
  });

  it("subagents/agent-*.jsonl (no workflows segment) is a sidechain transcript", () => {
    expect(
      classifyTranscript(
        `${PROJECTS_DIR}/${enc}/395d2f80-c68f/subagents/agent-ae13.jsonl`,
        PROJECTS_DIR,
      ),
    ).toBe("sidechain");
  });

  it("a wf_* dir under subagents counts as workflow even without a workflows segment", () => {
    expect(
      classifyTranscript(
        `${PROJECTS_DIR}/${enc}/x/subagents/wf_abc123/agent-a1.jsonl`,
        PROJECTS_DIR,
      ),
    ).toBe("workflow");
  });

  it("a path outside the projects dir is a session (never guess)", () => {
    expect(classifyTranscript("/elsewhere/subagents/a.jsonl", PROJECTS_DIR)).toBe(
      "session",
    );
  });

  it("a project dir literally named subagents does not trigger the filter", () => {
    // subagents must appear BELOW the encoded project dir, not as it.
    expect(
      classifyTranscript(`${PROJECTS_DIR}/subagents/sess.jsonl`, PROJECTS_DIR),
    ).toBe("session");
  });
});

describe("sniffAgentEntrypoint — SDK launch signature from the transcript head", () => {
  const line = (obj: Record<string, unknown>): string => JSON.stringify(obj);

  it("returns the entrypoint when the first user line is SDK-launched", () => {
    const head = [
      line({ type: "queue-operation" }),
      line({
        type: "user",
        entrypoint: "sdk-py",
        promptSource: "sdk",
        message: { role: "user", content: "Review this change" },
      }),
    ].join("\n");
    expect(sniffAgentEntrypoint(head)).toBe("sdk-py");
  });

  it("covers future sdk-* entrypoints", () => {
    const head = line({ type: "user", entrypoint: "sdk-ts" });
    expect(sniffAgentEntrypoint(head)).toBe("sdk-ts");
  });

  it("returns null for an interactive CLI session", () => {
    const head = [
      line({ type: "queue-operation" }),
      line({ type: "user", entrypoint: "cli", promptSource: "typed" }),
    ].join("\n");
    expect(sniffAgentEntrypoint(head)).toBeNull();
  });

  it("promptSource sdk on a desktop-launched session does NOT classify as agent (the C23 trap)", () => {
    const head = line({
      type: "user",
      entrypoint: "claude-desktop",
      promptSource: "sdk",
    });
    expect(sniffAgentEntrypoint(head)).toBeNull();
  });

  it("only the FIRST user line decides — later sdk lines are ignored", () => {
    const head = [
      line({ type: "user", entrypoint: "claude-desktop" }),
      line({ type: "user", entrypoint: "sdk-py" }),
    ].join("\n");
    expect(sniffAgentEntrypoint(head)).toBeNull();
  });

  it("returns null when the head holds no complete user line (truncated) or garbage", () => {
    expect(sniffAgentEntrypoint("")).toBeNull();
    expect(sniffAgentEntrypoint("not json\n{broken")).toBeNull();
    expect(
      sniffAgentEntrypoint(
        line({ type: "queue-operation" }) + "\n" + '{"type":"user","entry',
      ),
    ).toBeNull();
  });
});

describe("categorizeTranscriptHead — init-wizard triage counts", () => {
  const line = (obj: Record<string, unknown>): string => JSON.stringify(obj);

  it("SDK-launched → agent", () => {
    const head = line({ type: "user", entrypoint: "sdk-py" });
    expect(categorizeTranscriptHead(head, head.length)).toBe("agent");
  });

  it("tiny complete transcript with no real session → stub", () => {
    const head = [
      line({ type: "queue-operation" }),
      line({ type: "user", entrypoint: "cli", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
    ].join("\n");
    expect(categorizeTranscriptHead(head, head.length)).toBe("stub");
  });

  it("anything else → interactive", () => {
    const lines = Array.from({ length: 40 }, (_, i) =>
      line({ type: "user", entrypoint: "cli", n: i }),
    ).join("\n");
    expect(categorizeTranscriptHead(lines, lines.length)).toBe("interactive");
  });

  it("a large file whose head is truncated is interactive even if few lines fit", () => {
    const head = line({ type: "user", entrypoint: "cli" });
    expect(categorizeTranscriptHead(head, head.length + 500_000)).toBe(
      "interactive",
    );
  });
});

describe("decideProject — three states plus one-off run flags", () => {
  const cfg = { vir: "include", scratch: "exclude" } as const;

  it("configured decisions apply", () => {
    expect(decideProject("vir", cfg)).toBe("include");
    expect(decideProject("scratch", cfg)).toBe("exclude");
  });

  it("absent from the map = pending, never an implicit include or exclude", () => {
    expect(decideProject("brand-new", cfg)).toBe("pending");
    expect(decideProject("brand-new", {})).toBe("pending");
  });

  it("--exclude-project skips for this run only (no config semantics)", () => {
    expect(
      decideProject("vir", cfg, { excludeProject: ["vir"] }),
    ).toBe("flag-skip");
  });

  it("--only restricts to the named projects", () => {
    expect(decideProject("vir", cfg, { only: ["growthq"] })).toBe("flag-skip");
    expect(decideProject("vir", cfg, { only: ["vir"] })).toBe("include");
  });

  it("a config exclusion wins over --only naming it (still records its row)", () => {
    expect(decideProject("scratch", cfg, { only: ["scratch"] })).toBe(
      "exclude",
    );
  });

  it("--only over an undecided project keeps it undecided (flag-skip, not silent include)", () => {
    expect(decideProject("mystery", cfg, { only: ["vir"] })).toBe("flag-skip");
  });
});

describe("groupByProject", () => {
  const deps = { readDir: (p: string) => TREE[p] ?? [] };

  it("groups discovered sessions by decoded project name with totals", () => {
    const sessions = [
      { path: `${PROJECTS_DIR}/-Users-djmarkovic999-projects-vir/a.jsonl`, hash: "h1", size: 100 },
      { path: `${PROJECTS_DIR}/-Users-djmarkovic999-projects-vir/b.jsonl`, hash: "h2", size: 200 },
      { path: `${PROJECTS_DIR}/-Users-djmarkovic999-projects-growthq/c.jsonl`, hash: "h3", size: 50 },
    ];
    const groups = groupByProject(sessions, PROJECTS_DIR, deps);
    expect(groups.get("vir")?.sessions).toHaveLength(2);
    expect(groups.get("vir")?.totalBytes).toBe(300);
    expect(groups.get("growthq")?.sessions).toHaveLength(1);
  });

  it("groups nested workflow/subagent transcripts under their project, not the inner dir", () => {
    // Real layout: <projectsDir>/<encoded>/<session-id>/wf_*.jsonl for
    // workflow and subagent transcripts. The project is the FIRST segment
    // under projectsDir, never the immediate parent.
    const sessions = [
      { path: `${PROJECTS_DIR}/-Users-djmarkovic999-projects-vir/a.jsonl`, hash: "h1", size: 100 },
      {
        path: `${PROJECTS_DIR}/-Users-djmarkovic999-projects-vir/2ce5eb51-baba-4d46/wf_123.jsonl`,
        hash: "h2",
        size: 200,
      },
    ];
    const groups = groupByProject(sessions, PROJECTS_DIR, deps);
    expect(groups.size).toBe(1);
    expect(groups.get("vir")?.sessions).toHaveLength(2);
  });
});

describe("estimateSessionCost — rough triage estimate from file size", () => {
  it("is positive and grows with size", () => {
    const small = estimateSessionCost(
      "anthropic",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
      100_000,
    );
    const big = estimateSessionCost(
      "anthropic",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
      1_000_000,
    );
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
  });
});

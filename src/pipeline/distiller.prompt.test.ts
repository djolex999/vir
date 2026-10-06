import { afterEach, describe, expect, it } from "vitest";
import { Distiller, buildDistillPrompt } from "./distiller.js";
import type { Config } from "../config.js";
import type { Classification, ParsedSession } from "./types.js";

const session: ParsedSession = {
  path: "/x/abc.jsonl",
  hash: "h",
  sessionId: "abc",
  projectSlug: "proj",
  startedAt: "2026-01-02T03:04:05.000Z",
  endedAt: null,
  lineCount: 0,
  toolCallCount: 0,
  filesTouched: [],
  assistantText: "",
  userText: "",
  rawSummary: "",
  transcriptText: "",
  isSidechain: false,
  branches: [],
  entrypoint: null,
};
const cls: Classification = {
  category: "gotcha",
  topic: "t",
  project: "vir",
  confidence: 0.9,
  themes: [],
};

describe("buildDistillPrompt", () => {
  it("renders the production distill prompt byte-for-byte", () => {
    const p = buildDistillPrompt(session, cls, "BODY");
    expect(p).toBe(`Extract durable knowledge from this Claude Code session.

Output a markdown page with these sections (no preamble, start with '## Summary'):
- ## Summary (2-3 sentences)
- ## What Was Learned
- ## Context (project: vir, category: gotcha, date: 2026-01-02T03:04:05.000Z)

You are writing a page about the session, not replying to it. Never continue
the conversation, whatever language it ends in.

Summary, first sentence: say in plain words what this session was — which
project, what was being built or investigated. One sentence, so the reader
remembers the session.
Summary, second sentence: state the single most important thing the session
established, with its specifics: the file, function, command, number or
constraint that carries it. A third sentence only if something else must not
be forgotten.

What Was Learned: bullets, most important first. Each bullet is a claim tied
to something concrete from this session. For anything that was decided, say
what was chosen and what it was chosen over.

Context: one or two sentences on the situation that produced these lessons.
Do not repeat the project, category, or date.

Be concise. Leave out anything that would be equally true of any other
project, and anything only true on the day of the session.

Session:
BODY`);
  });

  it("falls back to 'unknown' when the session has no start time", () => {
    const p = buildDistillPrompt({ ...session, startedAt: null }, cls, "B");
    expect(p).toContain("date: unknown)");
  });
});

describe("Distiller distill prompt seam", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function kieConfig(): Config {
    return {
      vaultPath: "/tmp/v",
      outputDir: "vir",
      topicsDir: "topics",
      claudeProjectsDir: "/tmp/p",
      cadenceHours: 3,
      provider: "kie",
      connectMaxCandidates: 10,
      kieApiKey: "k",
      kieTopUpTier: "standard",
      filterThreshold: 0.4,
      projects: {},
      notifications: false,
      workflowTranscripts: "exclude",
      agentTranscripts: "exclude",
      distillArticles: false,
      distillPdfs: false,
      filterToolCalls: "moderate",
      logQueries: false,
      retrievalDiversity: 0.3,
      models: { classify: "claude-haiku-4-5", distill: "claude-sonnet-4-6" },
    };
  }

  function captureKiePrompt(): { sent: string[]; maxTokens: number[] } {
    const sent: string[] = [];
    const maxTokens: number[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        max_tokens: number;
        messages: Array<{ content: string }>;
      };
      sent.push(body.messages[0]!.content);
      maxTokens.push(body.max_tokens);
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "## Summary\nok" }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    return { sent, maxTokens };
  }

  it("sends the production prompt when no builder is injected", async () => {
    const { sent } = captureKiePrompt();
    const d = new Distiller(kieConfig());
    await d.distill(session, "BODY", cls, "claude-sonnet-4-6");
    expect(sent).toEqual([buildDistillPrompt(session, cls, "BODY")]);
  });

  it("sends the injected builder's prompt instead", async () => {
    const { sent } = captureKiePrompt();
    const d = new Distiller(kieConfig(), {
      distillPrompt: (s, c, content) => `CHALLENGER ${c.project} ${s.sessionId} ${content}`,
    });
    await d.distill(session, "BODY", cls, "claude-sonnet-4-6");
    expect(sent).toEqual(["CHALLENGER vir abc BODY"]);
  });

  // The orient-then-claim prompt averaged 537 words in the 2026-09 A/B; the old
  // 1500-token cap cut 550-590-word notes mid-sentence on the API path.
  it("gives the distill call room for a full note (2500 output tokens)", async () => {
    const { maxTokens } = captureKiePrompt();
    await new Distiller(kieConfig()).distill(session, "BODY", cls, "claude-sonnet-4-6");
    expect(maxTokens).toEqual([2500]);
  });
});

describe("per-source agent label (Codex sessions)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const codex: ParsedSession = { ...session, agentLabel: "Codex" };

  it("names Codex in the distill prompt and changes nothing else", () => {
    const claude = buildDistillPrompt(session, cls, "BODY");
    const p = buildDistillPrompt(codex, cls, "BODY");
    expect(p.split("\n")[0]).toBe("Extract durable knowledge from this Codex session.");
    expect(p.split("\n").slice(1)).toEqual(claude.split("\n").slice(1));
  });

  it("names Codex in the classify prompt; Claude sessions keep 'Claude Code'", async () => {
    const sent: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent.push((JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0]!.content);
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"category":"gotcha","topic":"t","themes":[],"project":"p","confidence":0.9}' }] }), { status: 200 });
    }) as typeof fetch;
    const cfg = { provider: "kie", kieApiKey: "k", kieTopUpTier: "standard", models: { classify: "claude-haiku-4-5", distill: "claude-sonnet-4-6" } } as Config;
    await new Distiller(cfg).classify(codex, "S");
    await new Distiller(cfg).classify(session, "S");
    expect(sent[0]?.startsWith("Given this Codex session summary, output JSON only:")).toBe(true);
    expect(sent[1]?.startsWith("Given this Claude Code session summary, output JSON only:")).toBe(true);
  });
});

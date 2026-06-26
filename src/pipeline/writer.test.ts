import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import type { DistilledNote, ParsedSession } from "./types.js";
import { VaultWriter } from "./writer.js";

function makeCfg(vaultPath: string): Config {
  return {
    vaultPath,
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

function makeSession(): ParsedSession {
  return {
    path: "/x/abc12345.jsonl",
    hash: "",
    sessionId: "abc12345",
    projectSlug: "demo",
    startedAt: "2026-05-01T10:00:00.000Z",
    endedAt: null,
    lineCount: 0,
    toolCallCount: 0,
    filesTouched: [],
    assistantText: "",
    userText: "",
    rawSummary: "",
    transcriptText: "",
  };
}

function makeNote(themes: string[] = []): DistilledNote {
  return {
    classification: {
      category: "pattern",
      topic: "test topic",
      project: "demo",
      confidence: 0.9,
      themes,
    },
    markdown: "## Summary\n\nbody text",
  };
}

describe("VaultWriter write modes", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "vir-vault-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("does not append to log.md in rewrite mode", async () => {
    const writer = new VaultWriter(makeCfg(vault), null);
    const logPath = join(vault, "vir", "log.md");
    const before = readFileSync(logPath, "utf8");

    await writer.write(makeSession(), makeNote(), "rewrite");

    const after = readFileSync(logPath, "utf8");
    expect(after).toBe(before);
    expect(after).not.toContain("## [");
  });

  it("does not append to index.md in rewrite mode", async () => {
    const writer = new VaultWriter(makeCfg(vault), null);
    const indexPath = join(vault, "vir", "index.md");
    const before = readFileSync(indexPath, "utf8");

    await writer.write(makeSession(), makeNote(), "rewrite");

    expect(readFileSync(indexPath, "utf8")).toBe(before);
  });

  it("appends to log.md and index.md in append mode (default)", async () => {
    const writer = new VaultWriter(makeCfg(vault), null);

    await writer.write(makeSession(), makeNote());

    const log = readFileSync(join(vault, "vir", "log.md"), "utf8");
    expect(log).toContain("pattern");
    expect(log).toContain("test topic");

    const index = readFileSync(join(vault, "vir", "index.md"), "utf8");
    expect(index).toContain("test topic");
  });

  it("writes a themes: YAML list when the note carries themes", async () => {
    const writer = new VaultWriter(makeCfg(vault), null);
    const [notePath] = await writer.write(
      makeSession(),
      makeNote(["kie error handling", "retry safety"]),
    );
    const content = readFileSync(notePath!, "utf8");
    expect(content).toContain(
      'themes:\n  - "kie error handling"\n  - "retry safety"',
    );
  });

  it("omits the themes key entirely when there are no themes", async () => {
    const writer = new VaultWriter(makeCfg(vault), null);
    const [notePath] = await writer.write(makeSession(), makeNote());
    expect(readFileSync(notePath!, "utf8")).not.toContain("themes:");
  });

  it("preserves the existing themes block on a rewrite that carries none", async () => {
    const writer = new VaultWriter(makeCfg(vault), null);
    const [notePath] = await writer.write(
      makeSession(),
      makeNote(["alpha", "beta"]),
    );
    // A --rewrite-only pass reconstructs the classification from DB columns with
    // no themes — the themes block must survive, exactly like the review fields.
    await writer.write(makeSession(), makeNote(), "rewrite");
    const after = readFileSync(notePath!, "utf8");
    expect(after).toContain('themes:\n  - "alpha"\n  - "beta"');
  });

  it("preserves a reviewer's verified/reviewed_at fields on rewrite", async () => {
    const writer = new VaultWriter(makeCfg(vault), null);
    const [notePath] = await writer.write(makeSession(), makeNote());

    // Simulate `vir review` approving the note by stamping its frontmatter.
    const original = readFileSync(notePath!, "utf8");
    const reviewed = original.replace(
      /\nconfidence: 0\.9\n/,
      "\nconfidence: 0.9\nverified: true\nreviewed_at: 2026-05-24T00:00:00.000Z\n",
    );
    writeFileSync(notePath!, reviewed);

    // A later rewrite (or --full re-distill) must not wipe the verdict.
    await writer.write(makeSession(), makeNote(), "rewrite");

    const after = readFileSync(notePath!, "utf8");
    expect(after).toContain("verified: true");
    expect(after).toContain("reviewed_at: 2026-05-24T00:00:00.000Z");
  });
});

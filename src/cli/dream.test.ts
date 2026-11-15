import { describe, expect, it, vi } from "vitest";
import type { DistilledRow } from "../state/db.js";

const dreamCommand = vi.fn(async () => {});
vi.mock("./dream.js", async (orig) => ({ ...(await orig<typeof import("./dream.js")>()), dreamCommand }));

const row = (project: string): DistilledRow => ({
  path: `/p/${project}.jsonl`,
  sessionId: "s",
  startedAt: null,
  category: "gotcha",
  topic: "t",
  project,
  confidence: 0.8,
  content: "c",
  lesson: null,
});

describe("dreamTargets", () => {
  it("picks one slug or every project's slug", async () => {
    const { dreamTargets } = await import("./dream.js");
    const rows = [row("Pripremi.rs"), row("vir"), row("vir"), row("TRAIN")];
    expect(dreamTargets(rows, "Pripremi.rs", false)).toEqual(["pripremi-rs"]);
    expect(dreamTargets(rows, undefined, true)).toEqual(["pripremi-rs", "train", "vir"]);
    expect(dreamTargets(rows, undefined, false)).toEqual([]);
  });
});

describe("vir summarize", () => {
  it("delegates the project path to dream", async () => {
    const { summarizeCommand } = await import("./summarize.js");
    await summarizeCommand("growthq", { dryRun: true, yes: true, model: "sonnet" });
    expect(dreamCommand).toHaveBeenCalledWith("growthq", { all: undefined, dryRun: true, yes: true, model: "sonnet" });
  });
});

import { describe, expect, it } from "vitest";
import type { PendingProjectInfo } from "../pipeline/run.js";
import { buildProjectChoices, decisionsFromSelection } from "./projectSelect.js";

const projects: PendingProjectInfo[] = [
  { name: "vir", sessionCount: 12, totalBytes: 5_000_000, estCost: 1.5 },
  { name: "scratch", sessionCount: 3, totalBytes: 100_000, estCost: 0.12 },
];

describe("buildProjectChoices", () => {
  it("shows name, session count, and est cost per project", () => {
    const choices = buildProjectChoices(projects, {});
    expect(choices[0]?.value).toBe("vir");
    expect(choices[0]?.name).toContain("vir");
    expect(choices[0]?.name).toContain("12");
    expect(choices[0]?.name).toMatch(/\$/);
  });

  it("defaults to over-capture: include and undecided start checked, only explicit excludes start unchecked", () => {
    // Transcripts prune at ~30 days — an accidental enter must over-capture,
    // not silently lose sessions forever.
    const choices = buildProjectChoices(projects, { vir: "exclude" });
    expect(choices.find((c) => c.value === "vir")?.checked).toBe(false);
    expect(choices.find((c) => c.value === "scratch")?.checked).toBe(true);
  });
});

describe("decisionsFromSelection", () => {
  it("selected = include, unselected = exclude — every shown project gets decided", () => {
    expect(decisionsFromSelection(projects, ["vir"])).toEqual({
      vir: "include",
      scratch: "exclude",
    });
  });
});

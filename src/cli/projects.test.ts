import { describe, expect, it } from "vitest";
import type { ProjectGroup } from "../pipeline/projects.js";
import { buildProjectsReport, type SessionMetaRow } from "./projects.js";

const groups: ProjectGroup[] = [
  {
    name: "vir",
    sessions: [
      { path: "/t/vir/a.jsonl", hash: "h1", size: 100 },
      { path: "/t/vir/b.jsonl", hash: "h2", size: 200 },
      { path: "/t/vir/c.jsonl", hash: "h3", size: 300 },
    ],
    totalBytes: 600,
  },
  {
    name: "scratch",
    sessions: [
      { path: "/t/scratch/d.jsonl", hash: "h4", size: 400 },
      { path: "/t/scratch/e.jsonl", hash: "h5", size: 500 },
    ],
    totalBytes: 900,
  },
  {
    name: "mystery",
    sessions: [{ path: "/t/mystery/f.jsonl", hash: "h6", size: 700 }],
    totalBytes: 700,
  },
];

const meta: SessionMetaRow[] = [
  // vir: one distilled, one heuristic-skip, one unseen (include → just new)
  { path: "/t/vir/a.jsonl", hash: "h1", skipped: 0, skipReason: null, hasContent: 1 },
  { path: "/t/vir/b.jsonl", hash: "h2", skipped: 1, skipReason: null, hasContent: 0 },
  // scratch: one recorded excluded, one unseen (exclude → counts excluded)
  { path: "/t/scratch/d.jsonl", hash: "h4", skipped: 1, skipReason: "project-excluded", hasContent: 0 },
  // mystery: one recorded pending
  { path: "/t/mystery/f.jsonl", hash: "h6", skipped: 1, skipReason: "project-pending", hasContent: 0 },
];

const decisions = { vir: "include", scratch: "exclude" } as const;
const estCost = (size: number): number => size / 100;

describe("buildProjectsReport", () => {
  const rows = buildProjectsReport(groups, meta, decisions, estCost);
  const byName = new Map(rows.map((r) => [r.name, r]));

  it("reports one row per project seen", () => {
    expect(rows).toHaveLength(3);
  });

  it("labels decisions three-state, undecided visible", () => {
    expect(byName.get("vir")?.decision).toBe("include");
    expect(byName.get("scratch")?.decision).toBe("exclude");
    expect(byName.get("mystery")?.decision).toBe("undecided");
  });

  it("counts distilled from DB content rows", () => {
    expect(byName.get("vir")?.distilled).toBe(1);
  });

  it("counts recorded and unseen sessions of an excluded project as excluded", () => {
    expect(byName.get("scratch")?.excluded).toBe(2);
    expect(byName.get("scratch")?.pending).toBe(0);
  });

  it("counts recorded-pending and unseen sessions of an undecided project as pending, with est cost", () => {
    const mystery = byName.get("mystery");
    expect(mystery?.pending).toBe(1);
    expect(mystery?.estPendingCost).toBeCloseTo(7);
  });

  it("an unseen session in an included project is neither pending nor excluded", () => {
    const vir = byName.get("vir");
    expect(vir?.pending).toBe(0);
    expect(vir?.excluded).toBe(0);
    expect(vir?.sessions).toBe(3);
  });

  it("attaches nested transcript counts separately, defaulting to zero", () => {
    const withNested = buildProjectsReport(
      groups,
      meta,
      decisions,
      estCost,
      new Map([["vir", { workflow: 44, sidechain: 2 }]]),
    );
    const vir = withNested.find((r) => r.name === "vir");
    const scratch = withNested.find((r) => r.name === "scratch");
    expect(vir?.workflowSessions).toBe(44);
    expect(vir?.sidechainSessions).toBe(2);
    // nested transcripts never inflate the decidable session count
    expect(vir?.sessions).toBe(3);
    expect(scratch?.workflowSessions).toBe(0);
    expect(scratch?.sidechainSessions).toBe(0);
  });
});

describe("buildProjectsReport — agent annotation separate from workflow/sidechain", () => {
  it("carries agent counts through the nested map", () => {
    const rows = buildProjectsReport(
      groups,
      meta,
      decisions,
      estCost,
      new Map([["vir", { workflow: 1, sidechain: 2, agent: 22 }]]),
    );
    const vir = rows.find((r) => r.name === "vir");
    expect(vir?.agentSessions).toBe(22);
    expect(vir?.workflowSessions).toBe(1);
    expect(vir?.sessions).toBe(3);
    expect(rows.find((r) => r.name === "scratch")?.agentSessions).toBe(0);
  });
});

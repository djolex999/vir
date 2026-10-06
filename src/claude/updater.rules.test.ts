import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { sampleInsight } from "../connect/testFixtures.js";
import { StateDb } from "../state/db.js";
import { planRules, planUpdates, renderBlock, renderRuleHunk, VIR_END, VIR_START } from "./updater.js";

let home: string;
let prevHome: string | undefined;
let db: StateDb;
const cfg = {} as Config;

function distilled(project: string, n: number): void {
  db.record({
    path: `/t/${project}-${n}.jsonl`, hash: `h${project}${n}`, skipped: false, notePaths: [],
    content: "body", category: "gotcha", topic: `topic ${n}`, project, confidence: 0.9, startedAt: "2026-01-01",
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vir-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# me\n");
  mkdirSync(join(home, "projects", "growthq"), { recursive: true });
  writeFileSync(join(home, "projects", "growthq", "CLAUDE.md"), "# growthq\n");
  db = new StateDb(join(home, "vir.db"));
  distilled("growthq", 1);
});
afterEach(() => {
  db.close();
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("rule entries in the VIR block", () => {
  it("renders a no-rules block byte-identical to before", () => {
    const entries = [{ slug: "gotcha/x", topic: "x", category: "gotcha", confidence: 0.9, startedAt: null }];
    expect(renderBlock(entries, [])).toBe(renderBlock(entries));
    expect(renderBlock(entries)).not.toContain("Rules (from vir)");
  });

  it("renders promoted rules under their own heading with a stable marker", () => {
    const block = renderBlock([], [{ id: "3f9a1c2e-0000", rule: "Use proxy.ts in Next 16" }]);
    expect(block).toContain("## Rules (from vir)");
    expect(block).toContain("- rule: Use proxy.ts in Next 16 <!-- vir-rule:3f9a1c2e-0000 -->");
    expect(block.trimEnd().endsWith(VIR_END)).toBe(true);
  });

  it("diffs rules by id: added when newly approved, removed when no longer promoted", () => {
    const ins = sampleInsight({ status: "accepted", scope: "global" });
    db.upsertInsight(ins);
    const added = planUpdates(cfg, db, { globalOnly: true }, new Set([ins.id]))[0];
    expect(added?.diff.rulesAdded.map((r) => r.id)).toEqual([ins.id]);
    expect(added?.newBlock).toContain(`<!-- vir-rule:${ins.id} -->`);

    writeFileSync(join(home, ".claude", "CLAUDE.md"), `# me\n${added?.newBlock ?? ""}\n`);
    const gone = planUpdates(cfg, db, { globalOnly: true })[0];
    expect(gone?.diff.rulesRemoved.map((r) => r.id)).toEqual([ins.id]);
    expect(gone?.newBlock).not.toContain("vir-rule:");
  });

  it("keeps rendering a promoted rule without approval", () => {
    db.upsertInsight(sampleInsight({ status: "accepted", promotion: "promoted", scope: "global" }));
    expect(planUpdates(cfg, db, { globalOnly: true })[0]?.newBlock).toContain("Use proxy.ts in Next 16");
  });

  it("never renders a proposed or rejected rule, even if its id is passed as approved", () => {
    const p = sampleInsight({ id: "p1", slug: "p1", status: "proposed", scope: "global" });
    const r = sampleInsight({ id: "r1", slug: "r1", status: "rejected", promotion: "promoted", scope: "global" });
    db.upsertInsight(p);
    db.upsertInsight(r);
    const block = planUpdates(cfg, db, { globalOnly: true }, new Set(["p1", "r1"]))[0]?.newBlock ?? "";
    expect(block).not.toContain("vir-rule:");
  });
});

describe("planRules", () => {
  it("maps accepted, unpromoted rules to their CLAUDE.md target", () => {
    db.upsertInsight(sampleInsight({ id: "g", slug: "g", status: "accepted", scope: "global" }));
    db.upsertInsight(sampleInsight({ id: "p", slug: "p", status: "accepted", scope: "project:growthq" }));
    db.upsertInsight(sampleInsight({ id: "x", slug: "x", status: "accepted", promotion: "declined", scope: "global" }));
    db.upsertInsight(sampleInsight({ id: "y", slug: "y", status: "accepted", promotion: "promoted", scope: "global" }));
    db.upsertInsight(sampleInsight({ id: "z", slug: "z", status: "proposed", scope: "global" }));
    const out = planRules(db, {}).map((c) => [c.insight.id, c.target]);
    expect(out).toEqual([
      ["g", join(home, ".claude", "CLAUDE.md")],
      ["p", join(home, "projects", "growthq", "CLAUDE.md")],
    ]);
    expect(planRules(db, { globalOnly: true }).map((c) => c.insight.id)).toEqual(["g"]);
    expect(planRules(db, { project: "growthq" }).map((c) => c.insight.id)).toEqual(["p"]);
  });

  it("renders a hunk with the rule line and its sources", () => {
    const [c] = planRules(db, {});
    expect(c).toBeUndefined();
    const ins = sampleInsight({ status: "accepted", scope: "global" });
    db.upsertInsight(ins);
    const hunk = renderRuleHunk(planRules(db, {})[0]!);
    expect(hunk).toContain("+ - rule: Use proxy.ts in Next 16");
    expect(hunk).toContain("[[note-a]] (growthq, 2026-06-02)");
  });
});

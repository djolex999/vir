import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { sampleInsight } from "../connect/testFixtures.js";
import { StateDb } from "../state/db.js";
import { runSyncClaude, type SyncIo } from "./syncClaude.js";

let home: string;
let prevHome: string | undefined;
let db: StateDb;
let cfg: Config;
const claudeMd = () => readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
const promotion = () => db.listInsights()[0]?.promotion;

function io(answers: string[], isTTY = true): SyncIo & { printed: string[]; asked: string[] } {
  const printed: string[] = [];
  const asked: string[] = [];
  return {
    isTTY, printed, asked,
    ask: async (q: string) => { asked.push(q); return answers.shift() ?? "n"; },
    print: (s: string) => printed.push(s),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vir-sync-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# me\n");
  db = new StateDb(join(home, "vir.db"));
  cfg = { vaultPath: join(home, "vault"), outputDir: "vir" } as unknown as Config;
  db.upsertInsight(sampleInsight({ status: "accepted", scope: "global" }));
});
afterEach(() => {
  db.close();
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const opts = { globalOnly: true };

describe("sync-claude rule promotion", () => {
  it("y on the rule then y on the block promotes it after the write", async () => {
    const t = io(["y", "y"]);
    await runSyncClaude(cfg, db, opts, t);
    expect(promotion()).toBe("promoted");
    expect(claudeMd()).toContain("- rule: Use proxy.ts in Next 16");
    expect(t.printed.join("\n")).toContain("[[note-a]] (growthq, 2026-06-02)");
  });

  it("y on the rule then n on the block leaves the rule unpromoted and the file unchanged", async () => {
    await runSyncClaude(cfg, db, opts, io(["y", "n"]));
    expect(promotion()).toBe("none");
    expect(claudeMd()).toBe("# me\n");
  });

  it("n declines the rule for good, immediately", async () => {
    await runSyncClaude(cfg, db, opts, io(["n", "n"]));
    expect(promotion()).toBe("declined");
    const again = io(["y"]);
    await runSyncClaude(cfg, db, opts, again);
    expect(again.asked.some((q) => q.includes("add this rule"))).toBe(false);
  });

  it("s skips for now and asks again next time", async () => {
    await runSyncClaude(cfg, db, opts, io(["s", "n"]));
    expect(promotion()).toBe("none");
    const again = io(["n", "n"]);
    await runSyncClaude(cfg, db, opts, again);
    expect(again.asked.some((q) => q.includes("add this rule"))).toBe(true);
  });

  it("asks again on a typo instead of treating it as skip", async () => {
    const t = io(["t", "y", "x", "y"]);
    await runSyncClaude(cfg, db, opts, t);
    expect(t.asked.filter((q) => q.includes("add this rule"))).toHaveLength(2);
    expect(t.asked.filter((q) => q.includes("apply these changes"))).toHaveLength(2);
    expect(promotion()).toBe("promoted");
  });

  it("without a terminal, an unreadable answer aborts once instead of looping", async () => {
    const t = io([""], false);
    await runSyncClaude(cfg, db, opts, t);
    expect(t.asked).toEqual(["apply these changes? (y/n) "]);
    expect(t.printed).toContain("aborted");
  });

  it("gives up after 5 unreadable answers in a terminal", async () => {
    const t = io(["s", "?", "?", "?", "?", "?"]);
    await runSyncClaude(cfg, db, opts, t);
    expect(t.asked.filter((q) => q.includes("apply these changes"))).toHaveLength(5);
    expect(t.printed).toContain("aborted");
  });

  it("never offers a rule whose CLAUDE.md doesn't exist, and says why", async () => {
    rmSync(join(home, ".claude", "CLAUDE.md"));
    const t = io(["y", "y"]);
    await runSyncClaude(cfg, db, opts, t);
    expect(t.asked.some((q) => q.includes("add this rule"))).toBe(false);
    expect(t.printed.join("\n")).toContain("1 accepted rule(s) wait for a CLAUDE.md that doesn't exist");
    expect(promotion()).toBe("none");
  });

  it.each([
    ["--force", { ...opts, force: true }, true],
    ["--dry-run", { ...opts, dryRun: true }, true],
    ["non-TTY", opts, false],
  ] as const)("%s never prompts for or promotes a rule", async (_name, o, tty) => {
    const t = io(["y", "y"], tty);
    await runSyncClaude(cfg, db, o, t);
    expect(t.asked.some((q) => q.includes("add this rule"))).toBe(false);
    expect(promotion()).toBe("none");
    expect(claudeMd()).not.toContain("vir-rule:");
    expect(t.printed.join("\n")).toContain("1 rule(s) awaiting your approval: run vir sync-claude in a terminal");
  });

  it("renders a promoted rule on later runs without asking", async () => {
    await runSyncClaude(cfg, db, opts, io(["y", "y"]));
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# me\n");
    const t = io([], true);
    await runSyncClaude(cfg, db, { ...opts, force: true }, t);
    expect(claudeMd()).toContain("vir-rule:");
    expect(t.asked).toEqual([]);
  });

  it("shows a demoted rule as a removal", async () => {
    await runSyncClaude(cfg, db, opts, io(["y", "y"]));
    const row = db.listInsights()[0];
    if (row) db.upsertInsight({ ...row, status: "rejected", promotion: "declined" });
    const t = io(["y"]);
    await runSyncClaude(cfg, db, opts, t);
    expect(t.printed.join("\n")).toMatch(/- rule: Use proxy\.ts in Next 16/);
    expect(claudeMd()).not.toContain("vir-rule:");
  });
});

describe("sync-claude → AGENTS.md", () => {
  const agentsMd = () => readFileSync(join(home, ".codex", "AGENTS.md"), "utf8");
  const withAgentsMd = () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "AGENTS.md"), "# codex\n");
  };

  it("a rule approved for CLAUDE.md lands in an existing ~/.codex/AGENTS.md too", async () => {
    withAgentsMd();
    await runSyncClaude(cfg, db, opts, io(["y", "y"]));
    expect(promotion()).toBe("promoted");
    expect(agentsMd()).toContain("- rule: Use proxy.ts in Next 16");
    expect(agentsMd().startsWith("# codex\n")).toBe(true);
    expect(claudeMd()).toContain("- rule: Use proxy.ts in Next 16");
  });

  it("never mentions an AGENTS.md that doesn't exist", async () => {
    const t = io(["y", "y"]);
    await runSyncClaude(cfg, db, opts, t);
    expect(t.printed.join("\n")).not.toContain("AGENTS.md");
  });

  it("agents: off leaves AGENTS.md alone", async () => {
    withAgentsMd();
    await runSyncClaude(cfg, db, { ...opts, agents: "off" }, io(["y", "y"]));
    expect(agentsMd()).toBe("# codex\n");
  });

  it("agents: only writes promoted rules to AGENTS.md without asking about rules or touching CLAUDE.md", async () => {
    withAgentsMd();
    db.upsertInsight({ ...db.listInsights()[0]!, promotion: "promoted" });
    const t = io(["y"]);
    await runSyncClaude(cfg, db, { ...opts, agents: "only" }, t);
    expect(t.asked.some((q) => q.includes("add this rule"))).toBe(false);
    expect(claudeMd()).toBe("# me\n");
    expect(agentsMd()).toContain("- rule: Use proxy.ts in Next 16");
  });
});

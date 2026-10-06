import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { INSIGHTS_RULES_DIR, renderInsight, writeInsightFile } from "../connect/insightFile.js";
import { sampleInsight } from "../connect/testFixtures.js";
import type { InsightRow } from "../connect/types.js";
import { StateDb } from "../state/db.js";
import { applyInsightAction, applyInsightEdit, insightQueue, isStale, runReviewInsights } from "./reviewInsights.js";

let dir: string;
let root: string;
let db: StateDb;
let cfg: Config;
const embedCalls: string[] = [];
const deps = {
  embed: async (t: string) => { embedCalls.push(t); return [1, 0]; },
  providerModel: "fake-model",
  now: () => new Date("2026-10-07T00:00:00Z"),
};

function seed(over: Partial<InsightRow>): InsightRow {
  const row = sampleInsight(over);
  db.upsertInsight(row);
  writeInsightFile(root, row);
  return row;
}
const file = (slug: string) => readFileSync(join(root, INSIGHTS_RULES_DIR, `${slug}.md`), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vir-review-insights-"));
  root = join(dir, "vault", "vir");
  mkdirSync(root, { recursive: true });
  db = new StateDb(join(dir, "vir.db"));
  cfg = { vaultPath: join(dir, "vault"), outputDir: "vir" } as unknown as Config;
  embedCalls.length = 0;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("applyInsightAction", () => {
  it("accept marks it accepted, verified, and embeds rule + why", async () => {
    const row = seed({});
    const out = await applyInsightAction(db, cfg, row.slug, "accept", deps);
    expect(out.status).toBe("accepted");
    expect(file(row.slug)).toContain("verified: true");
    expect(embedCalls).toEqual([`${row.rule}\n${row.why}`]);
    expect(db.getInsightEmbeddings(root)).toHaveLength(1);
  });

  it("reject keeps the file in place, unverified; a promoted rule becomes declined", async () => {
    const row = seed({ status: "accepted", promotion: "promoted" });
    const out = await applyInsightAction(db, cfg, row.slug, "reject", deps);
    expect(out).toMatchObject({ status: "rejected", promotion: "declined" });
    expect(file(row.slug)).toContain("status: rejected");
    expect(file(row.slug)).toContain("verified: false");
  });

  it("accept-additions merges pending evidence and sessions", async () => {
    const pending = [{ sessionId: "s9", citeSlug: "note-z", project: "growthq", date: "2026-08-01", quote: "again" }];
    const row = seed({ status: "accepted", evidenceChanged: true, pending });
    const out = await applyInsightAction(db, cfg, row.slug, "accept-additions", deps);
    expect(out.evidenceChanged).toBe(false);
    expect(out.pending).toBeNull();
    expect(out.memberSessionIds).toContain("s9");
    expect(out.sessions).toBe(4);
    expect(out.sources).toContain("note-z");
    expect(out.lastSeen.startsWith("2026-08-01")).toBe(true);
  });

  it("keep drops the pending additions and changes nothing else", async () => {
    const pending = [{ sessionId: "s9", citeSlug: "note-z", project: "", date: "2026-08-01", quote: "q" }];
    const row = seed({ status: "accepted", evidenceChanged: true, pending });
    const out = await applyInsightAction(db, cfg, row.slug, "keep", deps);
    expect(out).toMatchObject({ evidenceChanged: false, pending: null, sessions: row.sessions });
  });

  it("throws for an unknown slug", async () => {
    await expect(applyInsightAction(db, cfg, "nope", "accept", deps)).rejects.toThrow("no rule with slug nope");
  });
});

describe("applyInsightEdit", () => {
  it("takes the edited rule and why, accepts and re-embeds", async () => {
    const row = seed({});
    const edited = renderInsight(row).replace(`**Rule:** ${row.rule}`, "**Rule:** Always use proxy.ts on Next 16+");
    const out = await applyInsightEdit(db, cfg, row.slug, edited, deps);
    expect(out).toMatchObject({ status: "accepted", rule: "Always use proxy.ts on Next 16+" });
    expect(embedCalls[0]?.startsWith("Always use proxy.ts on Next 16+")).toBe(true);
  });

  it("refuses an edit without a **Rule:** line and changes nothing", async () => {
    const row = seed({});
    await expect(applyInsightEdit(db, cfg, row.slug, "no rule here", deps)).rejects.toThrow(
      "edited file has no **Rule:** line — nothing changed",
    );
    expect(db.getInsightBySlug(row.slug)?.status).toBe("proposed");
  });
});

describe("insightQueue", () => {
  it("lists proposed rules newest first, then accepted rules with new evidence", () => {
    seed({ id: "a", slug: "a", lastSeen: "2026-01-01" });
    seed({ id: "b", slug: "b", lastSeen: "2026-03-01" });
    seed({ id: "c", slug: "c", status: "accepted", evidenceChanged: true });
    seed({ id: "d", slug: "d", status: "accepted" });
    seed({ id: "e", slug: "e", status: "rejected" });
    expect(insightQueue(db).map((r) => r.slug)).toEqual(["b", "a", "c"]);
  });
});

describe("isStale", () => {
  it("is true when fewer than 3 member sessions still have notes", () => {
    const row = sampleInsight({ memberSessionIds: ["s1", "s2", "s3"] });
    expect(isStale(row, new Set(["s1", "s2", "s3", "x"]))).toBe(false);
    expect(isStale(row, new Set(["s1", "s2"]))).toBe(true);
  });
});

describe("runReviewInsights", () => {
  it("walks the queue with an injected prompt", async () => {
    const a = seed({ id: "a", slug: "a", lastSeen: "2026-03-01" });
    const b = seed({ id: "b", slug: "b", lastSeen: "2026-01-01" });
    const answers = ["accept", "reject"];
    const shown: string[] = [];
    const n = await runReviewInsights(cfg, db, {
      ask: async (_q, _choices) => answers.shift() ?? "skip",
      show: (s) => shown.push(s),
      edit: async () => "",
      liveSessions: () => new Set(["s1", "s2", "s3"]),
      ...deps,
    });
    expect(n).toBe(2);
    expect(db.getInsightBySlug(a.slug)?.status).toBe("accepted");
    expect(db.getInsightBySlug(b.slug)?.status).toBe("rejected");
    expect(shown.join("\n")).toContain(a.rule);
    expect(shown.join("\n")).toContain('"renames middleware"');
  });

  it("marks a stale accepted rule in the walk", async () => {
    seed({ id: "c", slug: "c", status: "accepted", evidenceChanged: true, pending: [] });
    const shown: string[] = [];
    await runReviewInsights(cfg, db, {
      ask: async () => "skip", show: (s) => shown.push(s), edit: async () => "",
      liveSessions: () => new Set(["s1"]), ...deps,
    });
    expect(shown.join("\n")).toContain("stale");
  });
});

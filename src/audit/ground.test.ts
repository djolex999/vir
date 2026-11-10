import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCliLimitError } from "../pipeline/claudeCli.js";
import { StateDb } from "../state/db.js";
import { AuditParseError } from "./prompt.js";
import {
  buildGroundPrompt,
  parseGroundResponse,
  runGround,
  selectGroundRows,
} from "./ground.js";
import { contentHash } from "./types.js";

const sid = (n: number): string => `abc1234${n}-0000-4000-8000-000000000001`;
const pathOf = (n: number, project = "vir"): string => `/p/-home-u-${project}/${sid(n)}.jsonl`;

describe("parseGroundResponse", () => {
  it("reads an empty findings list as supported", () => {
    expect(parseGroundResponse('{"findings":[]}')).toEqual({ verdict: "supported", problems: [] });
  });

  it("keeps contradicted and unbacked findings, tolerating prose around the JSON", () => {
    const r = parseGroundResponse(
      'Here:\n{"findings":[{"claim":"fix was X","status":"contradicted","transcript":"fix was Y"},{"claim":"ran on Node 20","status":"unbacked","transcript":""}]}',
    );
    expect(r.verdict).toBe("contradicted");
    expect(r.problems).toEqual([
      { claim: "fix was X", status: "contradicted", transcript: "fix was Y" },
      { claim: "ran on Node 20", status: "unbacked", transcript: "" },
    ]);
  });

  it("is unbacked when nothing is contradicted, and lists contradictions first", () => {
    expect(parseGroundResponse('{"findings":[{"claim":"a","status":"unbacked","transcript":""}]}').verdict).toBe("unbacked");
    const r = parseGroundResponse(
      '{"findings":[{"claim":"u","status":"unbacked","transcript":""},{"claim":"c","status":"contradicted","transcript":"x"}]}',
    );
    expect(r.problems.map((p) => p.claim)).toEqual(["c", "u"]);
  });

  it("drops findings the model judged ok, or with an unknown status", () => {
    const r = parseGroundResponse(
      '{"findings":[{"claim":"a","status":"ok","transcript":"b"},{"claim":"c","status":"borderline","transcript":"d"}]}',
    );
    expect(r).toEqual({ verdict: "supported", problems: [] });
  });

  it("rejects replies without a findings list", () => {
    expect(() => parseGroundResponse('{"verdict":"supported"}')).toThrow(AuditParseError);
    expect(() => parseGroundResponse("no json here")).toThrow(AuditParseError);
    expect(() => parseGroundResponse("{not json}")).toThrow(AuditParseError);
  });
});

describe("buildGroundPrompt", () => {
  it("carries the note and the transcript", () => {
    const p = buildGroundPrompt("NOTE BODY", "TRANSCRIPT BODY");
    expect(p).toContain("<note>\nNOTE BODY\n</note>");
    expect(p).toContain("<transcript>\nTRANSCRIPT BODY\n</transcript>");
  });
});

describe("runGround", () => {
  let dir: string;
  let db: StateDb;

  const seed = (n: number, content: string, project = "vir"): void => {
    db.record({
      path: pathOf(n, project),
      hash: `h${n}`,
      skipped: false,
      notePaths: [],
      content,
      category: "gotcha",
      topic: `topic ${n}`,
      project,
      confidence: 0.9,
      startedAt: `2026-05-0${n}T00:00:00.000Z`,
    });
  };
  const exists = (): boolean => true;
  const notVerified = (): boolean => false;
  const evidence = (path: string): string => `transcript of ${path}`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-ground-"));
    db = new StateDb(join(dir, "vir.db"));
    seed(1, "body one");
    seed(2, "body two");
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records supported notes without touching their audit verdict", async () => {
    const s = await runGround(db, {}, {
      llm: async () => '{"findings":[]}',
      isVerified: notVerified,
      evidence,
      transcriptExists: exists,
    });
    expect(s).toMatchObject({ checked: 2, supported: 2, contradicted: 0, flagged: 0 });
    expect(db.listGrounds().every((g) => g.verdict === "supported" && g.fresh)).toBe(true);
    expect(db.listAudits()).toEqual([]);
  });

  it("sends the note's own transcript, and flags contradicted notes as verify", async () => {
    const prompts: string[] = [];
    const s = await runGround(db, { limit: 1 }, {
      llm: async (p) => {
        prompts.push(p);
        return '{"findings":[{"claim":"cause was cache","status":"contradicted","transcript":"cause was a race"}]}';
      },
      isVerified: notVerified,
      evidence,
      transcriptExists: exists,
    });
    expect(s).toMatchObject({ checked: 1, contradicted: 1, flagged: 1 });
    expect(prompts[0]).toContain(`transcript of ${pathOf(1)}`);
    const audit = db.listAudits()[0];
    expect(audit?.verdict).toBe("verify");
    expect(audit?.reason).toBe("transcript check: contradicted: cause was cache (transcript: cause was a race)");
    expect(audit?.fresh).toBe(true);
  });

  it("does not downgrade a fresh reject to verify", async () => {
    db.recordAudit(pathOf(1), { verdict: "reject", reason: "generic", mergeInto: null, contentHash: contentHash("body one") });
    const s = await runGround(db, { limit: 1 }, {
      llm: async () => '{"findings":[{"claim":"a","status":"contradicted","transcript":"b"}]}',
      isVerified: notVerified,
      evidence,
      transcriptExists: exists,
    });
    expect(s.flagged).toBe(0);
    expect(db.listAudits()[0]?.verdict).toBe("reject");
  });

  it("records unbacked notes without sending them to review", async () => {
    const s = await runGround(db, { limit: 1 }, {
      llm: async () => '{"findings":[{"claim":"a","status":"unbacked","transcript":""}]}',
      isVerified: notVerified,
      evidence,
      transcriptExists: exists,
    });
    expect(s).toMatchObject({ checked: 1, unbacked: 1, flagged: 0 });
    expect(db.listGrounds()[0]?.verdict).toBe("unbacked");
    expect(db.listAudits()).toEqual([]);
  });

  it("skips fresh results unless --all, and rechecks when the note changed", async () => {
    const llm = async (): Promise<string> => '{"findings":[]}';
    const deps = { llm, isVerified: notVerified, evidence, transcriptExists: exists };
    await runGround(db, {}, deps);
    expect((await runGround(db, {}, deps)).skippedFresh).toBe(2);
    expect((await runGround(db, { all: true }, deps)).checked).toBe(2);
    seed(1, "body one, rewritten");
    expect((await runGround(db, {}, deps)).checked).toBe(1);
  });

  it("counts a bad reply as failed and keeps going", async () => {
    let n = 0;
    const s = await runGround(db, {}, {
      llm: async () => (n++ === 0 ? "nonsense" : '{"findings":[]}'),
      isVerified: notVerified,
      evidence,
      transcriptExists: exists,
    });
    expect(s).toMatchObject({ checked: 1, failed: 1 });
  });

  it("stops on a subscription limit", async () => {
    await expect(
      runGround(db, {}, {
        llm: async () => {
          throw new ClaudeCliLimitError("session", null);
        },
        isVerified: notVerified,
        evidence,
        transcriptExists: exists,
      }),
    ).rejects.toBeInstanceOf(ClaudeCliLimitError);
  });
});

describe("selectGroundRows", () => {
  const row = (n: number, project = "vir") => ({
    path: pathOf(n, project),
    sessionId: sid(n),
    startedAt: null,
    category: "gotcha" as const,
    topic: `t${n}`,
    project,
    confidence: 0.9,
    content: `c${n}`,
    lesson: null,
  });

  it("counts notes whose transcript is gone and filters by project", () => {
    const s = selectGroundRows(
      [row(1), row(2), row(3, "other")],
      [],
      { project: "vir" },
      () => false,
      (p) => p !== pathOf(2),
    );
    expect(s.rows.map((r) => r.topic)).toEqual(["t1"]);
    expect(s.transcriptGone).toBe(1);
  });

  it("leaves human-verified notes alone", () => {
    const s = selectGroundRows([row(1)], [], {}, () => true, () => true);
    expect(s.rows).toEqual([]);
    expect(s.skippedVerified).toBe(1);
  });
});

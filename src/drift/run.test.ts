import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_DRIFT, renderDrift } from "./render.js";
import { runDrift, writeDriftReport } from "./run.js";
import { driftToolReport } from "./tool.js";
import type { DriftItem } from "./types.js";

let root: string;

function write(rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
}

const CLI = `import { Command } from "commander";
const program = new Command();
program.command("run").option("--dry-run", "x").action(() => {});
const schedule = program.command("schedule");
schedule.command("install").action(() => {});
program.command("secret").action(() => {});
const key = process.env.KIE_API_KEY;
`;

const PKG = JSON.stringify({ name: "@me/tool", bin: { tool: "dist/cli.js" }, scripts: { build: "tsc", test: "vitest" }, dependencies: { commander: "1" } });

const CLEAN_DOC = [
  "# tool",
  "",
  "## Stack",
  "- `commander` for the CLI",
  "",
  "Run `npm run build`, then `tool run --dry-run` and `tool schedule install`, or `tool secret`.",
  "Set `KIE_API_KEY` in your env. Entry: `src/cli.ts`, helpers in `src/util/`.",
].join("\n");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vir-drift-"));
  git("init", "-q");
  write("package.json", PKG);
  write("package-lock.json", "{}");
  write("src/cli.ts", CLI);
  write("src/util/old.ts", "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("mv", "src/util/old.ts", "src/util/new.ts");
  git("commit", "-q", "-m", "rename");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const byText = (items: DriftItem[]): Record<string, DriftItem> => Object.fromEntries(items.map((i) => [i.claim.text, i]));

describe("runDrift", () => {
  it("says no drift when every claim holds", () => {
    write("CLAUDE.md", CLEAN_DOC);
    const r = runDrift(root, { now: new Date("2026-11-17T23:30:00Z") });
    expect(r.docs.map((d) => d.items)).toEqual([[]]);
    expect(r.undocumented).toEqual([]);
    // 23:30 UTC is already the 18th in Belgrade.
    expect(r.date).toBe("2026-11-18");
    expect(renderDrift(r)).toContain(`${NO_DRIFT}.`);
  });

  it("reports stale and changed claims per doc", () => {
    write(
      "CLAUDE.md",
      [
        CLEAN_DOC,
        "Old helper: `src/util/old.ts`. Gone: `src/missing.ts`.",
        "Also `npm run lint`, `pnpm build`, `tool deploy`, `tool run --fast`, `tool schedule remove`.",
        "Needs `process.env.GONE_KEY`.",
        "- uses `@scope/absent`",
        "Vault lives in `insights/rules/`, config in `~/.tool/config.json`.",
      ].join("\n"),
    );
    const r = runDrift(root);
    const items = byText(r.docs[0]?.items ?? []);
    expect(items["src/util/old.ts"]).toMatchObject({ kind: "changed", now: "src/util/new.ts" });
    expect(items["src/missing.ts"]).toMatchObject({ kind: "stale", detail: "no such file" });
    expect(items["npm run lint"]?.kind).toBe("stale");
    expect(items["pnpm build"]).toMatchObject({ kind: "changed", now: "npm" });
    expect(items["tool deploy"]?.kind).toBe("stale");
    expect(items["tool run --fast"]?.kind).toBe("stale");
    expect(items["tool schedule remove"]).toMatchObject({ kind: "stale", now: "install" });
    expect(items["process.env.GONE_KEY"]?.kind).toBe("stale");
    expect(items["@scope/absent"]?.kind).toBe("stale");
    // Not about this repo: skipped, not reported.
    expect(items["insights/rules/"]).toBeUndefined();
    expect(items["~/.tool/config.json"]).toBeUndefined();
  });

  it("lists source modules and commands no doc mentions", () => {
    write("CLAUDE.md", "# tool\n\nRun `tool run`.\n");
    write("src/billing/index.ts", "export {};\n");
    const r = runDrift(root);
    expect(r.undocumented).toEqual([
      { kind: "src-dir", name: "src/billing/" },
      { kind: "src-dir", name: "src/util/" },
      { kind: "cli-command", name: "tool schedule" },
      { kind: "cli-command", name: "tool secret" },
    ]);
  });

  it("resolves a nested CLAUDE.md against its own folder", () => {
    write("CLAUDE.md", CLEAN_DOC);
    write("src/util/CLAUDE.md", "```\nnew.ts\nold.ts\ngone.ts\n```\nSee [new](new.ts).\n");
    const nested = runDrift(root).docs.find((d) => d.doc === "src/util/CLAUDE.md");
    expect(nested?.items.map((i) => `${i.kind}:${i.claim.value}`)).toEqual([]);
    // A three-line block needs a dir to read as a tree; links still count.
    write("src/util/CLAUDE.md", "See [new](new.ts) and [gone](gone.ts).\n");
    const again = runDrift(root).docs.find((d) => d.doc === "src/util/CLAUDE.md");
    expect(again?.items.map((i) => `${i.kind}:${i.claim.value}`)).toEqual(["stale:gone.ts"]);
  });

  it("writes the latest and the dated report into the vault drift folder", () => {
    write("CLAUDE.md", CLEAN_DOC);
    const r = runDrift(root, { now: new Date("2026-11-17T10:00:00Z") });
    const vault = join(root, "vault");
    const paths = writeDriftReport({ vaultPath: vault, outputDir: "vir" }, r, renderDrift(r));
    expect(paths.dated).toBe(join(vault, "vir", "drift", r.slug, "2026-11-17.md"));
    expect(readFileSync(paths.latest, "utf8")).toContain("kind: drift");
  });
});

describe("driftToolReport", () => {
  it("checks a repo under home and refuses one outside it", () => {
    write("CLAUDE.md", CLEAN_DOC);
    expect(driftToolReport(root, undefined, root, tmpdir())).toContain(NO_DRIFT);
    const elsewhere = mkdtempSync(join(tmpdir(), "vir-drift-home-"));
    expect(() => driftToolReport(root, undefined, root, elsewhere)).toThrow(/home folder/);
    rmSync(elsewhere, { recursive: true, force: true });
    expect(() => driftToolReport(root, "NOPE.md", root, tmpdir())).toThrow(/no doc "NOPE.md"/);
  });
});

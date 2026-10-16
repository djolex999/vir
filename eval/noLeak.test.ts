import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as paths from "./paths.js";

// The repo is public; queries, labels, arm homes and run results carry private
// session content. This test is the guard the 0.4.2 `git add .` sweep never
// had: every data path must resolve under ~/.vir/eval, and nothing that looks
// like eval data may ever be tracked.

const REPO_ROOT = resolve(import.meta.dirname, "..");
const EVAL_HOME = join(homedir(), ".vir", "eval");

describe("eval data never lands in the repo", () => {
  it("every exported path constant resolves under ~/.vir/eval", () => {
    const entries = Object.entries(paths).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, value] of entries) {
      expect(value, name).toMatch(/^\//);
      expect(value.startsWith(EVAL_HOME), `${name}=${value}`).toBe(true);
      expect(value.startsWith(REPO_ROOT), `${name} inside repo`).toBe(false);
    }
  });

  it("git tracks no eval data files", () => {
    const tracked = execFileSync("git", ["ls-files", "eval"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    const forbidden = tracked.filter(
      (p) =>
        /^eval\/(data|dist|homes|runs)\//.test(p) ||
        /^eval\/analysis\/\.venv\//.test(p) ||
        /\.(db|jsonl|png|csv|parquet)$/.test(p) ||
        /(queries|labels|pool|spotcheck)\.json$/.test(p),
    );
    expect(forbidden).toEqual([]);
  });

  it(".gitignore excludes eval/dist, eval/data and the analysis venv", () => {
    const ignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
    expect(ignore).toMatch(/^eval\/dist\/$/m);
    expect(ignore).toMatch(/^eval\/data\/$/m);
    expect(ignore).toMatch(/^eval\/analysis\/\.venv\/$/m);
  });

  it("the only committed analysis fixture is the synthetic bootstrap golden", () => {
    // eval/analysis/tests/fixtures is for numbers generated from code
    // (golden.ts), never for anything copied out of ~/.vir/eval.
    const fixtures = execFileSync("git", ["ls-files", "eval/analysis/tests/fixtures"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(fixtures.filter((p) => p !== "eval/analysis/tests/fixtures/bootstrap_golden.json")).toEqual([]);
  });
});

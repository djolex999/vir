import { describe, expect, it } from "vitest";
import { asRepoPath, extractClaims } from "./extract.js";
import type { Claim } from "./types.js";

const ctx = { bins: new Set(["vir"]) };
const values = (cs: Claim[], kind: Claim["kind"]): string[] => cs.filter((c) => c.kind === kind).map((c) => c.value);

describe("asRepoPath", () => {
  it("keeps relative repo paths", () => {
    expect(asRepoPath("src/cli.ts")).toBe("src/cli.ts");
    expect(asRepoPath("./docs/plans/")).toBe("docs/plans/");
    expect(asRepoPath("src/a.ts:42")).toBe("src/a.ts");
  });

  it("drops home, absolute, placeholder, glob and prose paths", () => {
    for (const s of ["~/.vir/config.json", "/etc/hosts", "<notes folder>/vir/", "src/**/*.ts", "https://x.dev/a.md", "owner/repo", "a/b c.ts", "lessons.md"]) {
      expect(asRepoPath(s)).toBeNull();
    }
  });
});

describe("extractClaims", () => {
  it("rebuilds full paths from a fenced directory tree", () => {
    const md = ["```", "src/", "  cli.ts        # entry", "                # continued comment", "  pipeline/", "    run.ts", "    a.ts, b.ts,", "    c.ts", "  config.ts", "```"].join("\n");
    expect(values(extractClaims(md, ctx), "path")).toEqual([
      "src/", "src/cli.ts", "src/pipeline/", "src/pipeline/run.ts", "src/pipeline/a.ts", "src/pipeline/b.ts", "src/pipeline/c.ts", "src/config.ts",
    ]);
  });

  it("ignores fenced code that is not a tree", () => {
    const md = ["```ts", "const x = 1;", "export function y() {}", "```"].join("\n");
    expect(values(extractClaims(md, ctx), "path")).toEqual([]);
  });

  it("skips the VIR managed block", () => {
    const md = ["Real: `src/real.ts`", "<!-- VIR:START -->", "- `src/distilled.ts`", "<!-- VIR:END -->"].join("\n");
    expect(values(extractClaims(md, ctx), "path")).toEqual(["src/real.ts"]);
  });

  it("reads CLI commands, subcommands and flags for the repo's own bin only", () => {
    const md = "Run `vir run --dry-run`, then `vir schedule install`. Not `codex exec --json`.";
    const cs = extractClaims(md, ctx);
    expect(values(cs, "cli-command")).toEqual(["run", "schedule install"]);
    expect(values(cs, "cli-flag")).toEqual(["--dry-run"]);
  });

  it("reads npm scripts and the package manager", () => {
    const cs = extractClaims("Use `npm run build` and `npm test`; `pnpm lint`; `pnpm install`.", ctx);
    expect(values(cs, "npm-script")).toEqual(["build", "test", "lint"]);
    expect(values(cs, "package-manager")).toEqual(["npm", "pnpm"]);
  });

  it("reads dependencies from stack list subjects, installs and scoped names", () => {
    const md = [
      "## Stack",
      "- `commander` for CLI, `chalk` for output",
      "- macOS `launchd` for the daemon; native `fetch`",
      "",
      "## Setup",
      "Add `npm install zod@3` once. `npm install -g some-cli` is global.",
      "Talks to `@anthropic-ai/sdk`.",
    ].join("\n");
    expect(values(extractClaims(md, ctx), "dependency")).toEqual(["commander", "chalk", "zod", "@anthropic-ai/sdk"]);
  });

  it("needs env context for a bare env var name", () => {
    const md = ["Set `KIE_API_KEY` in your env.", "The `MAX_BODY_CHARS` constant.", "`process.env.OPENAI_KEY`", "```", "export FOO_BAR=1", "```"].join("\n");
    expect(values(extractClaims(md, ctx), "env-var")).toEqual(["KIE_API_KEY", "OPENAI_KEY", "FOO_BAR"]);
  });

  it("reads relative markdown links, not URLs or anchors", () => {
    const md = "See [plan](docs/plan.md#top), [site](https://x.dev), [here](#a), ![g](assets/g.png).";
    expect(values(extractClaims(md, ctx), "path")).toEqual(["docs/plan.md", "assets/g.png"]);
  });
});

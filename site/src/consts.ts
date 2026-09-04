import pkg from "../../package.json" with { type: "json" };

export const SITE_URL = "https://virwiki.dev";
export const NPM_PKG = "@djolex999/vir-cli";
export const GITHUB_URL = "https://github.com/djolex999/vir";
export const NPM_URL = "https://www.npmjs.com/package/@djolex999/vir-cli";
export const PLUGIN_URL = "https://github.com/djolex999/vir-obsidian";
export const KARPATHY_GIST =
  "https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f";
export const KARPATHY_POST = "https://x.com/karpathy/status/2039805659525644595";
export const VERSION: string = pkg.version;

export const INSTALL_CMD = `npm install -g ${NPM_PKG}`;

// Every figure on the page. null = not yet measured; the block that needs it
// is omitted and the build prints the key. See spec §11.
// Measured 2026-09-04 on the author's machine. How each was derived:
//   sessionsRescued  — sessions in ~/.vir/vir.db with a note written whose
//                      transcript file no longer exists on disk
//   transcriptsSeen  — rows in the sessions table
//   transcriptsNoise — skip_reason in (workflow-transcript, agent-transcript, sidechain-transcript)
//   transcriptsNotes — skipped=0 and note_paths != '[]'
//   vaultNotes/Links — *.md files under the vault's vir/ dir, [[wikilink]] occurrences
//   tests            — `npm test` at the repo root
//   cost*            — `vir cost --since 180d`
export const NUMBERS = {
  sessionsRescued: 396,
  transcriptsSeen: 1386,
  transcriptsNoise: 562,
  transcriptsNotes: 410,
  tests: 534 as number | null,
  vaultNotes: 465 as number | null,
  vaultLinks: 3549 as number | null,
  costWindow: "six months",
  costSessions: 295,
  costTotal: "$20.38" as string | null,
  costMedian: "$0.004" as string | null,
  costP90: "$0.13" as string | null,
  measuredOn: "September 2026",
};

export const MEASURE: string[] = Object.entries(NUMBERS)
  .filter(([, v]) => v === null)
  .map(([k]) => k);

export const WORKS_WITH = [
  "Claude Code",
  "Obsidian",
  "MCP",
  "Dataview",
  "Ollama",
  "Web Clipper",
] as const;

export interface LoopNode {
  id: string;
  label: string;
  blurb: string;
  command: string | null;
}

export const LOOP_NODES: LoopNode[] = [
  {
    id: "sessions",
    label: "Claude Code sessions",
    blurb:
      "Transcripts already on disk under ~/.claude/projects. Months of them, until Claude Code prunes them.",
    command: null,
  },
  {
    id: "vir",
    label: "vir",
    blurb:
      "Filters out subagent runs, workflow phases, and headless agents, classifies what survives, and distills durable knowledge.",
    command: "vir run",
  },
  {
    id: "vault",
    label: "Obsidian vault",
    blurb:
      "Typed markdown notes — patterns, gotchas, decisions, tools — with frontmatter and wikilinks. They show up in the graph.",
    command: "vir query \"<question>\"",
  },
  {
    id: "claudemd",
    label: "CLAUDE.md",
    blurb:
      "The best notes fed back into your project's CLAUDE.md, with a diff and your confirmation.",
    command: "vir sync-claude",
  },
  {
    id: "better",
    label: "Better sessions",
    blurb:
      "The next session starts knowing what the last one learned. A daemon keeps the loop turning.",
    command: "vir schedule install",
  },
];

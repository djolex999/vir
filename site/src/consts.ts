import pkg from "../../package.json" with { type: "json" };

export const SITE_URL = "https://vir.sh";
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
export const NUMBERS = {
  sessionsRescued: 354,
  transcriptsTotal: 243,
  transcriptsMine: 20,
  tests: null as number | null,
  vaultNotes: null as number | null,
  vaultLinks: null as number | null,
  costRun: null as string | null,
  costRunTime: null as string | null,
  costOngoing: null as string | null,
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

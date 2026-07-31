export interface TranscriptLine {
  type?: string;
  role?: string;
  content?: unknown;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  toolUseResult?: unknown;
  [key: string]: unknown;
}

export interface ParsedSession {
  path: string;
  hash: string;
  sessionId: string;
  projectSlug: string;
  startedAt: string | null;
  endedAt: string | null;
  lineCount: number;
  toolCallCount: number;
  filesTouched: string[];
  assistantText: string;
  userText: string;
  rawSummary: string;
  // Chronological prose + tool blocks ([tool_use:…] / [tool_result:…]) for the
  // distill stage. Prose-only fields above feed classification + the heuristic
  // filter, so tool noise stays out of them.
  transcriptText: string;
  // True when any line carries isSidechain: true — an agent-internal
  // (subagent/workflow) transcript. Content-level backstop for the
  // structural transcript-category filter.
  isSidechain: boolean;
  // Launch signature: the first user line's entrypoint (e.g. "sdk-py" for
  // SDK-launched harness agents, "cli"/"claude-desktop" for human sessions).
  // Content-level backstop for the agent-transcript filter.
  entrypoint: string | null;
}

export type Category = "pattern" | "gotcha" | "decision" | "tool";

export interface Classification {
  category: Category;
  topic: string;
  project: string;
  confidence: number;
  // Distinct topics/threads the model found in the session. A diagnostic signal
  // surfacing multi-theme dilution (a grab-bag session names only one in `topic`)
  // — written to note frontmatter, not used by retrieval. Empty when none.
  themes: string[];
}

export interface DistilledNote {
  classification: Classification;
  markdown: string;
}

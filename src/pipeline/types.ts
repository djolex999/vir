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
}

export type Category = "pattern" | "gotcha" | "decision" | "tool";

export interface Classification {
  category: Category;
  topic: string;
  project: string;
  confidence: number;
}

export interface DistilledNote {
  classification: Classification;
  markdown: string;
}

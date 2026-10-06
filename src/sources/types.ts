import type { DiscoveredSession } from "../pipeline/scanner.js";
import type { TranscriptCategory } from "../pipeline/projects.js";
import type { ParsedSession } from "../pipeline/types.js";

export type SourceId = "claude-code" | "codex" | "unknown";

export interface SourceSession extends DiscoveredSession {
  source: SourceId;
}

// One coding agent's transcript store. Everything downstream of parse() runs
// on the agent-neutral ParsedSession; only these steps are agent-shaped.
export interface SessionSource {
  readonly id: SourceId;
  readonly label: string;
  readonly root: string;
  // Days until the agent deletes its own transcripts; null = never. Drives the
  // "undecided means lost" nudges.
  readonly retentionDays: number | null;
  owns(path: string): boolean;
  scan(): SourceSession[];
  // Structural: is this transcript agent-internal by layout/metadata?
  category(path: string): TranscriptCategory;
  // Headless/SDK launch signature; null = human or unknown.
  agentEntrypoint(path: string): string | null;
  projectName(path: string): string;
  parse(path: string, hash: string, projectSlug?: string): ParsedSession;
}

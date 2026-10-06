import { relative } from "node:path";
import { parseSession } from "../pipeline/parser.js";
import {
  classifyTranscript,
  decodeProjectName,
  projectDirOf,
  readTranscriptHead,
  sniffAgentEntrypoint,
  type DecodeDeps,
} from "../pipeline/projects.js";
import { scanSessions } from "../pipeline/scanner.js";
import type { SessionSource } from "./types.js";

// Claude Code deletes transcripts after ~30 days (cleanupPeriodDays default).
const CLAUDE_RETENTION_DAYS = 30;

export function createClaudeCodeSource(
  root: string,
  deps?: Partial<DecodeDeps>,
): SessionSource {
  // decodeProjectName walks the filesystem from "/" — cache per project DIR
  // (the key groupByProject uses), never per session path.
  const byDir = new Map<string, string>();
  return {
    id: "claude-code",
    label: "Claude Code",
    root,
    retentionDays: CLAUDE_RETENTION_DAYS,
    owns: (path) => {
      const rel = relative(root, path);
      return rel.length > 0 && !rel.startsWith("..");
    },
    scan: () =>
      scanSessions(root).map((s) => ({ ...s, source: "claude-code" as const })),
    category: (path) => classifyTranscript(path, root),
    agentEntrypoint: (path) => sniffAgentEntrypoint(readTranscriptHead(path)),
    projectName: (path) => {
      const dir = projectDirOf(path, root);
      let name = byDir.get(dir);
      if (name === undefined) {
        name = decodeProjectName(dir, root, deps);
        byDir.set(dir, name);
      }
      return name;
    },
    parse: (path, hash, slug) => parseSession(path, hash, slug),
  };
}

import { basename, dirname } from "node:path";
import type { Config } from "../config.js";
import { parseSession } from "../pipeline/parser.js";
import {
  decodeProjectName,
  readTranscriptHead,
  sniffAgentEntrypoint,
  type ProjectGroup,
} from "../pipeline/projects.js";
import { createClaudeCodeSource } from "./claudeCode.js";
import type { SessionSource, SourceSession } from "./types.js";

export type SourceConfig = Pick<Config, "claudeProjectsDir" | "codexSessionsDir">;

export function buildSources(cfg: SourceConfig): SessionSource[] {
  const sources: SessionSource[] = [];
  if (cfg.claudeProjectsDir) {
    sources.push(createClaudeCodeSource(cfg.claudeProjectsDir));
  }
  return sources;
}

// A path no configured source owns (a moved root, a test fixture) keeps the
// semantics the pipeline gave it before sources existed: an ordinary session,
// named after its parent dir, parsed as Claude Code JSONL.
export const FALLBACK_SOURCE: SessionSource = {
  id: "unknown",
  label: "unknown",
  root: "",
  retentionDays: null,
  owns: () => true,
  scan: () => [],
  category: () => "session",
  agentEntrypoint: (path) => sniffAgentEntrypoint(readTranscriptHead(path)),
  projectName: (path) => decodeProjectName(basename(dirname(path)), ""),
  parse: (path, hash, slug) => parseSession(path, hash, slug),
};

export function resolveSource(
  sources: SessionSource[],
  path: string,
): SessionSource {
  return sources.find((s) => s.owns(path)) ?? FALLBACK_SOURCE;
}

export function scanAll(sources: SessionSource[]): SourceSession[] {
  return sources.flatMap((s) => s.scan());
}

// Same merge semantics as groupByProject: sessions whose sources name the same
// project land in one group. Name caching lives in each source.
export function groupSessions(
  sessions: Array<{ path: string; hash: string; size: number }>,
  sources: SessionSource[],
): Map<string, ProjectGroup> {
  const groups = new Map<string, ProjectGroup>();
  for (const s of sessions) {
    const name = resolveSource(sources, s.path).projectName(s.path);
    let g = groups.get(name);
    if (!g) {
      g = { name, sessions: [], totalBytes: 0 };
      groups.set(name, g);
    }
    g.sessions.push(s);
    g.totalBytes += s.size;
  }
  return groups;
}

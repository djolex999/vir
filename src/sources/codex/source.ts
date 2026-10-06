import { closeSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { scanSessions } from "../../pipeline/scanner.js";
import type { SessionSource } from "../types.js";
import { parseCodexSession } from "./parser.js";

export interface CodexMeta {
  cwd: string;
  originator: string | null;
  source: unknown;
}

const CHUNK = 64 * 1024;
// session_meta carries the base instructions and runs to tens of KB.
const META_CAP = 1024 * 1024;

// First line only. readTranscriptHead doesn't fit: it waits for a
// type:"user" line Codex never writes.
export function readCodexMeta(path: string): CodexMeta | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(CHUNK);
      const n = readSync(fd, buf, 0, CHUNK, total);
      if (n === 0) break;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      chunks.push(buf.subarray(0, nl === -1 ? n : nl));
      total += nl === -1 ? n : nl;
      if (nl !== -1) break;
      if (total > META_CAP) return null;
    }
    if (total === 0 || total > META_CAP) return null;
    const evt = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      type?: unknown;
      payload?: Record<string, unknown>;
    };
    const p = evt.payload;
    if (evt.type !== "session_meta" || !p || typeof p.cwd !== "string") return null;
    return {
      cwd: p.cwd,
      originator: typeof p.originator === "string" ? p.originator : null,
      source: p.source ?? null,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

const WORKTREE_SEGMENT = `${sep}.claude${sep}worktrees${sep}`;

// Leaf rule, same as Claude's decodeProjectName, so a directory used from
// either agent lands in one project. Holds only while the directory exists:
// once it's deleted Claude falls back to the raw encoded dir name, while
// Codex still says the leaf. Accepted.
function codexProjectName(cwd: string, home: string): string {
  const scratch = join(home, "Documents", "Codex");
  const rel = relative(scratch, cwd);
  if (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep)) return "codex-scratch";
  const wt = cwd.indexOf(WORKTREE_SEGMENT);
  if (wt !== -1) return basename(cwd.slice(0, wt));
  return basename(cwd);
}

export function createCodexSource(root: string, deps: { home?: string } = {}): SessionSource {
  const home = deps.home ?? homedir();
  const metaByPath = new Map<string, CodexMeta | null>();
  const meta = (path: string): CodexMeta | null => {
    if (!metaByPath.has(path)) metaByPath.set(path, readCodexMeta(path));
    return metaByPath.get(path) ?? null;
  };
  return {
    id: "codex",
    label: "Codex",
    // ~/.codex/archived_sessions is a sibling of root and never scanned:
    // archiving a thread hides it from vir.
    root,
    retentionDays: null,
    owns: (path) => {
      const rel = relative(root, path);
      return rel.length > 0 && !rel.startsWith("..");
    },
    scan: () => scanSessions(root).map((s) => ({ ...s, source: "codex" as const })),
    // Subagent/guardian threads carry an object `source`; humans a string.
    category: (path) => {
      const m = meta(path);
      return m !== null && m.source !== null && typeof m.source === "object" ? "sidechain" : "session";
    },
    // Verified 2026-10-07 (codex-cli 0.160.1): `codex exec` writes
    // source "exec", originator "codex_exec".
    agentEntrypoint: (path) => {
      const m = meta(path);
      return m !== null && m.source === "exec" ? m.originator : null;
    },
    projectName: (path) => {
      const m = meta(path);
      return m === null ? basename(dirname(path)) : codexProjectName(m.cwd, home);
    },
    parse: (path, hash, slug) => parseCodexSession(path, hash, slug),
  };
}

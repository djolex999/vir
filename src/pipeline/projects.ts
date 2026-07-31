import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { computeCost, type PricingOverrides } from "../cost/pricing.js";

// Dependency-injection seam for tests: list the sub-DIRECTORIES of a path,
// [] on any error. The default reads the real filesystem.
export interface DecodeDeps {
  readDir: (path: string) => string[];
}

function defaultReadDir(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Claude Code encodes a session's cwd into the transcript dir name by
// replacing every non-alphanumeric character with "-". Apply the same
// encoding to real dir names so on-disk candidates compare against the
// encoded segments byte-for-byte.
function encodeSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "-");
}

// Walk the real filesystem from `cur`, consuming `remaining` (the encoded
// path with its leading dash stripped). Dashes are ambiguous — they encode
// both path separators and literal dashes/dots/spaces — so try candidates
// longest-encoding-first and backtrack: only a FULL resolution counts.
// Returns the on-disk basename of the resolved leaf, or null.
function resolveEncoded(
  cur: string,
  remaining: string,
  readDir: (path: string) => string[],
): string | null {
  const candidates = readDir(cur)
    .map((name) => ({ name, enc: encodeSegment(name) }))
    .filter(
      ({ enc }) =>
        enc.length > 0 &&
        (enc === remaining || remaining.startsWith(enc + "-")),
    )
    .sort((a, b) => b.enc.length - a.enc.length);
  for (const { name, enc } of candidates) {
    if (enc === remaining) return name;
    const leaf = resolveEncoded(
      join(cur, name),
      remaining.slice(enc.length + 1),
      readDir,
    );
    if (leaf !== null) return leaf;
  }
  return null;
}

// Decode a transcript directory name ("-Users-me-projects-my-app") to its
// project name ("my-app") by resolving the encoded absolute path against
// directories that actually exist on disk, longest match wins. Falls back to
// the raw dir name when nothing fully resolves — never throws, never guesses.
export function decodeProjectName(
  dirName: string,
  projectsDir: string,
  deps?: Partial<DecodeDeps>,
): string {
  const readDir = deps?.readDir ?? defaultReadDir;
  const name =
    dirName.includes("/") && dirName.startsWith(projectsDir)
      ? basename(dirName)
      : dirName;
  if (!name.startsWith("-")) return name;
  const leaf = resolveEncoded("/", name.slice(1), readDir);
  return leaf ?? name;
}

// A transcript's category from its on-disk layout. Real shapes:
//   <projectsDir>/<encoded>/<session-id>.jsonl                          session
//   <projectsDir>/<encoded>/<sid>/subagents/agent-*.jsonl               sidechain
//   <projectsDir>/<encoded>/<sid>/subagents/workflows/wf_*/agent-*.jsonl workflow
// Both nested kinds are agent-internal execution, not user knowledge. The
// `subagents` marker must sit BELOW the encoded project dir — a project
// literally named "subagents" stays a session. Anything not under
// projectsDir is a session: never guess.
export type TranscriptCategory = "session" | "workflow" | "sidechain";

export function classifyTranscript(
  path: string,
  projectsDir: string,
): TranscriptCategory {
  const rel = relative(projectsDir, path);
  if (rel.startsWith("..")) return "session";
  const segments = rel.split(sep);
  // segments[0] is the encoded project dir; look for `subagents` below it.
  const subIdx = segments.indexOf("subagents", 1);
  if (subIdx === -1) return "session";
  const below = segments.slice(subIdx + 1);
  const isWorkflow = below.some(
    (s) => s === "workflows" || s.startsWith("wf_"),
  );
  return isWorkflow ? "workflow" : "sidechain";
}

// SDK launch signature: the first `type:"user"` line's `entrypoint` starting
// with "sdk" marks an agent-internal transcript (review/verify harness agents
// stored top-level). Keyed on entrypoint ONLY — promptSource reads "sdk" even
// on desktop-launched human sessions (the C23 serbeval trap), and turn count
// would kill single-prompt autonomous runs. Returns the entrypoint, or null
// for human sessions, truncated heads, or anything unparseable — a miss here
// falls through to the parser backstop, never to a paid call.
export function sniffAgentEntrypoint(head: string): string | null {
  for (const line of head.split("\n")) {
    if (line.trim().length === 0) continue;
    let evt: { type?: unknown; entrypoint?: unknown };
    try {
      evt = JSON.parse(line) as { type?: unknown; entrypoint?: unknown };
    } catch {
      // truncated tail line or garbage — never a user line we can trust
      continue;
    }
    if (evt.type !== "user") continue;
    return typeof evt.entrypoint === "string" &&
      evt.entrypoint.startsWith("sdk")
      ? evt.entrypoint
      : null;
  }
  return null;
}

// How much of a transcript the scan-time sniff reads. Review-agent first
// prompts embed whole diffs, so the first user line can be tens of KB; 256KB
// covers every observed case while staying trivial next to the full-file
// read the scanner already does for hashing.
export const SNIFF_HEAD_BYTES = 262_144;

export function readTranscriptHead(
  path: string,
  bytes: number = SNIFF_HEAD_BYTES,
): string {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const n = readSync(fd, buf, 0, bytes, 0);
      return buf.toString("utf8", 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

// Rough triage category for the init wizard's counts line
// ("21 interactive · 67 SDK-launched · 9 stubs"). Display-only — the run
// gate uses sniffAgentEntrypoint directly. A stub is a tiny COMPLETE
// transcript (head covers the whole file) with ≤10 non-blank lines: /clear
// markers and aborted launches. A truncated head is always interactive —
// never downgrade what we can't see.
export function categorizeTranscriptHead(
  head: string,
  sizeBytes: number,
): "agent" | "stub" | "interactive" {
  if (sniffAgentEntrypoint(head) !== null) return "agent";
  const complete = head.length >= sizeBytes;
  const lines = head.split("\n").filter((l) => l.trim().length > 0).length;
  return complete && lines <= 10 ? "stub" : "interactive";
}

// The per-session effective decision for a run. "flag-skip" means a one-off
// run flag (--only / --exclude-project) put the session out of scope for THIS
// run only — no DB row, no config change. Config decisions are checked first
// so an excluded project always records its "project-excluded" row even when
// --only names it.
export type ProjectDecision = "include" | "exclude" | "pending" | "flag-skip";

export interface RunProjectFlags {
  only?: string[];
  excludeProject?: string[];
}

export function decideProject(
  name: string,
  configured: Record<string, "include" | "exclude">,
  flags?: RunProjectFlags,
): ProjectDecision {
  const configuredDecision = configured[name];
  if (configuredDecision === "exclude") return "exclude";
  if (flags?.excludeProject?.includes(name) === true) return "flag-skip";
  if (
    flags?.only !== undefined &&
    flags.only.length > 0 &&
    !flags.only.includes(name)
  ) {
    return "flag-skip";
  }
  return configuredDecision === "include" ? "include" : "pending";
}

export interface ProjectGroup {
  name: string;
  sessions: Array<{ path: string; hash: string; size: number }>;
  totalBytes: number;
}

// Group discovered sessions by decoded project name. Two transcript dirs can
// decode to the same project (rare, but a renamed cwd does it) — they merge.
// The decode cache matters: decodeProjectName walks the filesystem, and a
// scan can hold hundreds of sessions across a handful of dirs.
export function groupByProject(
  sessions: Array<{ path: string; hash: string; size: number }>,
  projectsDir: string,
  deps?: Partial<DecodeDeps>,
): Map<string, ProjectGroup> {
  const cache = new Map<string, string>();
  const groups = new Map<string, ProjectGroup>();
  for (const s of sessions) {
    // The project dir is the FIRST segment under projectsDir — workflow and
    // subagent transcripts nest one level deeper (<encoded>/<session-id>/
    // wf_*.jsonl) and must group under their project, not the inner dir.
    const rel = relative(projectsDir, s.path);
    const dirName =
      !rel.startsWith("..") && rel.includes(sep)
        ? (rel.split(sep)[0] ?? basename(dirname(s.path)))
        : basename(dirname(s.path));
    let name = cache.get(dirName);
    if (name === undefined) {
      name = decodeProjectName(dirName, projectsDir, deps);
      cache.set(dirName, name);
    }
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

// Rough per-session cost estimate from raw transcript size — for the triage
// UIs (init multi-select, undecided prompt, `vir projects`), NOT billing.
// Derivation from real dry-run calibration: transcript prose+tools ≈ half the
// JSONL bytes, the moderate tool filter keeps ~45% of that, chars/3 density
// → distill input ≈ bytes/13; classify sees prose only ≈ bytes/60. Upper
// bound: heuristic-filtered sessions actually cost nothing.
const DISTILL_BYTES_PER_TOKEN = 13;
const CLASSIFY_BYTES_PER_TOKEN = 60;
const MAX_DISTILL_INPUT_TOKENS = 150_000;
const MAX_CLASSIFY_INPUT_TOKENS = 30_000;

export function estimateSessionCost(
  provider: "anthropic" | "kie",
  classifyModel: string,
  distillModel: string,
  sizeBytes: number,
  pricing?: PricingOverrides,
  kieTopUpTier?: "standard" | "high",
): number {
  const classifyIn = Math.min(
    Math.ceil(sizeBytes / CLASSIFY_BYTES_PER_TOKEN),
    MAX_CLASSIFY_INPUT_TOKENS,
  );
  const distillIn = Math.min(
    Math.ceil(sizeBytes / DISTILL_BYTES_PER_TOKEN),
    MAX_DISTILL_INPUT_TOKENS,
  );
  return (
    computeCost(provider, classifyModel, classifyIn, 350, pricing, kieTopUpTier) +
    computeCost(provider, distillModel, distillIn, 4500, pricing, kieTopUpTier)
  );
}

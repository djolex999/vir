import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "../config.js";
import type { DistilledRow, StateDb } from "../state/db.js";
import {
  buildAnthropicClient,
  callLLM,
  normalizeModelName,
  withRateLimitRetry,
} from "../pipeline/distiller.js";
import { kebab } from "../pipeline/writer.js";

const CATEGORY_DIRS: Record<string, string> = {
  pattern: "patterns",
  gotcha: "gotchas",
  decision: "decisions",
  tool: "tools",
};

export interface MergeOutcome {
  winnerPath: string;
  archivedPath: string;
  action: "keep-a" | "keep-b" | "merge";
}

export async function mergeNotes(
  cfg: Config,
  db: StateDb,
  a: DistilledRow,
  b: DistilledRow,
  keepWhich: "A" | "B" | "merge",
): Promise<MergeOutcome> {
  const root = join(cfg.vaultPath, cfg.outputDir);
  const archivedDir = join(root, "archived");
  if (!existsSync(archivedDir)) mkdirSync(archivedDir, { recursive: true });

  const aFile = resolveNotePath(root, a);
  const bFile = resolveNotePath(root, b);

  if (keepWhich === "merge") {
    return doMerge(cfg, db, root, archivedDir, a, b, aFile, bFile);
  }

  const loser = keepWhich === "A" ? b : a;
  const winnerFile = keepWhich === "A" ? aFile : bFile;
  const loserFile = keepWhich === "A" ? bFile : aFile;

  const archivedPath = archiveFile(archivedDir, loserFile);
  appendArchivedSection(winnerFile, archivedPath);
  db.archive(loser.path);

  return {
    winnerPath: winnerFile,
    archivedPath,
    action: keepWhich === "A" ? "keep-a" : "keep-b",
  };
}

async function doMerge(
  cfg: Config,
  db: StateDb,
  root: string,
  archivedDir: string,
  a: DistilledRow,
  b: DistilledRow,
  aFile: string,
  bFile: string,
): Promise<MergeOutcome> {
  // Higher-confidence row wins the file path (and DB content); tie → A.
  const aWins = a.confidence >= b.confidence;
  const winner = aWins ? a : b;
  const loser = aWins ? b : a;
  const winnerFile = aWins ? aFile : bFile;
  const loserFile = aWins ? bFile : aFile;

  const prompt = `Merge these two knowledge notes into one superior note.
Keep all unique insights from both. Use the better structure.
Output only the merged markdown body, no frontmatter.

Note A:
${a.content}

Note B:
${b.content}`;

  const client = buildAnthropicClient(cfg);
  const model = normalizeModelName(cfg.models.distill, cfg.provider);
  const merged = (
    await withRateLimitRetry(() =>
      callLLM(cfg, client, { prompt, model, maxTokens: 2000 }),
    )
  ).trim();

  rewriteWinnerBody(winnerFile, merged);
  db.updateContent(winner.path, merged);

  const archivedPath = archiveFile(archivedDir, loserFile);
  appendArchivedSection(winnerFile, archivedPath);
  db.archive(loser.path);
  void root;

  return { winnerPath: winnerFile, archivedPath, action: "merge" };
}

function resolveNotePath(root: string, r: DistilledRow): string {
  const dir = CATEGORY_DIRS[r.category] ?? `${r.category}s`;
  const slug = kebab(r.topic);
  const suffix = r.sessionId.slice(0, 8);
  return join(root, dir, `${slug}-${suffix}.md`);
}

function archiveFile(archivedDir: string, sourcePath: string): string {
  if (!existsSync(sourcePath)) {
    // Nothing to move on disk; still record what the target *would* have been.
    return join(archivedDir, basename(sourcePath));
  }
  const dest = uniquePath(join(archivedDir, basename(sourcePath)));
  renameSync(sourcePath, dest);
  return dest;
}

function uniquePath(p: string): string {
  if (!existsSync(p)) return p;
  const dot = p.lastIndexOf(".");
  const base = dot === -1 ? p : p.slice(0, dot);
  const ext = dot === -1 ? "" : p.slice(dot);
  let i = 1;
  while (existsSync(`${base}-${i}${ext}`)) i += 1;
  return `${base}-${i}${ext}`;
}

function appendArchivedSection(winnerFile: string, archivedPath: string): void {
  if (!existsSync(winnerFile)) return;
  const loserSlug = basename(archivedPath, ".md");
  const link = `- [[${loserSlug}]]`;

  const current = readFileSync(winnerFile, "utf8");
  if (current.includes("## Archived Duplicates")) {
    // Append the bullet under the existing section.
    const updated = current.replace(
      /(## Archived Duplicates\n(?:[\s\S]*?))(\n##|\n*$)/,
      (_match, body: string, tail: string) =>
        `${body}${body.endsWith("\n") ? "" : "\n"}${link}\n${tail}`,
    );
    writeFileSync(winnerFile, updated);
  } else {
    appendFileSync(winnerFile, `\n## Archived Duplicates\n${link}\n`);
  }
}

// Replaces the body (everything after the YAML frontmatter) with merged
// markdown. Preserves the original frontmatter block.
function rewriteWinnerBody(winnerFile: string, mergedBody: string): void {
  if (!existsSync(winnerFile)) {
    writeFileSync(winnerFile, mergedBody + "\n");
    return;
  }
  const current = readFileSync(winnerFile, "utf8");
  const fmMatch = current.match(/^(---\n[\s\S]*?\n---\n)/);
  if (!fmMatch) {
    writeFileSync(winnerFile, mergedBody + "\n");
    return;
  }
  writeFileSync(winnerFile, `${fmMatch[1]}\n${mergedBody}\n`);
}

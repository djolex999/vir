import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, STATE_PATH } from "../../src/config.js";
import { parseSession } from "../../src/pipeline/parser.js";
import { classifyTranscript, projectNameFor } from "../../src/pipeline/projects.js";
import { scanSessions } from "../../src/pipeline/scanner.js";
import { scrub } from "../../src/pipeline/scrubber.js";
import { filterToolCalls } from "../../src/pipeline/toolCallFilter.js";
import { StateDb } from "../../src/state/db.js";
import { callJudge, EVAL_MODEL, mapLimit } from "../llm.js";
import { USEFULNESS_CACHE_DIR, USEFULNESS_QUESTIONS_PATH } from "../paths.js";
import { createCache, type ResultCache } from "./cache.js";
import { buildMinerPrompt, capCandidates, MAX_TRANSCRIPT_CHARS, MINER_PROMPT_VERSION, selectCandidates, validateMined, type Candidate } from "./mine.js";
import type { DropReason, MinedQuestion, QuestionFile } from "./types.js";

export interface MineDeps {
  llm(prompt: string, session: string): Promise<string>;
  cache: ResultCache;
  now(): string;
  out: string;
  // Injectable so tests never print progress/summary lines to stdout (M1).
  log(line: string): void;
}

export async function mineQuestions(opts: { dryRun: boolean; max?: number; deps?: Partial<MineDeps> }): Promise<QuestionFile | null> {
  const d: MineDeps = {
    llm: async (prompt, session) => (await callJudge("eval-usefulness-mine", prompt, session)).text,
    cache: createCache(USEFULNESS_CACHE_DIR),
    now: () => new Date().toISOString(),
    out: USEFULNESS_QUESTIONS_PATH,
    log: (line) => process.stdout.write(line),
    ...opts.deps,
  };
  const cfg = loadConfig();
  const dir = cfg.claudeProjectsDir;
  if (dir === undefined) throw new Error("usefulness mining reads Claude Code transcripts: set claudeProjectsDir in ~/.vir/config.json");
  const db = new StateDb(STATE_PATH, { readonly: true });
  const noteStarts = new Map<string, string[]>();
  try {
    for (const r of db.listDistilled()) {
      if (r.startedAt === null) continue;
      const p = projectNameFor(r.path, dir);
      noteStarts.set(p, [...(noteStarts.get(p) ?? []), r.startedAt]);
    }
  } finally {
    db.close();
  }
  const scanned = scanSessions(dir);
  const parsedBy = new Map<string, ReturnType<typeof parseSession>>();
  const cands: Candidate[] = [];
  for (const s of scanned) {
    const category = classifyTranscript(s.path, dir);
    if (category !== "session") continue;
    const project = projectNameFor(s.path, dir);
    const parsed = parseSession(s.path, s.hash, project);
    parsedBy.set(s.path, parsed);
    cands.push({
      path: s.path, project, sessionId: parsed.sessionId, startedAt: parsed.startedAt, category,
      agent: parsed.isSidechain || (parsed.entrypoint?.startsWith("sdk") ?? false),
    });
  }
  const chosen = selectCandidates(cands, noteStarts);
  // F2: cap the candidate list before it turns into model calls. No --max ⇒
  // capped === chosen, so behaviour is unchanged.
  const capped = capCandidates(chosen, opts.max);
  const prompts = capped.map((c) => {
    const p = parsedBy.get(c.path)!;
    const text = `${scrub(p.rawSummary)}\n\n${scrub(filterToolCalls(p.transcriptText, "moderate").filtered)}`.slice(0, MAX_TRANSCRIPT_CHARS);
    return { c, text, prompt: buildMinerPrompt(c.project, text) };
  });
  const key = (prompt: string): string[] => ["mine", MINER_PROMPT_VERSION, EVAL_MODEL, prompt];
  if (opts.dryRun) {
    const cached = prompts.filter((x) => d.cache.has(key(x.prompt))).length;
    const capNote = opts.max !== undefined ? `, capped to ${capped.length}` : "";
    d.log(`usefulness mine (dry run): ${scanned.length} transcripts, ${chosen.length} candidates${capNote}, ${prompts.length - cached} model calls needed (${cached} cached)\n`);
    return null;
  }
  const drops: Record<DropReason, number> = { unparsed: 0, "fact-count": 0, "answer-in-question": 0, "bad-evidence": 0 };
  const questions: MinedQuestion[] = [];
  const results = await mapLimit(prompts, 2, async (x) => {
    const { value } = await d.cache.cached(key(x.prompt), () => d.llm(x.prompt, x.c.sessionId));
    return { x, v: validateMined(value, x.text) };
  });
  for (const { x, v } of results) {
    for (const k of Object.keys(drops) as DropReason[]) drops[k] += v.drops[k];
    v.items.forEach((item, i) => questions.push({
      ...item, id: `${x.c.sessionId}#${i}`, project: x.c.project, sessionId: x.c.sessionId,
      transcriptPath: x.c.path, cutoff: x.c.startedAt!,
    }));
  }
  const file: QuestionFile = {
    createdAt: d.now(), minerPromptVersion: MINER_PROMPT_VERSION, model: EVAL_MODEL,
    transcriptsSeen: scanned.length, candidates: capped.length, drops, questions,
  };
  mkdirSync(dirname(d.out), { recursive: true });
  writeFileSync(d.out, JSON.stringify(file, null, 1));
  d.log(`usefulness mine: ${questions.length} questions from ${capped.length} candidates; drops ${JSON.stringify(drops)}\n`);
  return file;
}

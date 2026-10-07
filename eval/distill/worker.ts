// Child process under the real HOME (claude -p needs the Keychain login).
// The arm home arrives as --home: config.json, vir.db and the vault are read
// and written there explicitly; only cost.log lands in the real ~/.vir, with
// provider "claude-cli", which the live config never uses.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ConfigSchema, expandHome, type Config } from "../../src/config.js";
import { COST_LOG_PATH } from "../../src/cost/log.js";
import {
  Distiller,
  normalizeModelName,
  resolveModelShorthand,
  selectDistillModel,
} from "../../src/pipeline/distiller.js";
import { filterToolCalls } from "../../src/pipeline/toolCallFilter.js";
import { parseSession } from "../../src/pipeline/parser.js";
import { hashFile } from "../../src/pipeline/scanner.js";
import { scrub } from "../../src/pipeline/scrubber.js";
import type { Classification } from "../../src/pipeline/types.js";
import { VaultWriter } from "../../src/pipeline/writer.js";
import { StateDb } from "../../src/state/db.js";
import { CONTROL_TEMPLATE, extractPromptTemplate, makeBuilder, promptHash } from "./prompts.js";
import type { Arm } from "./gradingSet.js";
import { pendingEntries } from "./resume.js";

export interface SampleEntry {
  idx: number;
  path: string;
  project: string;
}

export interface ClassifiedEntry {
  idx: number;
  path: string;
  sessionId: string;
  classification: Classification;
  distillTokens: number;
  model: string;
  // A fresh production run would have dropped this session (unparsed or
  // confidence <= 0.6). Recorded, not distilled.
  skipped: string | null;
}

export interface ArmResult {
  idx: number;
  sessionId: string;
  model: string;
  body: string;
  words: number;
  outputTokens: number | null;
  capHit: boolean;
  ms: number;
  notePath: string;
}

export interface ArmOutput {
  arm: Arm;
  promptHash: string;
  home: string;
  results: ArmResult[];
}

// The arm's config, parsed by the production schema, with its vault pinned
// inside the arm home (a config pointing anywhere else is refused).
export function loadArmConfig(home: string): Config {
  const raw = JSON.parse(readFileSync(join(home, ".vir", "config.json"), "utf8")) as unknown;
  const parsed = ConfigSchema.parse(raw);
  const cfg: Config = {
    ...parsed,
    vaultPath: expandHome(parsed.vaultPath),
    ...(parsed.claudeProjectsDir
      ? { claudeProjectsDir: expandHome(parsed.claudeProjectsDir) }
      : {}),
  };
  const vault = resolve(cfg.vaultPath);
  if (!vault.startsWith(resolve(home) + sep)) throw new Error(`refusing: arm vault ${vault} is outside ${home}`);
  return cfg;
}

export function assertInsideHomes(home: string, homesDir: string): void {
  const h = resolve(home);
  const d = resolve(homesDir);
  if (!(h === d || h.startsWith(d + sep)) || h === d) {
    throw new Error(`refusing to run: HOME ${h} is not inside ${d}`);
  }
}

export function lastOutputTokens(costLog: string, sessionId: string): number | null {
  let out: number | null = null;
  for (const line of costLog.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { session?: string; stage?: string; output_tokens?: number };
      if (r.session === sessionId && r.stage === "distill" && typeof r.output_tokens === "number") out = r.output_tokens;
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

const MAX_TOKENS = 1500;

function opt(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

function prepared(path: string, cfgFilter: "aggressive" | "moderate" | "off") {
  const parsed = parseSession(path, hashFile(path));
  const scrubbedSummary = scrub(parsed.rawSummary);
  const scrubbedContent = scrub(filterToolCalls(parsed.transcriptText, cfgFilter).filtered);
  return { parsed, scrubbedSummary, scrubbedContent };
}

async function classifyStage(home: string): Promise<void> {
  const cfg = loadArmConfig(home);
  const sample = JSON.parse(readFileSync(opt("sample"), "utf8")) as { sample: SampleEntry[] };
  const distiller = new Distiller(cfg);
  const out: ClassifiedEntry[] = [];
  for (const s of sample.sample) {
    const { parsed, scrubbedSummary, scrubbedContent } = prepared(s.path, cfg.filterToolCalls);
    const cls = await distiller.classify(parsed, scrubbedSummary);
    const distillTokens = Math.ceil(scrubbedContent.length / 4);
    const model = normalizeModelName(resolveModelShorthand(selectDistillModel(cls, distillTokens, cfg.models)), cfg.provider);
    const skipped = cls.unparsed ? "classify-unparsed" : cls.confidence <= 0.6 ? `low-confidence ${cls.confidence}` : null;
    out.push({ idx: s.idx, path: s.path, sessionId: parsed.sessionId, classification: cls, distillTokens, model, skipped });
    process.stdout.write(`classified #${s.idx} ${cls.category}/${cls.topic} conf=${cls.confidence} → ${model}${skipped ? ` (${skipped})` : ""}\n`);
  }
  writeFileSync(opt("out"), JSON.stringify(out, null, 2));
}

async function distillStage(home: string): Promise<void> {
  const arm = opt("arm") as Arm;
  const cfg = loadArmConfig(home);
  const template = arm === "control" ? CONTROL_TEMPLATE : extractPromptTemplate(readFileSync(opt("challenger"), "utf8"));
  const distiller = new Distiller(cfg, { distillPrompt: makeBuilder(template) });
  const classified = JSON.parse(readFileSync(opt("classifications"), "utf8")) as ClassifiedEntry[];
  const db = new StateDb(join(home, ".vir", "vir.db"));
  const writer = new VaultWriter(cfg, db);
  const costLogPath = COST_LOG_PATH;
  const outPath = opt("out");
  const results: ArmResult[] = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, "utf8")) as ArmOutput).results
    : [];
  const hash = promptHash(template);
  const flush = (): void => {
    const output: ArmOutput = { arm, promptHash: hash, home, results };
    writeFileSync(outPath, JSON.stringify(output, null, 2));
  };
  const todo = pendingEntries(classified, results);
  process.stdout.write(`[${arm}] ${results.length} already done, ${todo.length} to distill\n`);
  for (const c of todo) {
    const { parsed, scrubbedContent } = prepared(c.path, cfg.filterToolCalls);
    const t0 = Date.now();
    const body = await distiller.distill(parsed, scrubbedContent, c.classification, c.model);
    const ms = Date.now() - t0;
    const written = await writer.write(parsed, { classification: c.classification, markdown: body });
    db.record({
      path: c.path,
      hash: parsed.hash,
      skipped: false,
      notePaths: written,
      content: body,
      category: c.classification.category,
      topic: c.classification.topic,
      project: c.classification.project,
      confidence: c.classification.confidence,
      startedAt: parsed.startedAt,
      entrypoint: parsed.entrypoint,
    });
    const outputTokens = existsSync(costLogPath) ? lastOutputTokens(readFileSync(costLogPath, "utf8"), parsed.sessionId) : null;
    results.push({
      idx: c.idx,
      sessionId: parsed.sessionId,
      model: c.model,
      body,
      words: body.split(/\s+/).filter(Boolean).length,
      outputTokens,
      capHit: outputTokens !== null && outputTokens >= MAX_TOKENS,
      ms,
      notePath: written[0] ?? "",
    });
    process.stdout.write(`[${arm}] #${c.idx} ${c.model} ${results[results.length - 1]!.words}w ${outputTokens ?? "?"}tok${outputTokens !== null && outputTokens >= MAX_TOKENS ? " CAP" : ""} ${ms}ms\n`);
    flush();
  }
  db.close();
  flush();
}

async function main(): Promise<void> {
  const home = opt("home");
  assertInsideHomes(home, opt("homes"));
  const stage = opt("stage");
  if (stage === "classify") await classifyStage(home);
  else if (stage === "distill") await distillStage(home);
  else throw new Error(`unknown stage ${stage}`);
}

if (process.argv.includes("--stage")) {
  main().catch((err: unknown) => {
    process.stderr.write(`distill worker failed: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
}

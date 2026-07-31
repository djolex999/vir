/**
 * `vir doctor` — runs every common install/config check and prints a table.
 *
 * Each check returns a CheckResult; the runner records it, renders a row, and
 * tallies pass/warn/fail. Required failures set process.exitCode = 1; warnings
 * (Ollama down, daemon not installed, fresh DB, missing claude CLI) never fail
 * the run — they're advisory states for a perfectly usable install.
 */
import Database from "better-sqlite3";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONFIG_PATH,
  ConfigSchema,
  DAEMON_LOG_PATH,
  STATE_PATH,
  expandHome,
  type Config,
} from "../config.js";
import {
  callLLM,
  maybeAnthropicClient,
  normalizeModelName,
} from "../pipeline/distiller.js";
import { status as daemonStatus } from "../daemon/index.js";
import {
  EMBED_MODEL,
  isOllamaAvailable,
  probeEmbedding,
} from "../search/embedder.js";
import { resolveEmbeddingProvider } from "../search/provider.js";
import { isClaudeAvailable, isInstalled } from "../mcp/install.js";
import { gatherProjectsReport } from "../cli/projects.js";
import { StateDb } from "../state/db.js";
import { buildDoctorResult } from "../output/json.js";
import * as ui from "../ui/display.js";

interface CheckResult {
  status: ui.CheckStatus;
  label: string;
  detail?: string;
}

const ok = (label: string, detail?: string): CheckResult => ({
  status: "ok",
  label,
  detail,
});
const warn = (label: string, detail?: string): CheckResult => ({
  status: "warn",
  label,
  detail,
});
const fail = (label: string, detail?: string): CheckResult => ({
  status: "fail",
  label,
  detail,
});

function collapseHome(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

function truncate(s: string, max = 90): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

// Reject after `ms` so a hung network never wedges the API-key probe.
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

// ── 1. config ────────────────────────────────────────────────────────────────
function checkConfig(): { result: CheckResult; cfg: Config | null } {
  if (!existsSync(CONFIG_PATH)) {
    return { result: fail("config", "missing — run vir init"), cfg: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    return {
      result: fail("config", `invalid JSON — ${(err as Error).message}`),
      cfg: null,
    };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "config"}: ${issue.message}` : "validation failed";
    return { result: fail("config", where), cfg: null };
  }
  const cfg: Config = {
    ...parsed.data,
    vaultPath: expandHome(parsed.data.vaultPath),
    claudeProjectsDir: expandHome(parsed.data.claudeProjectsDir),
  };
  return {
    result: ok("config", `${collapseHome(CONFIG_PATH)} (valid)`),
    cfg,
  };
}

// ── 2. api key ──────────────────────────────────────────────────────────────
async function checkApiKey(cfg: Config): Promise<CheckResult> {
  const provider = cfg.provider;
  if (provider === "anthropic") {
    const key = cfg.anthropicApiKey ?? "";
    if (!key.startsWith("sk-ant-")) {
      return fail("api key", "Anthropic key should start with sk-ant-");
    }
  } else {
    const key = cfg.kieApiKey ?? "";
    if (key.length <= 10) {
      return fail("api key", "Kie key looks too short (≤ 10 chars)");
    }
  }
  try {
    const client = maybeAnthropicClient(cfg);
    await withTimeout(
      callLLM(cfg, client, {
        prompt: "ping",
        model: normalizeModelName(cfg.models.classify, provider),
        maxTokens: 5,
      }),
      15_000,
    );
    return ok("api key", `${provider} · authenticated`);
  } catch (err) {
    return fail("api key", `${provider} · ${truncate((err as Error).message)}`);
  }
}

// ── 3. vault path ─────────────────────────────────────────────────────────────
function checkVaultPath(cfg: Config): CheckResult {
  const p = cfg.vaultPath;
  if (!existsSync(p)) return fail("vault path", `${collapseHome(p)} — missing`);
  if (!statSync(p).isDirectory()) {
    return fail("vault path", `${collapseHome(p)} — not a directory`);
  }
  try {
    accessSync(p, constants.W_OK);
  } catch {
    return fail("vault path", `${collapseHome(p)} — not writable`);
  }
  return ok("vault path", `${collapseHome(p)} (writable)`);
}

// ── 4. output directory ───────────────────────────────────────────────────────
// A diagnostic must not mutate the user's filesystem: just inspect the path.
// (The previous implementation constructed a VaultWriter, which created the
// category dirs as a side effect.)
function checkOutputDir(cfg: Config): CheckResult {
  const dir = join(cfg.vaultPath, cfg.outputDir);
  if (!existsSync(dir)) {
    return warn("output directory", "will be created on first run");
  }
  let count = 0;
  try {
    count = readdirSync(dir, { recursive: true }).filter(
      (f) => typeof f === "string" && f.endsWith(".md"),
    ).length;
  } catch {
    // unreadable dir — report it exists but couldn't be counted
    return warn("output directory", `${collapseHome(dir)} — not readable`);
  }
  return ok("output directory", `${count} note${count === 1 ? "" : "s"}`);
}

// ── 5. Claude Code sessions ───────────────────────────────────────────────────
function countJsonl(dir: string): number {
  let n = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) n += countJsonl(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) n += 1;
  }
  return n;
}

function checkSessions(cfg: Config): CheckResult {
  const dir = cfg.claudeProjectsDir;
  if (!existsSync(dir)) {
    return fail("Claude Code sessions", `${collapseHome(dir)} — directory not found`);
  }
  const n = countJsonl(dir);
  if (n === 0) return warn("Claude Code sessions", "no sessions found yet");
  return ok("Claude Code sessions", `${n} JSONL files found`);
}

// ── 5b. project decisions ─────────────────────────────────────────────────────
// Undecided projects are a spend decision with a DEADLINE: Claude Code prunes
// transcripts at ~30 days, so a session that pends long enough is gone before
// anyone decides. Exported + pure for tests.
export function pendingProjectsCheck(
  pendingSessions: number,
  pendingProjects: number,
  oldestPendingMtimeIso: string | null,
  now: number,
): CheckResult {
  if (pendingSessions === 0) {
    return ok("project decisions", "all projects decided");
  }
  let age = "";
  if (oldestPendingMtimeIso !== null) {
    const days = Math.floor(
      (now - Date.parse(oldestPendingMtimeIso)) / 86_400_000,
    );
    if (Number.isFinite(days) && days >= 0) {
      age = ` · oldest transcript ${days}d old`;
    }
  }
  return warn(
    "project decisions",
    `${pendingSessions} session(s) in ${pendingProjects} undecided project(s)${age} — Claude Code prunes transcripts at ~30 days, so undecided means lost; run vir projects`,
  );
}

// Informational: how many SDK-launched agent transcripts the filter has
// skipped, by entrypoint. Always ok — this is the filter working as
// configured, not a problem state.
export function agentTranscriptsCheck(
  byEntrypoint: Record<string, number>,
): CheckResult {
  const entries = Object.entries(byEntrypoint);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total === 0) return ok("agent transcripts", "none skipped");
  const eps = entries
    .sort((a, b) => b[1] - a[1])
    .map(([ep, n]) => `${ep} (${n})`)
    .join(", ");
  return ok("agent transcripts", `${total} skipped · entrypoints: ${eps}`);
}

function checkAgentTranscripts(): CheckResult {
  if (!existsSync(STATE_PATH)) return agentTranscriptsCheck({});
  let db: StateDb | null = null;
  try {
    db = new StateDb(STATE_PATH, { readonly: true });
    return agentTranscriptsCheck(db.countAgentEntrypoints());
  } catch (err) {
    return agentTranscriptsCheck({});
  } finally {
    db?.close();
  }
}

function checkPendingProjects(cfg: Config): CheckResult {
  try {
    const rows = gatherProjectsReport(cfg);
    const pendingRows = rows.filter((r) => r.pending > 0);
    const pendingSessions = pendingRows.reduce((s, r) => s + r.pending, 0);
    let oldest: string | null = null;
    for (const r of pendingRows) {
      for (const p of r.pendingPaths) {
        try {
          const iso = statSync(p).mtime.toISOString();
          if (oldest === null || iso < oldest) oldest = iso;
        } catch {
          // unreadable transcript — age just stays unknown
        }
      }
    }
    return pendingProjectsCheck(
      pendingSessions,
      pendingRows.length,
      oldest,
      Date.now(),
    );
  } catch (err) {
    return warn("project decisions", truncate((err as Error).message));
  }
}

// ── 6. sqlite database ────────────────────────────────────────────────────────
const EXPECTED_COLUMNS = [
  "path",
  "hash",
  "content",
  "category",
  "topic",
  "project",
  "confidence",
  "started_at",
  "embedding",
  "archived",
];

function checkDatabase(): CheckResult {
  if (!existsSync(STATE_PATH)) {
    return warn("sqlite database", "missing — will be created on first run");
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(STATE_PATH, { readonly: true, fileMustExist: true });
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;
    const names = new Set(cols.map((c) => c.name));
    if (names.size === 0) {
      return fail("sqlite database", "sessions table missing — run vir run");
    }
    const missing = EXPECTED_COLUMNS.filter((c) => !names.has(c));
    if (missing.length > 0) {
      return fail("sqlite database", `migration needed (missing: ${missing.join(", ")})`);
    }
    return ok("sqlite database", `${collapseHome(STATE_PATH)}`);
  } catch (err) {
    return fail("sqlite database", truncate((err as Error).message));
  } finally {
    db?.close();
  }
}

// ── 7. daemon ─────────────────────────────────────────────────────────────────
// Exported for tests. "Not installed" and "installed but down" demand
// different actions (install vs investigate), so they must not collapse into
// one verdict — and installed-but-inactive must never read ok.
export function daemonCheck(
  installed: boolean,
  active: boolean,
  method: string | null,
  cadenceHours: number | null,
  staleLabel: string | null = null,
): CheckResult {
  if (!installed) {
    return warn("daemon", "not installed — run vir schedule install");
  }
  // A pre-rename label is a real install (never "not installed") but needs
  // migration before it drifts from the shipped plist.
  if (staleLabel !== null) {
    return warn(
      "daemon",
      `running under old label ${staleLabel} — run vir schedule install to migrate`,
    );
  }
  const cadence = cadenceHours !== null ? ` · every ${cadenceHours}h` : "";
  if (!active) {
    return warn(
      "daemon",
      `installed but not running (${method ?? "unknown"}${cadence}) — check vir schedule status`,
    );
  }
  return ok("daemon", `${method ?? "unknown"} · active${cadence}`);
}

async function checkDaemon(cfg: Config | null): Promise<CheckResult> {
  const ds = await daemonStatus();
  return daemonCheck(
    ds.installed,
    ds.active,
    ds.method ?? null,
    ds.cadenceHours ?? cfg?.cadenceHours ?? null,
    ds.staleLabel,
  );
}

// ── 7b. backup freshness (only when a backup job is configured) ──────────────
// ~/.vir/backup.sh stamps ~/.vir/backup.last (ISO UTC) on every successful
// push. 354 distilled sessions exist ONLY in the DB (source transcripts aged
// out), so a silently-dead backup job is real data-loss exposure — warn past
// the threshold. Exported + parameterized for tests.
export const BACKUP_STALE_MS = 48 * 3600 * 1000;

export interface BackupState {
  configured: boolean;
  /** raw ~/.vir/backup.last — "<iso>" (legacy) or "<iso> manual|scheduled" */
  last: string | null;
  /** raw ~/.vir/backup.last.scheduled — written only by scheduled runs */
  lastScheduled: string | null;
  /** last "FAIL:" line from ~/.vir/backup.log, verbatim */
  lastFail: string | null;
}

// A stamp is "<iso>" or "<iso> <trigger>". Legacy bare-ISO stamps predate the
// trigger field and were overwhelmingly the nightly job — treating them as
// manual would false-warn every upgraded install until its next scheduled run.
function parseStamp(raw: string | null): { at: number; trigger: string } | null {
  if (raw === null) return null;
  const [iso, trigger = "scheduled"] = raw.trim().split(/\s+/);
  const at = Date.parse(iso ?? "");
  if (Number.isNaN(at)) return null;
  return { at, trigger };
}

// Timestamp of a backup.log line like "[<iso>] FAIL: sqlite dump".
function parseFailTime(line: string | null): number | null {
  const iso = line?.match(/^\[([^\]]+)\]/)?.[1];
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

// Only a SCHEDULED success within 48h reads healthy: a manual run proves the
// script works, not that the launchd job runs, so it must never silence the
// warning. And a FAIL that post-dates the last scheduled success is surfaced
// verbatim — a job that fails loudly every night into a log nobody reads is
// still a silent failure.
export function backupCheck(s: BackupState, now: number): CheckResult | null {
  // No backup job configured — not an error state, just not this install's
  // setup; emit no row rather than nag every vanilla install.
  if (!s.configured) return null;

  const last = parseStamp(s.last);
  const scheduled =
    parseStamp(s.lastScheduled) ??
    (last !== null && last.trigger !== "manual" ? last : null);
  const failNote = s.lastFail === null ? "" : `\nlast failure: ${s.lastFail}`;
  const manualNote =
    last !== null && last.trigger === "manual"
      ? `\nmanual run ${ageH(last.at, now)}h ago proves the script, not the job`
      : "";

  if (scheduled === null) {
    if (s.last !== null && last === null) {
      return warn("backup", "backup.last is unreadable — run ~/.vir/backup.sh");
    }
    return warn(
      "backup",
      `scheduled job has never succeeded — check ~/.vir/backup.log${manualNote}${failNote}`,
    );
  }
  if (now - scheduled.at > BACKUP_STALE_MS) {
    return warn(
      "backup",
      `last scheduled success ${ageH(scheduled.at, now)}h ago (> 48h) — check ~/.vir/backup.log${manualNote}${failNote}`,
    );
  }
  const failAt = parseFailTime(s.lastFail);
  if (failAt !== null && failAt > scheduled.at) {
    return warn(
      "backup",
      `a run failed after the last scheduled success${failNote}`,
    );
  }
  return ok("backup", `last scheduled success ${ageH(scheduled.at, now)}h ago`);
}

function ageH(at: number, now: number): number {
  return Math.round((now - at) / 3600000);
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function lastFailLine(logPath: string): string | null {
  try {
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line !== undefined && line.includes("FAIL: ")) return line.trim();
    }
  } catch {
    // no log yet
  }
  return null;
}

function checkBackup(): CheckResult | null {
  const virDir = join(homedir(), ".vir");
  return backupCheck(
    {
      configured: existsSync(join(virDir, "backup.sh")),
      last: readTrimmed(join(virDir, "backup.last")),
      lastScheduled: readTrimmed(join(virDir, "backup.last.scheduled")),
      lastFail: lastFailLine(join(virDir, "backup.log")),
    },
    Date.now(),
  );
}

// ── 8. Ollama (optional) ──────────────────────────────────────────────────────
// Exported for tests: pure mapping from (reachability, probe result) to a
// verdict. probedModel is the result of a one-shot embed("ping") — a daemon
// that answers /api/tags while embed() fails must NOT read healthy, because
// that state silently downgrades every query to TF-IDF.
export function ollamaCheck(
  reachable: boolean,
  probedModel: string | null,
): CheckResult {
  if (!reachable) {
    return warn(
      "Ollama",
      "not running — semantic search will use TF-IDF fallback\ninstall: brew install ollama",
    );
  }
  if (probedModel === null) {
    return warn(
      "Ollama",
      `reachable but the embedding probe failed — semantic search will use TF-IDF fallback\ncheck: ollama pull ${EMBED_MODEL}`,
    );
  }
  return ok("Ollama", `running · embedding probe ok (${probedModel})`);
}

async function checkOllama(): Promise<CheckResult> {
  const reachable = await isOllamaAvailable();
  return ollamaCheck(reachable, reachable ? await probeEmbedding() : null);
}

// ── 8b. embedding provider ────────────────────────────────────────────────────
// Pure so the states are unit-testable. Human table ONLY — never serialized
// into doctor --json (the 8-field VirDoctorResult is a cross-repo contract).
export function embeddingProviderCheck(
  providerName: "ollama" | "local" | "none",
  model: string | null,
  dim: number | null,
  mismatched: number,
): CheckResult {
  if (providerName === "none") {
    return warn(
      "embedding provider",
      "none — search is keyword-only (TF-IDF), a supported mode\n" +
        "semantic search: `vir embed --setup` (fastembed, ~233 MB + ~128 MB model, 384d)\n" +
        "or install Ollama + nomic-embed-text (768d)",
    );
  }
  if (mismatched > 0) {
    return warn(
      "embedding provider",
      `${providerName} · ${model} (${dim}d) — but ${mismatched} note(s) are embedded under a different model\n` +
        "that is an unfinished migration: they are excluded from vector search\n" +
        "finish it: `vir embed --force`",
    );
  }
  return ok(
    "embedding provider",
    `${providerName} · ${model} (${dim}d) · all embedded notes match`,
  );
}

async function checkEmbeddingProvider(
  cfg: Config | null,
): Promise<CheckResult> {
  const provider = await resolveEmbeddingProvider(cfg?.embeddingProvider);
  if (!provider) return embeddingProviderCheck("none", null, null, 0);
  let mismatched = 0;
  if (cfg) {
    try {
      const db = new StateDb();
      const root = join(expandHome(cfg.vaultPath), cfg.outputDir);
      const rows = [
        ...db.getEmbeddings(root),
        ...db.getArticleEmbeddings(),
        ...db.getTopicEmbeddings(root, cfg.topicsDir),
        ...db.getPdfEmbeddings(),
      ];
      mismatched = rows.filter(
        (r) => r.embeddingModel !== provider.modelName,
      ).length;
      db.close();
    } catch {
      // provenance count is best-effort; the provider report alone is useful
    }
  }
  return embeddingProviderCheck(
    provider.name,
    provider.modelName,
    provider.dimensions,
    mismatched,
  );
}

// ── 9. Claude Code CLI ────────────────────────────────────────────────────────
async function checkClaudeCli(): Promise<{ result: CheckResult; available: boolean }> {
  const available = await isClaudeAvailable();
  if (available) return { result: ok("Claude Code CLI", "found"), available };
  return {
    result: warn(
      "Claude Code CLI",
      "not found — vir mcp install won't work until you install Claude Code",
    ),
    available,
  };
}

// ── 10. MCP registration ──────────────────────────────────────────────────────
async function checkMcp(): Promise<CheckResult> {
  const registered = await isInstalled();
  return registered
    ? ok("MCP registration", "registered ✓")
    : warn("MCP registration", "not registered — run vir mcp install");
}

export async function runDoctor(): Promise<void> {
  ui.header("doctor");
  ui.blank();
  ui.divider();

  const results: CheckResult[] = [];
  const record = (r: CheckResult): void => {
    results.push(r);
    ui.statusRow(r.status, r.label, r.detail);
  };

  const { result: configResult, cfg } = checkConfig();
  record(configResult);

  if (cfg) {
    record(await checkApiKey(cfg));
    record(checkVaultPath(cfg));
    record(checkOutputDir(cfg));
    record(checkSessions(cfg));
    record(checkPendingProjects(cfg));
    record(checkAgentTranscripts());
  } else {
    for (const label of [
      "api key",
      "vault path",
      "output directory",
      "Claude Code sessions",
      "project decisions",
    ]) {
      record(fail(label, "skipped — fix config first"));
    }
  }

  record(checkDatabase());
  record(await checkDaemon(cfg));
  const backup = checkBackup();
  if (backup) record(backup);

  record(await checkOllama());
  record(await checkEmbeddingProvider(cfg));

  const claude = await checkClaudeCli();
  record(claude.result);
  // MCP registration is meaningless without the claude CLI — skip it entirely.
  if (claude.available) record(await checkMcp());

  ui.divider();

  const passed = results.filter((r) => r.status === "ok").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  const failed = results.filter((r) => r.status === "fail").length;

  const parts = [ui.success(`${passed} checks passed`)];
  if (warnings > 0) {
    parts.push(ui.warn(`${warnings} warning${warnings === 1 ? "" : "s"}`));
  }
  if (failed > 0) {
    parts.push(ui.errorColor(`${failed} failed`));
  }
  ui.line(parts.join(ui.dim(`  ${ui.BULLET}  `)));

  if (failed > 0) process.exitCode = 1;
}

// package.json sits one dir up from dist/doctor.js's parent — read it at runtime
// (rootDir is ./src, so it can't be imported) exactly like cli.ts does for
// --version. Resilient: any failure yields "unknown" rather than throwing.
function readVirVersion(): string {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "package.json",
    );
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string })
      .version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// The daemon writes a preflight line to ~/.vir/daemon.log on every pass, so its
// mtime is the truest "last poll" signal — distinct from the DB's last *distill*
// (most recent processed_at), which only advances when a session actually
// changed. Returns null when the daemon has never run.
function lastPollAt(): string | null {
  try {
    return existsSync(DAEMON_LOG_PATH)
      ? statSync(DAEMON_LOG_PATH).mtime.toISOString()
      : null;
  } catch {
    return null;
  }
}

function lastDistillAt(): string | null {
  if (!existsSync(STATE_PATH)) return null;
  let db: StateDb | null = null;
  try {
    db = new StateDb(STATE_PATH, { readonly: true });
    return db.stats().lastRun;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function dbSizeMb(): number {
  try {
    if (!existsSync(STATE_PATH)) return 0;
    return Math.round((statSync(STATE_PATH).size / 1_048_576) * 100) / 100;
  } catch {
    return 0;
  }
}

/**
 * `vir doctor --json` — emits a single VirDoctorResult object to stdout and
 * always exits 0; health is expressed in the `daemon` field, not the exit code.
 * Platform detection (launchd/systemd/cron) is abstracted inside daemonStatus;
 * the JSON output stays platform-agnostic.
 */
export async function runDoctorJson(): Promise<void> {
  const { cfg } = checkConfig();
  const ds = await daemonStatus();
  const ollamaReachable = await isOllamaAvailable();
  // The wire `model` is a probe result: the model id only when a one-shot
  // embed("ping") succeeded, else null — never the constant echoed back.
  const ollamaModel = ollamaReachable ? await probeEmbedding() : null;

  const result = buildDoctorResult({
    daemonInstalled: ds.installed,
    lastPollAt: lastPollAt(),
    lastDistillAt: lastDistillAt(),
    dbSizeMb: dbSizeMb(),
    vaultPath: cfg?.vaultPath ?? "",
    configValid: cfg !== null,
    ollamaReachable,
    ollamaModel,
    cadenceHours: cfg?.cadenceHours ?? 3,
    version: readVirVersion(),
  });

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

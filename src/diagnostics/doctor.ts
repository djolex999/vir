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
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  CONFIG_PATH,
  ConfigSchema,
  STATE_PATH,
  expandHome,
  type Config,
} from "../config.js";
import {
  callLLM,
  maybeAnthropicClient,
  normalizeModelName,
} from "../pipeline/distiller.js";
import { VaultWriter } from "../pipeline/writer.js";
import { status as daemonStatus } from "../daemon/index.js";
import { isOllamaAvailable } from "../search/embedder.js";
import { isClaudeAvailable, isInstalled } from "../mcp/install.js";
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
function checkOutputDir(cfg: Config): CheckResult {
  const dir = join(cfg.vaultPath, cfg.outputDir);
  if (existsSync(dir)) {
    let count = 0;
    try {
      count = new VaultWriter(cfg).noteCount();
    } catch {
      // fall through with 0
    }
    return ok("output directory", `${count} note${count === 1 ? "" : "s"}`);
  }
  // Doesn't exist yet — fine as long as the vault is writable (it'll be
  // created on first run). The vault-path check already verified writability.
  try {
    accessSync(cfg.vaultPath, constants.W_OK);
    return ok("output directory", "will be created on first run");
  } catch {
    return fail("output directory", `${collapseHome(dir)} — vault not writable`);
  }
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
async function checkDaemon(cfg: Config | null): Promise<CheckResult> {
  const ds = await daemonStatus();
  if (!ds.installed) {
    return warn("daemon", "not installed — run vir schedule install");
  }
  const cadence = ds.cadenceHours ?? cfg?.cadenceHours ?? null;
  const state = ds.active ? "active" : "inactive";
  const parts = [ds.method, state];
  if (cadence !== null) parts.push(`every ${cadence}h`);
  return ok("daemon", parts.join(" · "));
}

// ── 8. Ollama (optional) ──────────────────────────────────────────────────────
async function checkOllama(): Promise<CheckResult> {
  if (await isOllamaAvailable()) {
    return ok("Ollama", "running · semantic search enabled");
  }
  return warn(
    "Ollama",
    "not running — semantic search will use TF-IDF fallback\ninstall: brew install ollama",
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
  } else {
    for (const label of [
      "api key",
      "vault path",
      "output directory",
      "Claude Code sessions",
    ]) {
      record(fail(label, "skipped — fix config first"));
    }
  }

  record(checkDatabase());
  record(await checkDaemon(cfg));
  record(await checkOllama());

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

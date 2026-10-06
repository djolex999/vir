import confirm from "@inquirer/confirm";
import input from "@inquirer/input";
import select from "@inquirer/select";
import chalk from "chalk";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_PATH,
  maskSecret,
  ConfigSchema,
  configExists,
  ensureVirDir,
  expandHome,
  loadConfig,
  saveConfig,
  type Config,
} from "../config.js";
import { setupNotifications } from "./notificationsSetup.js";
import {
  categorizeTranscriptHead,
  estimateSessionCost,
  readTranscriptHead,
} from "../pipeline/projects.js";
import {
  buildSources,
  groupSessions,
  resolveSource,
  scanAll,
} from "../sources/registry.js";
import { promptProjectDecisions } from "./projectSelect.js";
import { normalizeModelName } from "../pipeline/distiller.js";
import { buildInitConfig } from "./initConfig.js";
import { defaultNotesDir } from "./notesDir.js";
import { installToClaudeCode } from "../mcp/install.js";
import * as ui from "../ui/display.js";

export async function cmdInit(): Promise<void> {
  ensureVirDir();
  const existing = configExists() ? safeLoad() : null;

  ui.header("init");
  ui.blank();

  // ── vault path ──────────────────────────────────────────────────────────
  let vaultPath = "";
  for (;;) {
    vaultPath = await input({
      message: "Notes folder (any folder of markdown — an Obsidian vault works too)",
      default: existing?.vaultPath ?? defaultNotesDir(homedir(), existsSync),
    });
    const expanded = expandHome(vaultPath);
    if (existsSync(expanded)) break;
    const create = await confirm({
      message: `Folder does not exist (${expanded}). Create it?`,
      default: true,
    });
    if (create) {
      try {
        mkdirSync(expanded, { recursive: true });
        break;
      } catch (err) {
        console.error(
          chalk.red(`failed to create: ${(err as Error).message}`),
        );
      }
    }
  }

  const outputDir = await input({
    message: "Output subfolder inside the notes folder",
    default: existing?.outputDir ?? "vir",
  });

  // ── claude projects dir ─────────────────────────────────────────────────
  let claudeProjectsDir = "";
  for (;;) {
    claudeProjectsDir = await input({
      message: "Claude Code projects dir",
      default:
        existing?.claudeProjectsDir ?? join(homedir(), ".claude", "projects"),
    });
    const expanded = expandHome(claudeProjectsDir);
    if (existsSync(expanded)) break;
    console.warn(
      chalk.yellow(
        "directory not found — Claude Code sessions may not exist yet",
      ),
    );
    const cont = await confirm({
      message: "continue anyway?",
      default: false,
    });
    if (cont) break;
  }

  // ── web articles (optional second input source) ─────────────────────────
  let articlesDir: string | undefined = existing?.articlesDir;
  const wantsArticles = await confirm({
    message:
      "Do you save web articles as markdown to a folder (e.g. a web clipper)?",
    default: existing?.articlesDir !== undefined,
  });
  if (wantsArticles) {
    for (;;) {
      articlesDir = await input({
        message: "Articles (raw/) directory",
        default: existing?.articlesDir ?? join(expandHome(vaultPath), "raw"),
      });
      const expanded = expandHome(articlesDir);
      if (existsSync(expanded)) break;
      const create = await confirm({
        message: `Path does not exist (${expanded}). Create it?`,
        default: true,
      });
      if (create) {
        try {
          mkdirSync(expanded, { recursive: true });
          break;
        } catch (err) {
          console.error(
            chalk.red(`failed to create: ${(err as Error).message}`),
          );
        }
      } else {
        break;
      }
    }
  } else {
    articlesDir = undefined;
  }

  // ── PDFs / papers (optional third input source) ──────────────────────────
  let pdfsDir: string | undefined = existing?.pdfsDir;
  const wantsPdfs = await confirm({
    message: "Do you keep PDFs / papers in a folder to ingest?",
    default: existing?.pdfsDir !== undefined,
  });
  if (wantsPdfs) {
    for (;;) {
      pdfsDir = await input({
        message: "PDFs directory",
        default: existing?.pdfsDir ?? join(homedir(), "Documents", "papers"),
      });
      const expanded = expandHome(pdfsDir);
      if (existsSync(expanded)) break;
      const create = await confirm({
        message: `Path does not exist (${expanded}). Create it?`,
        default: true,
      });
      if (create) {
        try {
          mkdirSync(expanded, { recursive: true });
          break;
        } catch (err) {
          console.error(
            chalk.red(`failed to create: ${(err as Error).message}`),
          );
        }
      } else {
        break;
      }
    }
  } else {
    pdfsDir = undefined;
  }

  const cadenceHours = Number(
    await input({
      message: "Cadence (hours)",
      default: String(existing?.cadenceHours ?? 3),
      validate: (v: string) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? true : "must be a positive number";
      },
    }),
  );

  // ── provider picker ─────────────────────────────────────────────────────
  const provider = (await select({
    message: "Provider",
    default: existing?.provider ?? "anthropic",
    choices: [
      {
        name: "Anthropic    (API key — predictable per-session cost, no effect on your Claude Code limits)",
        value: "anthropic" as const,
      },
      {
        name: "Claude Code  (subscription — free and keyless; distills consume your Claude Code usage limits)",
        value: "claude-cli" as const,
      },
      {
        name: "Kie.ai       (~72% cheaper API, third-party proxy — you trade reliability for cost)",
        value: "kie" as const,
      },
    ],
  })) as "anthropic" | "kie" | "claude-cli";

  // Secret prompt discipline: mask while typing, echo only a masked
  // confirmation (maskSecret), and NEVER render the existing key as the
  // visible inquirer default — that prints the full secret to the terminal
  // before a single keystroke. Empty input keeps the existing/env key.
  const promptSecret = async (
    message: string,
    keep: string | undefined,
    validate: (v: string) => true | string,
  ): Promise<string> => {
    const value = await input({
      message: keep
        ? `${message} (Enter keeps ${maskSecret(keep)})`
        : message,
      transformer: (v: string, { isFinal }: { isFinal: boolean }) =>
        isFinal ? maskSecret(v || keep || "") : "•".repeat(v.length),
      validate: (v: string) => (v === "" && keep ? true : validate(v)),
    });
    return value === "" && keep ? keep : value;
  };

  let anthropicApiKey: string | undefined;
  let kieApiKey: string | undefined;
  if (provider === "anthropic") {
    anthropicApiKey = await promptSecret(
      "Anthropic API key",
      existing?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? undefined,
      (v) => (v.startsWith("sk-ant-") ? true : "key should start with sk-ant-"),
    );
  } else if (provider === "kie") {
    kieApiKey = await promptSecret(
      "Kie.ai API key",
      existing?.kieApiKey ?? process.env.KIE_API_KEY ?? undefined,
      (v) => (v.length > 10 ? true : "enter a valid Kie.ai API key"),
    );
  }
  // claude-cli: no credential of any kind — it uses the `claude` login.

  // ── model pickers (provider-aware) ──────────────────────────────────────
  // claude-cli accepts the same full Anthropic model ids (and pins them per
  // invocation via --model), so it shares the anthropic id set.
  const classifyChoices =
    provider !== "kie"
      ? [
          {
            name: "claude-haiku-4-5-20251001  (recommended)",
            value: "claude-haiku-4-5-20251001",
          },
          { name: "claude-sonnet-4-6", value: "claude-sonnet-4-6" },
        ]
      : [
          {
            name: "claude-haiku-4-5  (recommended)",
            value: "claude-haiku-4-5",
          },
          { name: "claude-sonnet-4-6", value: "claude-sonnet-4-6" },
        ];
  const classifyModel = await select({
    message: "Classify model (fast pass)",
    choices: classifyChoices,
  });

  const distillChoices =
    provider !== "kie"
      ? [
          {
            name: "claude-sonnet-5  (recommended)",
            value: "claude-sonnet-5",
          },
          { name: "claude-sonnet-4-6", value: "claude-sonnet-4-6" },
          {
            name: "claude-haiku-4-5-20251001  (faster, cheaper)",
            value: "claude-haiku-4-5-20251001",
          },
        ]
      : [
          {
            name: "claude-sonnet-4-6  (recommended)",
            value: "claude-sonnet-4-6",
          },
          {
            name: "claude-haiku-4-5  (faster, cheaper)",
            value: "claude-haiku-4-5",
          },
        ];
  const distillModel = await select({
    message: "Distill model (deep extraction)",
    choices: distillChoices,
  });

  const filterThreshold = Number(
    await input({
      message: "Filter threshold (0..1)",
      default: String(existing?.filterThreshold ?? 0.4),
      validate: (v: string) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 && n <= 1
          ? true
          : "must be between 0 and 1";
      },
    }),
  );

  // ── project triage (the primary decision point) ─────────────────────────
  // Every project found under the Claude projects dir is shown once with its
  // session count and rough cost; selected = include, unselected = exclude.
  // Projects that appear later start undecided and trigger the run prompt.
  let projectDecisions: Record<string, "include" | "exclude"> = {};
  let agentTranscriptsAnswer: "exclude" | "include" | undefined;
  try {
    const projectsDirX = expandHome(claudeProjectsDir);
    const sources = buildSources({ claudeProjectsDir: projectsDirX });
    const allFound = scanAll(sources);
    // Triage counts + the agent-transcript question. Only top-level
    // transcripts count (nested workflow/sidechain have their own filter),
    // and agent transcripts are excluded from the per-project multi-select
    // numbers so the costs shown reflect what would actually distill.
    const topLevel = allFound.filter(
      (s) => resolveSource(sources, s.path).category(s.path) === "session",
    );
    const counts = { interactive: 0, agent: 0, stub: 0 };
    const agentPaths = new Set<string>();
    for (const s of topLevel) {
      const cat = categorizeTranscriptHead(readTranscriptHead(s.path), s.size);
      counts[cat] += 1;
      if (cat === "agent") agentPaths.add(s.path);
    }
    if (counts.agent > 0) {
      ui.blank();
      ui.line(
        ui.dim(
          `  ${counts.interactive} interactive · ${counts.agent} SDK-launched · ${counts.stub} stubs`,
        ),
      );
      agentTranscriptsAnswer = (await select({
        message:
          "SDK-launched agent transcripts (review/verify harness output) — distill them?",
        default: existing?.agentTranscripts ?? "exclude",
        choices: [
          {
            name: "Exclude  (recommended — agent-internal execution, not your decisions)",
            value: "exclude" as const,
          },
          { name: "Include  (distill them like any session)", value: "include" as const },
        ],
      })) as "exclude" | "include";
    }
    const found =
      agentTranscriptsAnswer !== "include"
        ? topLevel.filter((s) => !agentPaths.has(s.path))
        : topLevel;
    const groups = [...groupSessions(found, sources).values()];
    if (groups.length > 0) {
      const classifyId = normalizeModelName(classifyModel, provider);
      const distillId = normalizeModelName(distillModel, provider);
      const infos = groups
        .map((g) => ({
          name: g.name,
          sessionCount: g.sessions.length,
          totalBytes: g.totalBytes,
          estCost: g.sessions.reduce(
            (sum, s) =>
              sum +
              estimateSessionCost(provider, classifyId, distillId, s.size),
            0,
          ),
        }))
        .sort((a, b) => b.estCost - a.estCost);
      ui.blank();
      ui.line(
        ui.dim(
          "  Which projects should vir distill? Costs are rough upper bounds.",
        ),
      );
      projectDecisions = await promptProjectDecisions(
        infos,
        existing?.projects ?? {},
        "Projects to track",
      );
    }
  } catch (err) {
    console.warn(
      chalk.yellow(
        `project scan failed (${(err as Error).message}) — you can decide later with vir projects`,
      ),
    );
  }

  const parsed = ConfigSchema.safeParse(
    buildInitConfig(existing, {
      vaultPath,
      outputDir,
      claudeProjectsDir,
      cadenceHours,
      provider,
      anthropicApiKey,
      kieApiKey,
      filterThreshold,
      articlesDir,
      pdfsDir,
      classifyModel,
      distillModel,
      projects: projectDecisions,
      agentTranscripts: agentTranscriptsAnswer,
    }),
  );

  if (!parsed.success) {
    console.error(chalk.red("invalid config:"));
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  saveConfig(parsed.data);
  ui.blank();
  ui.row(ui.success(ui.CHECK), ui.text(`saved ${CONFIG_PATH}`));

  ui.blank();
  const wantsMcp = await confirm({
    message: "Register Vir with Claude Code now? (recommended)",
    default: true,
  });
  if (wantsMcp) {
    await installToClaudeCode("user");
  }

  if (process.platform === "darwin" && parsed.data.notifications) {
    ui.blank();
    setupNotifications({ test: false });
  }

  ui.blank();
  ui.line(ui.dim("next: `vir run` to test once, then `vir schedule install`"));
}

function safeLoad(): Config | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

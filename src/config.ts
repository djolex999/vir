import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const ConfigSchema = z
  .object({
    vaultPath: z.string().min(1),
    outputDir: z.string().min(1).default("vir"),
    claudeProjectsDir: z.string().min(1),
    cadenceHours: z.number().positive().default(4),
    provider: z.enum(["anthropic", "kie"]).default("anthropic"),
    anthropicApiKey: z.string().optional(),
    kieApiKey: z.string().optional(),
    filterThreshold: z.number().min(0).max(1).default(0.4),
    models: z
      .object({
        classify: z.string().default("claude-haiku-4-5-20251001"),
        distill: z.string().default("claude-sonnet-4-6"),
      })
      .default({
        classify: "claude-haiku-4-5-20251001",
        distill: "claude-sonnet-4-6",
      }),
  })
  .superRefine((val, ctx) => {
    if (val.provider === "anthropic" && !val.anthropicApiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anthropicApiKey"],
        message: "anthropicApiKey is required when provider is 'anthropic'",
      });
    }
    if (val.provider === "kie" && !val.kieApiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kieApiKey"],
        message: "kieApiKey is required when provider is 'kie'",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export const VIR_DIR = join(homedir(), ".vir");
export const CONFIG_PATH = join(VIR_DIR, "config.json");
export const STATE_PATH = join(VIR_DIR, "vir.db");
// One-shot migration: older builds used `state.db`. If only the old file
// exists, rename it on startup so the docs match reality. Never overwrites
// an existing `vir.db`.
export const LEGACY_STATE_PATH = join(VIR_DIR, "state.db");
export const DAEMON_LOG_PATH = join(VIR_DIR, "daemon.log");

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

export function ensureVirDir(): void {
  if (!existsSync(VIR_DIR)) mkdirSync(VIR_DIR, { recursive: true });
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Config not found at ${CONFIG_PATH}. Run \`vir init\` first.`,
    );
  }
  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parsed = ConfigSchema.parse(JSON.parse(raw));
  return {
    ...parsed,
    vaultPath: expandHome(parsed.vaultPath),
    claudeProjectsDir: expandHome(parsed.claudeProjectsDir),
  };
}

export function saveConfig(cfg: Config): void {
  ensureVirDir();
  if (!existsSync(dirname(CONFIG_PATH))) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

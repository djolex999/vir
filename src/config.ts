import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const ConfigSchema = z
  .object({
    vaultPath: z.string().min(1),
    outputDir: z.string().min(1).default("vir"),
    // Vault subdirectory (inside outputDir) for `vir compose` topic pages.
    // Existing configs without this field get "topics" via the default.
    topicsDir: z.string().min(1).default("topics"),
    claudeProjectsDir: z.string().min(1),
    cadenceHours: z.number().positive().default(3),
    provider: z.enum(["anthropic", "kie"]).default("anthropic"),
    anthropicApiKey: z.string().optional(),
    kieApiKey: z.string().optional(),
    // Kie top-up tier. High-tier top-ups grant +10% bonus credits, so effective
    // pricing is ~10% below posted — applied as a 0.9× multiplier at computeCost
    // (the posted rates in pricing.ts stay canonical for standard-tier users).
    // Backward-compatible: unset → "standard" → no change.
    kieTopUpTier: z.enum(["standard", "high"]).default("standard"),
    filterThreshold: z.number().min(0).max(1).default(0.4),
    // Path to the raw/ directory of web articles (e.g. Obsidian Web Clipper
    // output). Optional — when unset, article ingestion is skipped entirely
    // and existing session-only configs keep working unchanged.
    articlesDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to raw/ directory for web articles. Optional. If unset, article ingestion is disabled.",
      ),
    // Whether to distill articles alongside Claude Code sessions. Only takes
    // effect when articlesDir is set.
    distillArticles: z
      .boolean()
      .default(true)
      .describe(
        "Whether to distill articles in addition to Claude Code sessions.",
      ),
    // Path to a directory of PDFs / papers to ingest. Optional — when unset, PDF
    // ingestion is skipped entirely and existing configs keep working unchanged
    // (the third input source, mirroring articlesDir).
    pdfsDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to a directory of PDFs/papers. Optional. If unset, PDF ingestion is disabled.",
      ),
    // Whether to distill PDFs alongside sessions/articles. Only takes effect
    // when pdfsDir is set.
    distillPdfs: z
      .boolean()
      .default(true)
      .describe("Whether to distill PDFs in addition to sessions and articles."),
    // How aggressively large tool outputs are stripped before distillation.
    // Existing configs without this field get 'moderate' via the default.
    filterToolCalls: z
      .enum(["aggressive", "moderate", "off"])
      .default("moderate"),
    // MMR diversity weight for `vir query` / `vir_query` retrieval. Applied in
    // the embedding path only (TF-IDF is too sparse to benefit).
    retrievalDiversity: z
      .number()
      .min(0)
      .max(1)
      .default(0.3)
      .describe(
        "MMR diversity parameter. 0.0 = pure relevance, 1.0 = pure diversity. Default 0.3 favors relevance with moderate diversity.",
      ),
    models: z
      .object({
        classify: z.string().default("claude-haiku-4-5-20251001"),
        // The "smart" model — used for decision-heavy / large sessions under
        // hybrid routing, and for every session when distillFast is unset.
        distill: z.string().default("claude-sonnet-4-6"),
        // The cheap model for routine sessions. Hybrid routing is OFF until
        // this is set, so existing installs keep using `distill` unchanged.
        distillFast: z.string().min(1).optional(),
        // Input-token ceiling above which a session is forced to `distill`.
        // Optional — selectDistillModel falls back to 100_000 when unset.
        distillThreshold: z.number().positive().optional(),
      })
      .default({
        classify: "claude-haiku-4-5-20251001",
        distill: "claude-sonnet-4-6",
      }),
    // Per-provider, per-model price overrides ($/1M tokens). Optional and
    // partial — set only the rates you want to override; anything unset falls
    // back to the built-in DEFAULT_PRICING. Kie users especially: vir's Kie
    // defaults are approximate, so override here if `vir cost` looks off.
    pricing: z
      .object({
        anthropic: z
          .record(
            z.string(),
            z.object({
              inputPer1M: z.number().nonnegative().optional(),
              outputPer1M: z.number().nonnegative().optional(),
            }),
          )
          .optional(),
        kie: z
          .record(
            z.string(),
            z.object({
              inputPer1M: z.number().nonnegative().optional(),
              outputPer1M: z.number().nonnegative().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
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
  // The dir holds config.json with API keys — keep it owner-only.
  try {
    chmodSync(VIR_DIR, 0o700);
  } catch {
    // best-effort (e.g. exotic filesystems); never block on a chmod
  }
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
  // Migrate pre-0.3.5 installs whose config.json is group/world-readable —
  // it holds API keys, so tighten to 0600 silently. Best-effort.
  try {
    if (statSync(CONFIG_PATH).mode & 0o077) chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // ignore — a failed chmod must never block loading config
  }
  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parsed = ConfigSchema.parse(JSON.parse(raw));
  return {
    ...parsed,
    vaultPath: expandHome(parsed.vaultPath),
    claudeProjectsDir: expandHome(parsed.claudeProjectsDir),
    ...(parsed.articlesDir
      ? { articlesDir: expandHome(parsed.articlesDir) }
      : {}),
    ...(parsed.pdfsDir ? { pdfsDir: expandHome(parsed.pdfsDir) } : {}),
  };
}

export function saveConfig(cfg: Config): void {
  ensureVirDir();
  if (!existsSync(dirname(CONFIG_PATH))) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  // config.json contains API keys — owner read/write only.
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // best-effort; a failed chmod must not fail the save
  }
}

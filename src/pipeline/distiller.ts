import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type {
  Category,
  Classification,
  DistilledNote,
  ParsedSession,
} from "./types.js";

const CATEGORIES: Category[] = ["pattern", "gotcha", "decision", "tool"];

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

export function buildAnthropicClient(config: Config): Anthropic {
  return new Anthropic({ apiKey: config.anthropicApiKey ?? "" });
}

// Returns null on the Kie path — that path uses native fetch (callKie) and
// never touches the Anthropic SDK, so don't allocate a client there.
export function maybeAnthropicClient(config: Config): Anthropic | null {
  return config.provider === "kie" ? null : buildAnthropicClient(config);
}

// Canonical model IDs accepted by Kie's /claude/v1/messages endpoint.
// Anything that *starts with* one of these keys collapses to the bare ID,
// so a stray suffix in config (date stamp, accidental path fragment like
// "v1messages", etc.) can't corrupt the outgoing model string.
const KIE_CANONICAL_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6"] as const;

export function normalizeModelName(model: string, provider: string): string {
  if (provider !== "kie") return model;
  for (const canonical of KIE_CANONICAL_MODELS) {
    if (model.startsWith(canonical)) return canonical;
  }
  // Fallback: still strip a trailing -YYYYMMDD date suffix.
  return model.replace(/-\d{8}$/, "");
}

interface KieResponseBlock {
  type?: string;
  text?: string;
}
interface KieResponse {
  content?: KieResponseBlock[];
  error?: { message?: string };
}

async function callKie(opts: {
  apiKey: string;
  model: string;
  maxTokens: number;
  prompt: string;
}): Promise<string> {
  const response = await fetch("https://api.kie.ai/claude/v1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: [{ role: "user", content: opts.prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new HttpError(
      response.status,
      `Kie ${response.status}: ${body.slice(0, 500)}`,
    );
  }

  const data = (await response.json()) as KieResponse;
  const text = data.content?.[0]?.text ?? "";
  return text;
}

async function callAnthropic(opts: {
  client: Anthropic;
  model: string;
  maxTokens: number;
  prompt: string;
}): Promise<string> {
  const resp = await opts.client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: [{ role: "user", content: opts.prompt }],
  });
  const parts: string[] = [];
  for (const block of resp.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

export interface LlmCallOpts {
  prompt: string;
  model: string;
  maxTokens: number;
}

export async function callLLM(
  config: Config,
  client: Anthropic | null,
  opts: LlmCallOpts,
): Promise<string> {
  if (config.provider === "kie") {
    return callKie({
      apiKey: config.kieApiKey ?? "",
      model: opts.model,
      maxTokens: opts.maxTokens,
      prompt: opts.prompt,
    });
  }
  if (!client) {
    throw new Error(
      "Anthropic client is required for provider 'anthropic' but was null",
    );
  }
  return callAnthropic({
    client,
    model: opts.model,
    maxTokens: opts.maxTokens,
    prompt: opts.prompt,
  });
}

export class Distiller {
  private client: Anthropic | null;
  private cfg: Config;
  private classifyModel: string;
  private distillModel: string;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.client = maybeAnthropicClient(cfg);
    this.classifyModel = normalizeModelName(cfg.models.classify, cfg.provider);
    this.distillModel = normalizeModelName(cfg.models.distill, cfg.provider);
  }

  async classify(
    session: ParsedSession,
    scrubbedSummary: string,
  ): Promise<Classification> {
    const prompt = `Given this Claude Code session summary, output JSON only:
{ "category": "pattern" | "gotcha" | "decision" | "tool",
  "topic": string (2-4 words, kebab-friendly),
  "project": string,
  "confidence": number (0..1) }

Project slug from path: ${session.projectSlug}

Session:
${scrubbedSummary}`;

    const text = await withRateLimitRetry(() =>
      callLLM(this.cfg, this.client, {
        prompt,
        model: this.classifyModel,
        maxTokens: 400,
      }),
    );
    return parseClassification(text, session.projectSlug);
  }

  async distill(
    session: ParsedSession,
    scrubbedContent: string,
    cls: Classification,
  ): Promise<string> {
    const prompt = `Extract durable knowledge from this Claude Code session.

Output a markdown page with these sections (no preamble, start with '## Summary'):
- ## Summary (2-3 sentences)
- ## What Was Learned
- ## Context (project: ${cls.project}, category: ${cls.category}, date: ${session.startedAt ?? "unknown"})
- ## Related

Be concise. Only include information a future developer would reuse.
Omit implementation details that won't generalize.

Session:
${scrubbedContent}`;

    const text = await withRateLimitRetry(() =>
      callLLM(this.cfg, this.client, {
        prompt,
        model: this.distillModel,
        maxTokens: 1500,
      }),
    );
    return text.trim();
  }

  async run(
    session: ParsedSession,
    scrubbedSummary: string,
    scrubbedContent: string,
  ): Promise<DistilledNote | null> {
    const cls = await this.classify(session, scrubbedSummary);
    if (cls.confidence <= 0.6) return null;
    const md = await this.distill(session, scrubbedContent, cls);
    return { classification: cls, markdown: md };
  }
}

const RETRY_DELAYS_MS = [60_000, 120_000, 240_000];

// The Kie path (native fetch → HttpError) retries 429 plus transient 5xx.
// The Anthropic SDK already retries 5xx internally, so on that path we only
// add 429 on top — never double-retry its 5xx.
const KIE_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof HttpError) return KIE_RETRYABLE_STATUS.has(err.status);
  if (err instanceof Anthropic.APIError) return err.status === 429;
  const e = err as { status?: number; statusCode?: number };
  return e.status === 429 || e.statusCode === 429;
}

function statusOf(err: unknown): number | string {
  if (err && typeof err === "object") {
    const e = err as { status?: number; statusCode?: number };
    return e.status ?? e.statusCode ?? "?";
  }
  return "?";
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      const delay = RETRY_DELAYS_MS[attempt] ?? 240_000;
      console.warn(
        `[vir] retryable error (${statusOf(err)}) — retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${delay / 1000}s`,
      );
      await sleep(delay);
    }
  }
  return await fn();
}

function parseClassification(
  text: string,
  fallbackProject: string,
): Classification {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      category: "pattern",
      topic: "unknown",
      project: fallbackProject,
      confidence: 0,
    };
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return {
      category: "pattern",
      topic: "unknown",
      project: fallbackProject,
      confidence: 0,
    };
  }
  const rawCat = typeof obj.category === "string" ? obj.category : "pattern";
  const category: Category = (CATEGORIES as string[]).includes(rawCat)
    ? (rawCat as Category)
    : "pattern";
  const topic =
    typeof obj.topic === "string" && obj.topic.trim().length > 0
      ? obj.topic.trim()
      : "unknown";
  const project =
    typeof obj.project === "string" && obj.project.trim().length > 0
      ? obj.project.trim()
      : fallbackProject;
  const confidenceRaw =
    typeof obj.confidence === "number"
      ? obj.confidence
      : Number(obj.confidence ?? 0);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;
  return { category, topic, project, confidence };
}

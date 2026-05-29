import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import { computeCost } from "../cost/pricing.js";
import { appendCostRecord } from "../cost/log.js";
import type {
  Category,
  Classification,
  DistilledNote,
  ParsedSession,
} from "./types.js";

const CATEGORIES: Category[] = ["pattern", "gotcha", "decision", "tool"];

export class HttpError extends Error {
  status: number;
  // The `error.type` field from the upstream JSON body, when present. Used by
  // isRetryable to distinguish transient API errors (e.g. Kie's 404 with body
  // `{error: {type: "api_error"}}` — a service hiccup, retryable) from genuine
  // status-code-only failures (a 404 to a wrong endpoint, NOT retryable).
  errorType?: string;
  constructor(status: number, message: string, errorType?: string) {
    super(message);
    this.status = status;
    this.errorType = errorType;
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

// `--force-model haiku|sonnet` shorthand → full model id. We map to the dated
// Anthropic ids; normalizeModelName then collapses them for the Kie path. Any
// other value passes through (already a full id), so a full id still works.
export function resolveModelShorthand(model: string): string {
  if (model === "haiku") return "claude-haiku-4-5-20251001";
  if (model === "sonnet") return "claude-sonnet-4-6";
  return model;
}

// Default input-token ceiling above which a session is forced to the smart
// model regardless of category. A routing signal only — uses the chars/4
// heuristic, not real billing tokens.
const DEFAULT_DISTILL_THRESHOLD = 100_000;

// Hybrid routing: route routine/tool-heavy sessions to the cheap model
// (distillFast) and reserve the smart model (distill) for decision-heavy and
// large sessions, where Day-7 calibration showed Haiku misses higher-order
// judgment. Hybrid is OFF (returns distill for everything) until distillFast is
// set — so existing installs see no quality shift on upgrade. `--force-model`
// bypasses this function entirely (see Distiller.selectModelFor).
export function selectDistillModel(
  classification: Classification,
  inputTokens: number,
  models: { distill: string; distillFast?: string; distillThreshold?: number },
): string {
  if (!models.distillFast) return models.distill;
  if (classification.category === "decision") return models.distill;
  if (inputTokens > (models.distillThreshold ?? DEFAULT_DISTILL_THRESHOLD)) {
    return models.distill;
  }
  return models.distillFast;
}

interface KieResponseBlock {
  type?: string;
  text?: string;
}
interface KieResponse {
  content?: KieResponseBlock[];
  error?: { message?: string };
  // Kie reports failures as HTTP 200 with an in-body `code`/`msg` (e.g. 402
  // insufficient credits, 429 rate limit) rather than a non-2xx status.
  code?: number;
  msg?: string;
  // Anthropic-compatible usage — present on most Kie responses, but we never
  // depend on it: a missing usage block falls back to a chars/4 estimate.
  usage?: { input_tokens?: number; output_tokens?: number };
}

// Kie returns errors as HTTP 200 with an in-body error code, so `response.ok`
// can't catch them. Detect them here and surface as an HttpError, so the
// pipeline fails loudly (and 429 stays retryable) instead of silently
// distilling an empty note from `content: undefined`. Returns null on success.
export function kieResponseError(data: {
  code?: number;
  msg?: string;
  error?: { message?: string };
  content?: unknown;
}): HttpError | null {
  if (typeof data.code === "number" && data.code >= 400) {
    return new HttpError(data.code, `Kie ${data.code}: ${data.msg ?? "request failed"}`);
  }
  if (data.error?.message) {
    return new HttpError(502, `Kie error: ${data.error.message}`);
  }
  return null;
}

// Real token counts when the provider reports them; null forces a chars/4
// estimate downstream (the cost record then marks token_source: "estimated").
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

interface LlmResult {
  text: string;
  usage: TokenUsage | null;
}

function usageOf(input: unknown, output: unknown): TokenUsage | null {
  return typeof input === "number" && typeof output === "number"
    ? { input_tokens: input, output_tokens: output }
    : null;
}

async function callKie(opts: {
  apiKey: string;
  model: string;
  maxTokens: number;
  prompt: string;
}): Promise<LlmResult> {
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
    // Parse the body so callers (isRetryable) can tell apart a transient Kie
    // service hiccup (body carries `{error: {type: "api_error"}}`) from a
    // genuine misroute (no api_error envelope). JSON.parse failures fall
    // through harmlessly — `errorType` stays undefined and the existing
    // status-code-only retry logic applies.
    let errorType: string | undefined;
    try {
      const parsed = JSON.parse(body) as { error?: { type?: string } };
      if (typeof parsed.error?.type === "string") errorType = parsed.error.type;
    } catch {
      // body wasn't JSON
    }
    throw new HttpError(
      response.status,
      `Kie ${response.status}: ${body.slice(0, 500)}`,
      errorType,
    );
  }

  const data = (await response.json()) as KieResponse;
  const inBodyError = kieResponseError(data);
  if (inBodyError) throw inBodyError;
  const text = data.content?.[0]?.text ?? "";
  return { text, usage: usageOf(data.usage?.input_tokens, data.usage?.output_tokens) };
}

async function callAnthropic(opts: {
  client: Anthropic;
  model: string;
  maxTokens: number;
  prompt: string;
}): Promise<LlmResult> {
  const resp = await opts.client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: [{ role: "user", content: opts.prompt }],
  });
  const parts: string[] = [];
  for (const block of resp.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return {
    text: parts.join("\n"),
    usage: usageOf(resp.usage.input_tokens, resp.usage.output_tokens),
  };
}

// Optional cost-attribution context. When present, callLLM emits one cost.log
// record for the (successful) call; when absent — e.g. the doctor key-probe —
// nothing is recorded.
export interface CostContext {
  session?: string | null;
  project?: string | null;
  stage: string;
}

export interface LlmCallOpts {
  prompt: string;
  model: string;
  maxTokens: number;
  cost?: CostContext;
}

// Reporting heuristic only — never used for billing. ~4 chars per token.
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// Best-effort: a cost-log failure must never fail a distill. Real usage when the
// provider reported it, else a chars/4 estimate of prompt + response.
function recordCost(
  config: Config,
  opts: LlmCallOpts,
  result: LlmResult,
): void {
  if (!opts.cost) return;
  try {
    const real = result.usage;
    const inputTokens = real ? real.input_tokens : estimateTokens(opts.prompt);
    const outputTokens = real
      ? real.output_tokens
      : estimateTokens(result.text);
    appendCostRecord({
      ts: new Date().toISOString(),
      session: opts.cost.session ?? null,
      project: opts.cost.project ?? null,
      stage: opts.cost.stage,
      model: opts.model,
      provider: config.provider,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      token_source: real ? "real" : "estimated",
      estimated_cost_usd: computeCost(
        config.provider,
        opts.model,
        inputTokens,
        outputTokens,
        config.pricing,
      ),
    });
  } catch {
    // swallow — cost telemetry is never allowed to break the pipeline
  }
}

export async function callLLM(
  config: Config,
  client: Anthropic | null,
  opts: LlmCallOpts,
): Promise<string> {
  let result: LlmResult;
  if (config.provider === "kie") {
    result = await callKie({
      apiKey: config.kieApiKey ?? "",
      model: opts.model,
      maxTokens: opts.maxTokens,
      prompt: opts.prompt,
    });
  } else {
    if (!client) {
      throw new Error(
        "Anthropic client is required for provider 'anthropic' but was null",
      );
    }
    result = await callAnthropic({
      client,
      model: opts.model,
      maxTokens: opts.maxTokens,
      prompt: opts.prompt,
    });
  }
  recordCost(config, opts, result);
  return result.text;
}

export class Distiller {
  private client: Anthropic | null;
  private cfg: Config;
  private classifyModel: string;
  private distillModel: string;
  // When set, --force-model wins over hybrid routing — every session uses
  // distillModel and selectDistillModel is never consulted.
  private forced: boolean;

  constructor(cfg: Config, opts: { forceDistillModel?: string } = {}) {
    this.cfg = cfg;
    this.client = maybeAnthropicClient(cfg);
    this.classifyModel = normalizeModelName(cfg.models.classify, cfg.provider);
    // --force-model overrides only the distill model, for this run only.
    this.forced = opts.forceDistillModel != null;
    const distill = resolveModelShorthand(
      opts.forceDistillModel ?? cfg.models.distill,
    );
    this.distillModel = normalizeModelName(distill, cfg.provider);
  }

  // Resolve the distill model for one session. --force-model short-circuits
  // hybrid routing entirely; otherwise selectDistillModel decides from category
  // + input size, and the result is normalized for the provider.
  private modelFor(cls: Classification, inputTokens: number): string {
    if (this.forced) return this.distillModel;
    const selected = selectDistillModel(cls, inputTokens, this.cfg.models);
    return normalizeModelName(
      resolveModelShorthand(selected),
      this.cfg.provider,
    );
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
        cost: {
          session: session.sessionId,
          // classify runs before classification, so the only project name it
          // has is the raw dir slug. Leave it null and let distill's clean
          // cls.project be the label buildReport keeps for the session.
          project: null,
          stage: "classify",
        },
      }),
    );
    return parseClassification(text, session.projectSlug);
  }

  async distill(
    session: ParsedSession,
    scrubbedContent: string,
    cls: Classification,
    model: string = this.distillModel,
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
        model,
        maxTokens: 1500,
        cost: {
          session: session.sessionId,
          project: cls.project,
          stage: "distill",
        },
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
    // Hybrid routing decides here, after classify, on the post-filter distill
    // input. The chosen model flows into callLLM and lands in cost.log.
    const model = this.modelFor(cls, estimateTokens(scrubbedContent));
    const md = await this.distill(session, scrubbedContent, cls, model);
    return { classification: cls, markdown: md };
  }
}

// One delay per *retry*. Total attempts = 1 initial + 3 retries = 4: the loop
// below tries-then-sleeps once per entry (3 tries, 3 backoffs), then makes a
// final 4th attempt after the last sleep. Backoff schedule: 60s / 120s / 240s.
const RETRY_DELAYS_MS = [60_000, 120_000, 240_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

// The Kie path (native fetch → HttpError) retries 429 plus transient 5xx.
// The Anthropic SDK already retries 5xx internally, so on that path we only
// add 429 on top — never double-retry its 5xx.
const KIE_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof HttpError) {
    if (KIE_RETRYABLE_STATUS.has(err.status)) return true;
    // Kie occasionally returns 404 with body `{error: {type: "api_error"}}`
    // during transient service issues — distinct from a genuine 404 (wrong
    // endpoint, no api_error envelope), which stays a hard failure.
    if (err.status === 404 && err.errorType === "api_error") return true;
    return false;
  }
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
        `[vir] retryable error (${statusOf(err)}) — attempt ${attempt + 1}/${MAX_ATTEMPTS} failed, retrying in ${delay / 1000}s`,
      );
      await sleep(delay);
    }
  }
  // Final (4th) attempt after the last backoff — let its error propagate.
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

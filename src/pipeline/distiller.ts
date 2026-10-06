import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import {
  ClaudeCliError,
  callClaudeCli,
} from "./claudeCli.js";
import { computeCost, resolvePricing } from "../cost/pricing.js";
import { appendCostRecord } from "../cost/log.js";
import type {
  Category,
  Classification,
  DistilledNote,
  ParsedSession,
} from "./types.js";
import { callCodexCli, CodexCliError } from "./codexCli.js";
import { isSubscriptionProvider, SubscriptionLimitError } from "./subscription.js";

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

// Native `fetch` has no default timeout — a stalled Kie connection would hang
// the daemon indefinitely. callKie wraps every request in an AbortController
// that fires after this window (distill calls are slow, so it's generous).
const KIE_TIMEOUT_MS = 120_000;

// Thrown when callKie's AbortController trips. A stalled connection is
// transient — same family as a 5xx — so isRetryable treats it as retryable
// and withRateLimitRetry backs off and retries.
export class KieTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Kie request timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
    this.name = "KieTimeoutError";
  }
}

export function buildAnthropicClient(config: Config): Anthropic {
  return new Anthropic({ apiKey: config.anthropicApiKey ?? "" });
}

// Returns null on the Kie and CLI paths — Kie uses native fetch
// (callKie) and claude-cli/codex-cli spawn a binary; none touches the
// Anthropic SDK, so don't allocate a client (the CLIs have no key at all).
export function maybeAnthropicClient(config: Config): Anthropic | null {
  return config.provider === "anthropic" ? buildAnthropicClient(config) : null;
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
// bypasses this function entirely (see Distiller.modelFor).
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

// `fetchImpl`/`timeoutMs` are injectable for tests only — production callers
// (callLLM) pass neither and get the global fetch + KIE_TIMEOUT_MS.
export async function callKie(opts: {
  apiKey: string;
  model: string;
  maxTokens: number;
  prompt: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<LlmResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? KIE_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let response: Response;
  try {
    response = await doFetch("https://api.kie.ai/claude/v1/messages", {
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
      signal: ac.signal,
    });
  } catch (err) {
    // The AbortController fired — surface a typed, retryable timeout rather
    // than a raw AbortError, which isRetryable wouldn't recognize. A genuine
    // network error (signal not aborted) propagates unchanged.
    if (ac.signal.aborted) throw new KieTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }

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

// claude-cli distills cost zero DOLLARS and some subscription quota, and an
// unpriced model's cost is unknown — both are recorded as null, never $0.00,
// so dollar aggregates in `vir cost` stay honest. Exported for tests.
export function costForRecord(
  provider: Config["provider"],
  model: string,
  inputTokens: number,
  outputTokens: number,
  overrides: Config["pricing"],
  tier: Config["kieTopUpTier"],
): number | null {
  if (isSubscriptionProvider(provider)) return null;
  // No price for this model on this provider (e.g. claude-sonnet-5 on Kie):
  // unknown, never $0, or `vir cost` silently under-reports real spend.
  if (resolvePricing(provider, model, overrides, tier) === null) return null;
  return computeCost(provider, model, inputTokens, outputTokens, overrides, tier);
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
      estimated_cost_usd: costForRecord(
        config.provider,
        opts.model,
        inputTokens,
        outputTokens,
        config.pricing,
        config.kieTopUpTier,
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
  if (config.provider === "claude-cli") {
    const cli = await callClaudeCli({ prompt: opts.prompt, model: opts.model });
    result = { text: cli.text, usage: cli.usage };
  } else if (config.provider === "codex-cli") {
    result = await callCodexCli({ prompt: opts.prompt, model: opts.model });
  } else if (config.provider === "kie") {
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

// One cheap reachability probe before a distill loop starts: a tiny classify-
// model call with a hard timeout. No opts.cost context, so nothing lands in
// cost.log. A failure here means the provider is down NOW — bail with one
// clear error instead of entering the loop and burning N per-session retry
// chains (and attempt-counter increments) on the same outage.
const PROBE_TIMEOUT_MS = 15_000;

export async function probeProvider(
  config: Config,
  client: Anthropic | null,
): Promise<void> {
  const probe = callLLM(config, client, {
    prompt: "ping",
    model: normalizeModelName(config.models.classify, config.provider),
    maxTokens: 5,
  });
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(
      () => reject(new Error(`no response within ${PROBE_TIMEOUT_MS / 1000}s`)),
      PROBE_TIMEOUT_MS,
    );
    // Both branches handled: `probe.finally(...)` alone returned a promise
    // that re-rejected with nobody listening, and Node 20 kills the process
    // on an unhandled rejection right after run.ts has handled the outage.
    probe.then(
      () => clearTimeout(t),
      () => clearTimeout(t),
    );
  });
  await Promise.race([probe, timeout]);
}

// The model's classify response could not be parsed. Thrown rather than
// folded into a confidence-0 verdict, because run.ts treats the two
// oppositely: a thrown error goes through recordError (skipped = 0, error set,
// attempts + 1) so `vir reconcile` retries it and MAX_DISTILL_ATTEMPTS bounds
// the spend, while a low-confidence verdict is recorded as skipped and never
// looked at again. One transient formatting glitch used to take the second
// path and drop the session's knowledge permanently.
export class ClassifyParseError extends Error {
  constructor(sessionId: string) {
    super(
      `classify response for ${sessionId} could not be parsed — retryable, not a verdict`,
    );
    this.name = "ClassifyParseError";
  }
}

// The distill prompt as one pure function, so the text has exactly one home
// and an experiment can swap it without touching routing, retry, or cost
// logging. Production never passes a builder; the eval harness does.
export type DistillPromptBuilder = (
  session: ParsedSession,
  cls: Classification,
  scrubbedContent: string,
) => string;

export function buildDistillPrompt(
  session: ParsedSession,
  cls: Classification,
  scrubbedContent: string,
): string {
  // Orient, then claim (2026-09-18 blind A/B, eval/distill/COMBINED.md — the
  // text below is pinned to that file by eval/distill/prompts.test.ts). The
  // first Summary sentence is for the human skimming a month later; the second
  // is for a retrieving session, which wants state and specifics first. The
  // "not replying" line exists because a longer prompt once made Haiku echo
  // the session's closing chat message instead of writing a note.
  return `Extract durable knowledge from this Claude Code session.

Output a markdown page with these sections (no preamble, start with '## Summary'):
- ## Summary (2-3 sentences)
- ## What Was Learned
- ## Context (project: ${cls.project}, category: ${cls.category}, date: ${session.startedAt ?? "unknown"})

You are writing a page about the session, not replying to it. Never continue
the conversation, whatever language it ends in.

Summary, first sentence: say in plain words what this session was — which
project, what was being built or investigated. One sentence, so the reader
remembers the session.
Summary, second sentence: state the single most important thing the session
established, with its specifics: the file, function, command, number or
constraint that carries it. A third sentence only if something else must not
be forgotten.

What Was Learned: bullets, most important first. Each bullet is a claim tied
to something concrete from this session. For anything that was decided, say
what was chosen and what it was chosen over.

Context: one or two sentences on the situation that produced these lessons.
Do not repeat the project, category, or date.

Be concise. Leave out anything that would be equally true of any other
project, and anything only true on the day of the session.

Session:
${scrubbedContent}`;
}

// Classify names the session from its raw summary, before the note exists, and
// on the 09-18 prompt 10 of 25 titles no longer matched the note they headed.
// Naming the finished note instead won a blind judge 23-2 on those 25
// (2026-09-25 vault audit). A variant adding "in English" and "name the
// specific thing" tied this text 13-12 and drifted onto side bullets, so it was
// not kept. Pure, so the text has one home.
export function buildTitlePrompt(markdown: string): string {
  return `Name this note. Output the title only: 2-5 words, kebab-friendly, no quotes.

The title names the note's single most important claim — normally what the
Summary's second sentence states — so a reader who sees only the title knows
what the note is about. Not a summary of everything it covers, and not a
slogan.

Note:
${markdown}`;
}

// A title is a short phrase. Anything else (an empty reply, a sentence, a
// refusal) is unusable and the caller keeps classify's topic.
const MAX_TITLE_WORDS = 8;
const MAX_TITLE_CHARS = 80;

export function parseTitle(text: string): string | null {
  const first = text.trim().split("\n")[0] ?? "";
  const title = first
    .replace(/^#+\s*/, "")
    .replace(/^title:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (title.length === 0 || title.length > MAX_TITLE_CHARS) return null;
  if (title.split(/[\s-]+/).length > MAX_TITLE_WORDS) return null;
  return title;
}

export class Distiller {
  private client: Anthropic | null;
  private cfg: Config;
  private classifyModel: string;
  private distillModel: string;
  // When set, --force-model wins over hybrid routing — every session uses
  // distillModel and selectDistillModel is never consulted.
  private forced: boolean;
  private distillPrompt: DistillPromptBuilder;

  constructor(
    cfg: Config,
    opts: { forceDistillModel?: string; distillPrompt?: DistillPromptBuilder } = {},
  ) {
    this.cfg = cfg;
    this.distillPrompt = opts.distillPrompt ?? buildDistillPrompt;
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
  "topic": string (2-5 words, kebab-friendly: name the SINGLE most durable or
    surprising lesson, NOT a summary of everything the session touched),
  "themes": string[] (the distinct topics/threads the session covered, as short
    labels; [] when it is genuinely single-theme),
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
    const prompt = this.distillPrompt(session, cls, scrubbedContent);

    const text = await withRateLimitRetry(() =>
      callLLM(this.cfg, this.client, {
        prompt,
        model,
        // 2500, not 1500: notes under this prompt average ~540 words and the
        // old cap cut 550-590-word notes mid-sentence on the API path.
        maxTokens: 2500,
        cost: {
          session: session.sessionId,
          project: cls.project,
          stage: "distill",
        },
      }),
    );
    return text.trim();
  }

  // One cheap classify-model call over the finished note. Null means the reply
  // was not a usable title.
  async retitle(
    session: ParsedSession,
    markdown: string,
    cls: Classification,
  ): Promise<string | null> {
    const text = await withRateLimitRetry(() =>
      callLLM(this.cfg, this.client, {
        prompt: buildTitlePrompt(markdown),
        model: this.classifyModel,
        maxTokens: 40,
        cost: {
          session: session.sessionId,
          project: cls.project,
          stage: "retitle",
        },
      }),
    );
    return parseTitle(text);
  }

  // The distill has already been paid for, so a failed naming call keeps
  // classify's topic rather than discarding the note. A subscription limit is
  // the exception: the run loop has to see it and halt.
  private async titleFor(
    session: ParsedSession,
    markdown: string,
    cls: Classification,
  ): Promise<string> {
    try {
      return (await this.retitle(session, markdown, cls)) ?? cls.topic;
    } catch (err) {
      if (err instanceof SubscriptionLimitError) throw err;
      console.warn(
        `[vir] retitle failed for ${session.sessionId.slice(0, 8)}, keeping classify topic: ${(err as Error).message}`,
      );
      return cls.topic;
    }
  }

  async run(
    session: ParsedSession,
    scrubbedSummary: string,
    scrubbedContent: string,
  ): Promise<DistilledNote | null> {
    const cls = await this.classify(session, scrubbedSummary);
    if (cls.unparsed) throw new ClassifyParseError(session.sessionId);
    if (cls.confidence <= 0.6) return null;
    // Hybrid routing decides here, after classify, on the post-filter distill
    // input. The chosen model flows into callLLM and lands in cost.log.
    const model = this.modelFor(cls, estimateTokens(scrubbedContent));
    const md = await this.distill(session, scrubbedContent, cls, model);
    const topic = await this.titleFor(session, md, cls);
    return { classification: { ...cls, topic }, markdown: md };
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
  // A subscription limit is a wall that persists for HOURS — the opposite of
  // a transient 429. Retrying burns quota against a closed door; the run loop
  // halts on it instead. Ordinary claude-cli failures also stay non-retryable
  // (fail safe: a limit the docs-sourced regex misclassified must never enter
  // a retry chain).
  if (err instanceof SubscriptionLimitError) return false;
  if (err instanceof ClaudeCliError) return false;
  if (err instanceof CodexCliError) return false;
  // A client-side timeout is a transient stall, same family as a 5xx.
  if (err instanceof KieTimeoutError) return true;
  // Node's fetch (undici) surfaces network-level failures (ECONNREFUSED,
  // ENOTFOUND, socket resets) as a TypeError with the underlying error
  // attached as `cause`. Match that structure, never the "fetch failed"
  // message — the text is not contractual across Node versions or locales.
  // A programming TypeError carries no cause and stays non-retryable. Only
  // the Kie path uses native fetch; the Anthropic SDK wraps its own
  // connection errors, so this branch cannot over-retry that path.
  if (err instanceof TypeError) {
    const cause = (err as { cause?: unknown }).cause;
    return typeof cause === "object" && cause !== null;
  }
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

// Coerce the raw `themes` field into a clean string[]: keep only strings, trim,
// drop empties. Anything non-array (absent, string, object) yields [] — themes
// is a best-effort diagnostic signal, never worth failing a parse over.
function parseThemes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function parseClassification(
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
      themes: [],
      unparsed: true,
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
      themes: [],
      unparsed: true,
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
  return { category, topic, project, confidence, themes: parseThemes(obj.themes) };
}

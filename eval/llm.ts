import { appendCostRecord } from "../src/cost/log.js";
import { callClaudeCli } from "../src/pipeline/claudeCli.js";

export const EVAL_MODEL = "claude-sonnet-5";

// Every harness LLM call goes through the production claude-cli path (real
// HOME, real auth) and lands in ~/.vir/cost.log under an `eval-*` stage with
// `estimated_cost_usd: null` — the subscription-quota convention from 0.17.0.
export async function callJudge(
  stage:
    | "eval-label"
    | "eval-query-gen"
    | "eval-distill-judge"
    | "eval-usefulness-mine"
    | "eval-usefulness-grade"
    | "eval-usefulness-probe",
  prompt: string,
  session: string,
  model: string = EVAL_MODEL,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const res = await callClaudeCli({ prompt, model });
  // Input is always the chars/4 estimate: the claude -p envelope reports the
  // prompt-cache tokens in separate fields that parseCliEnvelope drops, so its
  // `input_tokens` is ~2 for a 3k-token prompt (todo.md, 2026-09-12). Output
  // is not cached and comes back real.
  const inputTokens = Math.ceil(prompt.length / 4);
  const outputTokens = res.usage?.output_tokens ?? Math.ceil(res.text.length / 4);
  appendCostRecord({
    ts: new Date().toISOString(),
    session,
    project: "eval",
    stage,
    model,
    provider: "claude-cli",
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    token_source: "estimated",
    estimated_cost_usd: null,
  });
  return { text: res.text, inputTokens, outputTokens };
}

// Bounded concurrency without a dependency.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

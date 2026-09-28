import type { Config } from "../config.js";
import {
  maybeAnthropicClient,
  callLLM,
  normalizeModelName,
  withRateLimitRetry,
} from "../pipeline/distiller.js";
import type { SearchHit } from "./retriever.js";

// Extracted so the eval harness can key an answer cache entry on the exact
// prompt text synthesize() sends (spec §8: key by stage, model, prompt).
export function buildSynthesisPrompt(query: string, hits: SearchHit[]): string {
  const notes = hits
    .map(
      (h) =>
        `### ${h.title} (score: ${h.score})\n${h.content.trim()}`,
    )
    .join("\n\n---\n\n");

  return `You are searching a personal knowledge base of distilled Claude Code session notes. Answer the query directly and concisely using only the provided notes as source.

Query: ${query}

Notes:
${notes}

Instructions:
- Answer directly, 3-5 sentences max
- Quote the specific note title when citing
- If notes don't contain relevant info, say so clearly
- Do not invent information not present in the notes`;
}

export async function synthesize(
  cfg: Config,
  query: string,
  hits: SearchHit[],
  stage: string = "query-synthesis",
): Promise<string> {
  const prompt = buildSynthesisPrompt(query, hits);
  const client = maybeAnthropicClient(cfg);
  const model = normalizeModelName(cfg.models.distill, cfg.provider);

  return withRateLimitRetry(() =>
    callLLM(cfg, client, {
      prompt,
      model,
      maxTokens: 600,
      cost: { stage },
    }),
  );
}

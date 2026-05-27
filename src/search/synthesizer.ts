import type { Config } from "../config.js";
import {
  maybeAnthropicClient,
  callLLM,
  normalizeModelName,
  withRateLimitRetry,
} from "../pipeline/distiller.js";
import type { SearchHit } from "./retriever.js";

export async function synthesize(
  cfg: Config,
  query: string,
  hits: SearchHit[],
): Promise<string> {
  const notes = hits
    .map(
      (h) =>
        `### ${h.title} (score: ${h.score})\n${h.content.trim()}`,
    )
    .join("\n\n---\n\n");

  const prompt = `You are searching a personal knowledge base of distilled Claude Code session notes. Answer the query directly and concisely using only the provided notes as source.

Query: ${query}

Notes:
${notes}

Instructions:
- Answer directly, 3-5 sentences max
- Quote the specific note title when citing
- If notes don't contain relevant info, say so clearly
- Do not invent information not present in the notes`;

  const client = maybeAnthropicClient(cfg);
  const model = normalizeModelName(cfg.models.distill, cfg.provider);

  return withRateLimitRetry(() =>
    callLLM(cfg, client, {
      prompt,
      model,
      maxTokens: 600,
      cost: { stage: "query-synthesis" },
    }),
  );
}

import type { Config } from "../config.js";
import {
  maybeAnthropicClient,
  callLLM,
  normalizeModelName,
  withRateLimitRetry,
} from "../pipeline/distiller.js";
import type { NoteStatus } from "./noteStatus.js";
import type { SearchHit } from "./retriever.js";

// Statuses shown to the synthesizer. "unchecked" is left off, so a prompt
// whose hits were never checked stays byte-identical to before (the eval
// harness caches answers by prompt text).
const SHOWN: Partial<Record<NoteStatus, string>> = {
  verified: "verified by the user",
  "transcript-supported": "matches its session transcript",
  unbacked: "some claims not found in its session transcript",
  contradicted: "CONTRADICTED by its session transcript",
};

// Extracted so the eval harness can key an answer cache entry on the exact
// prompt text synthesize() sends (spec §8: key by stage, model, prompt).
export function buildSynthesisPrompt(
  query: string,
  hits: SearchHit[],
  statusOf?: (hit: SearchHit) => NoteStatus,
): string {
  let flagged = false;
  const notes = hits
    .map((h) => {
      const st = statusOf?.(h);
      const shown = st === undefined ? undefined : SHOWN[st];
      if (st === "contradicted" || st === "unbacked") flagged = true;
      const status = shown === undefined ? "" : `, ${shown}`;
      return `### ${h.title} (score: ${h.score}${status})\n${h.content.trim()}`;
    })
    .join("\n\n---\n\n");
  const caution = flagged
    ? "\n- A note marked CONTRADICTED disagrees with the session it was written from: do not state its claims as fact; if you use it, say it is unreliable. Treat claims in a note marked \"not found in its session transcript\" as unconfirmed."
    : "";

  return `You are searching a personal knowledge base of distilled Claude Code session notes. Answer the query directly and concisely using only the provided notes as source.

Query: ${query}

Notes:
${notes}

Instructions:
- Answer directly, 3-5 sentences max
- Quote the specific note title when citing
- If notes don't contain relevant info, say so clearly
- Do not invent information not present in the notes${caution}`;
}

export async function synthesize(
  cfg: Config,
  query: string,
  hits: SearchHit[],
  stage: string = "query-synthesis",
  statusOf?: (hit: SearchHit) => NoteStatus,
): Promise<string> {
  const prompt = buildSynthesisPrompt(query, hits, statusOf);
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

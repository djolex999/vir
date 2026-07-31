import type { EmbeddingProvenance } from "../state/db.js";

// OLLAMA_HOST is Ollama's own standard override; honoring it also lets tests
// and fresh-install simulations point detection at a dead port.
const OLLAMA_BASE = (
  process.env["OLLAMA_HOST"] ?? "http://localhost:11434"
).replace(/\/$/, "");
export const EMBED_MODEL = "nomic-embed-text";
export const EMBED_DIM = 768;

// Provenance stamped on every vector this embedder writes. Retrieval partitions
// on it, so it must always describe the model that actually produced the vector.
export const OLLAMA_PROVENANCE: EmbeddingProvenance = {
  model: EMBED_MODEL,
  dim: EMBED_DIM,
};
const EMBED_TIMEOUT_MS = 10_000;
const PING_TIMEOUT_MS = 3_000;

// context-limit: input exceeded the model's context window (truncation retries
// exhausted). http: Ollama answered with a non-context error. network: fetch
// itself failed (daemon down, timeout). Distinct kinds so callers can log a
// failure that truncation could fix differently from one that needs Ollama up.
export type EmbedFailureKind = "context-limit" | "http" | "network";

export class EmbedderError extends Error {
  readonly kind: EmbedFailureKind;
  constructor(message: string, kind: EmbedFailureKind = "http") {
    super(message);
    this.name = "EmbedderError";
    this.kind = kind;
  }
}

// Ollama serves nomic-embed-text at num_ctx 2048; longer inputs are a hard 500
// ("input length exceeds the context length"), not a silent truncation. 2048
// tokens × the codebase chars/4 heuristic gives the proactive cap; the reactive
// halving in embedText covers text that tokenizes denser than 4 chars/token.
export const EMBED_MAX_CHARS = 8192;
const EMBED_MIN_CHARS = 512;

// Structural subset of fetch so tests can inject a fake without a DOM Response.
export type FetchImpl = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface EmbedResult {
  embedding: number[];
  sentChars: number;
  truncated: boolean;
}

function isContextLengthError(message: string): boolean {
  return /context length/i.test(message);
}

async function embedOnce(
  text: string,
  fetchImpl: FetchImpl,
): Promise<number[]> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), EMBED_TIMEOUT_MS);
  try {
    let resp: Awaited<ReturnType<FetchImpl>>;
    try {
      resp = await fetchImpl(`${OLLAMA_BASE}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
        signal: ac.signal,
      });
    } catch (err) {
      throw new EmbedderError(
        `Ollama unreachable: ${(err as Error).message}`,
        "network",
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new EmbedderError(
        `Ollama ${resp.status}: ${body}`,
        isContextLengthError(body) ? "context-limit" : "http",
      );
    }
    const data = (await resp.json()) as { embedding?: unknown; error?: string };
    if (data.error) {
      throw new EmbedderError(
        `Ollama error: ${data.error}`,
        isContextLengthError(data.error) ? "context-limit" : "http",
      );
    }
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      throw new EmbedderError("Ollama returned no embedding");
    }
    return (data.embedding as unknown[]).map((n) => Number(n));
  } finally {
    clearTimeout(t);
  }
}

// fetchImpl is injectable for tests only — production callers pass nothing.
export async function embedText(
  text: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<EmbedResult> {
  let sendChars = Math.min(text.length, EMBED_MAX_CHARS);
  for (;;) {
    try {
      const embedding = await embedOnce(text.slice(0, sendChars), fetchImpl);
      return { embedding, sentChars: sendChars, truncated: sendChars < text.length };
    } catch (err) {
      const contextLimit =
        err instanceof EmbedderError && err.kind === "context-limit";
      if (contextLimit && sendChars > EMBED_MIN_CHARS) {
        sendChars = Math.floor(sendChars / 2);
        continue;
      }
      throw err;
    }
  }
}

export async function embed(
  text: string,
  fetchImpl?: FetchImpl,
): Promise<number[]> {
  return (await embedText(text, fetchImpl)).embedding;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  const sim = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  // Clamp to [0, 1] — embeddings are typically positively correlated; negative
  // values would otherwise distort the topK ordering downstream.
  if (!Number.isFinite(sim)) return 0;
  if (sim < 0) return 0;
  if (sim > 1) return 1;
  return sim;
}

export async function isOllamaAvailable(): Promise<boolean> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PING_TIMEOUT_MS);
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: ac.signal });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Module-level memo so a long-running daemon doesn't hammer /api/tags on every
// session. Invalidated only by process restart, which is fine for our cadence.
let _availabilityCache: Promise<boolean> | null = null;
export function isOllamaAvailableCached(): Promise<boolean> {
  if (_availabilityCache === null) {
    _availabilityCache = isOllamaAvailable();
  }
  return _availabilityCache;
}

// One-shot health probe for doctor: proves the model can actually embed, not
// just that the daemon answers /api/tags (a state where the model is deleted
// or the embed endpoint is broken reads "healthy" on reachability alone).
// Returns the model id on success, null on any failure.
export async function probeEmbedding(): Promise<string | null> {
  try {
    await embed("ping");
    return EMBED_MODEL;
  } catch {
    return null;
  }
}

// Best-effort embed for the write/sweep paths: never throws, returns null on
// failure. The optional `log` receives one line per noteworthy event — a
// truncation (text was cut to fit the model context) or a failure with its
// kind — so a context-limit failure is distinguishable from Ollama being down
// in daemon.log. fetchImpl is injectable for tests only.
export async function embeddingForNote(
  text: string,
  log?: (msg: string) => void,
  fetchImpl?: FetchImpl,
): Promise<number[] | null> {
  try {
    const result = await embedText(
      text,
      fetchImpl ?? (fetch as unknown as FetchImpl),
    );
    if (result.truncated) {
      log?.(
        `embedding truncated: sent ${result.sentChars} of ${text.length} chars (model context limit)`,
      );
    }
    return result.embedding;
  } catch (err) {
    const kind = err instanceof EmbedderError ? err.kind : "network";
    log?.(`embed failed (${kind}): ${(err as Error).message}`);
    return null;
  }
}

const OLLAMA_BASE = "http://localhost:11434";
export const EMBED_MODEL = "nomic-embed-text";
const EMBED_TIMEOUT_MS = 10_000;
const PING_TIMEOUT_MS = 3_000;

export class EmbedderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedderError";
  }
}

export async function embed(text: string): Promise<number[]> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), EMBED_TIMEOUT_MS);
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      signal: ac.signal,
    });
    if (!resp.ok) {
      throw new EmbedderError(`Ollama ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
    const data = (await resp.json()) as { embedding?: unknown; error?: string };
    if (data.error) throw new EmbedderError(`Ollama error: ${data.error}`);
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      throw new EmbedderError("Ollama returned no embedding");
    }
    return (data.embedding as unknown[]).map((n) => Number(n));
  } finally {
    clearTimeout(t);
  }
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

export async function embeddingForNote(text: string): Promise<number[] | null> {
  try {
    return await embed(text);
  } catch {
    return null;
  }
}

import type { EmbeddingProvenance } from "../state/db.js";
import {
  EMBED_DIM,
  EMBED_MAX_CHARS,
  EMBED_MODEL,
  EmbedderError,
  embed,
  embedText,
  isOllamaAvailable,
  type EmbedResult,
  type FetchImpl,
} from "./embedder.js";
import { LocalProvider, isLocalProviderInstalled } from "./localProvider.js";

// One embedding backend, described completely: what model it runs, the vector
// geometry it produces (provenance), and how much input it can take. Retrieval
// and the writers consume ONLY this interface — the concrete backend (Ollama
// daemon, in-process fastembed, none) is a resolution decision, not a call-site
// concern.
export interface EmbeddingProvider {
  readonly name: "ollama" | "local";
  readonly modelName: string;
  readonly dimensions: number;
  readonly maxInputChars: number;
  available(): Promise<boolean>;
  // Doc embedding records truncation instead of silently dropping text.
  embedDoc(text: string): Promise<EmbedResult>;
  // Queries are short; a bare vector suffices. Kept separate because some
  // models (bge) prefix queries differently from passages.
  embedQuery(text: string): Promise<number[]>;
  provenance(): EmbeddingProvenance;
}

export type EmbeddingProviderChoice = "ollama" | "local" | "none";

// Probes are injectable for tests only — production callers pass nothing.
export interface ResolveProbes {
  ollamaAvailable?: () => Promise<boolean>;
  localInstalled?: () => boolean;
}

// Resolution order: configured > Ollama detected > local installed > none.
// `none` is a supported floor (TF-IDF), never an error state — so a configured
// provider that turns out unusable falls through to detection instead of
// blocking. Returns null for none.
export async function resolveEmbeddingProvider(
  configured: EmbeddingProviderChoice | undefined,
  probes: ResolveProbes = {},
): Promise<EmbeddingProvider | null> {
  const ollamaUp = probes.ollamaAvailable ?? isOllamaAvailable;
  const localUp = probes.localInstalled ?? isLocalProviderInstalled;
  if (configured === "none") return null;
  if (configured === "ollama" && (await ollamaUp())) return new OllamaProvider();
  if (configured === "local" && localUp()) return new LocalProvider();
  if (await ollamaUp()) return new OllamaProvider();
  if (localUp()) return new LocalProvider();
  return null;
}

// Module-level memo mirroring isOllamaAvailableCached: one resolution per
// process is enough (the daemon restarts every run). Not per-config — a single
// process never runs two configs.
let _resolvedProvider: Promise<EmbeddingProvider | null> | null = null;
export function resolveActiveProviderCached(
  configured: EmbeddingProviderChoice | undefined,
): Promise<EmbeddingProvider | null> {
  _resolvedProvider ??= resolveEmbeddingProvider(configured);
  return _resolvedProvider;
}

// Best-effort embed through a provider: never throws, returns null on failure,
// reports truncation and failure kind through `log` — the provider-agnostic
// successor of embedder.ts's embeddingForNote.
export async function embedNoteWithProvider(
  provider: EmbeddingProvider,
  text: string,
  log?: (msg: string) => void,
): Promise<number[] | null> {
  try {
    const result = await provider.embedDoc(text);
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

export class OllamaProvider implements EmbeddingProvider {
  readonly name = "ollama" as const;
  readonly modelName = EMBED_MODEL;
  readonly dimensions = EMBED_DIM;
  readonly maxInputChars = EMBED_MAX_CHARS;

  // fetchImpl is injectable for tests only — production callers pass nothing.
  constructor(private readonly fetchImpl?: FetchImpl) {}

  available(): Promise<boolean> {
    return isOllamaAvailable();
  }

  embedDoc(text: string): Promise<EmbedResult> {
    return embedText(text, this.fetchImpl);
  }

  // Routed through embed() (not embedText directly) so test suites that mock
  // the embedder module intercept query embedding the same way they always have.
  embedQuery(text: string): Promise<number[]> {
    return embed(text, this.fetchImpl);
  }

  provenance(): EmbeddingProvenance {
    return { model: this.modelName, dim: this.dimensions };
  }
}

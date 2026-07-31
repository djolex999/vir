import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EmbeddingProvenance } from "../state/db.js";
import type { EmbedResult } from "./embedder.js";
import type { EmbeddingProvider } from "./provider.js";

export const LOCAL_EMBED_MODEL = "bge-small-en-v1.5";
export const LOCAL_EMBED_DIM = 384;
// bge-small truncates at 512 tokens. 2000 chars ≈ 500 tokens on the chars/4
// heuristic — under the model's own cutoff, so what we record as "sent" is
// what the model actually saw, same discipline as the Ollama context fix.
export const LOCAL_MAX_CHARS = 2000;

// fastembed is ~233 MB of node_modules — far too heavy to ship as a dependency
// of a ~200 KB CLI, so it lives in its own npm prefix under ~/.vir, installed
// on demand by `vir embed --setup` and loaded dynamically from there.
export const LOCAL_PROVIDER_DIR = join(homedir(), ".vir", "embedder");
export const LOCAL_MODEL_CACHE_DIR = join(LOCAL_PROVIDER_DIR, "model-cache");

// Measured on the 2026-07-31 scratchpad experiment (fastembed 2.1.0, darwin).
export const SETUP_INSTALL_MB = 233;
export const SETUP_MODEL_MB = 128;

export function isLocalProviderInstalled(
  dir: string = LOCAL_PROVIDER_DIR,
): boolean {
  return existsSync(join(dir, "node_modules", "fastembed"));
}

// The slice of fastembed the provider needs, behind an injectable seam so unit
// tests never load the real 233 MB package or its model.
export interface FastembedEngine {
  embedBatch(texts: string[]): Promise<number[][]>;
  queryEmbed(text: string): Promise<number[]>;
}

interface FastembedModule {
  FlagEmbedding: {
    init(opts: {
      model: string;
      cacheDir: string;
    }): Promise<{
      embed(texts: string[], batchSize?: number): AsyncIterable<number[][]>;
      queryEmbed(text: string): Promise<number[] | Float32Array>;
    }>;
  };
  EmbeddingModel: Record<string, string>;
}

async function loadFastembedEngine(): Promise<FastembedEngine> {
  const req = createRequire(join(LOCAL_PROVIDER_DIR, "package.json"));
  const resolved = req.resolve("fastembed");
  const imported = (await import(pathToFileURL(resolved).href)) as
    | FastembedModule
    | { default: FastembedModule };
  const mod = "FlagEmbedding" in imported ? imported : imported.default;
  const model = await mod.FlagEmbedding.init({
    model: mod.EmbeddingModel["BGESmallENV15"] ?? "fast-bge-small-en-v1.5",
    cacheDir: LOCAL_MODEL_CACHE_DIR,
  });
  return {
    embedBatch: async (texts) => {
      const out: number[][] = [];
      for await (const batch of model.embed(texts, 16)) {
        for (const v of batch) out.push(Array.from(v));
      }
      return out;
    },
    queryEmbed: async (text) => Array.from(await model.queryEmbed(text)),
  };
}

export class LocalProvider implements EmbeddingProvider {
  readonly name = "local" as const;
  readonly modelName = LOCAL_EMBED_MODEL;
  readonly dimensions = LOCAL_EMBED_DIM;
  readonly maxInputChars = LOCAL_MAX_CHARS;

  private enginePromise: Promise<FastembedEngine> | null = null;

  // engineFactory is injectable for tests only — production callers pass
  // nothing and get the real fastembed load from LOCAL_PROVIDER_DIR.
  constructor(
    private readonly engineFactory: () => Promise<FastembedEngine> = loadFastembedEngine,
  ) {}

  private engine(): Promise<FastembedEngine> {
    this.enginePromise ??= this.engineFactory();
    return this.enginePromise;
  }

  async available(): Promise<boolean> {
    return isLocalProviderInstalled();
  }

  async embedDoc(text: string): Promise<EmbedResult> {
    const sent = text.slice(0, this.maxInputChars);
    const vecs = await (await this.engine()).embedBatch([sent]);
    const embedding = vecs[0];
    if (!embedding || embedding.length === 0) {
      throw new Error("fastembed returned no embedding");
    }
    return {
      embedding,
      sentChars: sent.length,
      truncated: sent.length < text.length,
    };
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.engine()).queryEmbed(text.slice(0, this.maxInputChars));
  }

  provenance(): EmbeddingProvenance {
    return { model: this.modelName, dim: this.dimensions };
  }
}

export interface SetupPlan {
  lines: string[];
  needsInstall: boolean;
}

// The cost statement `vir embed --setup` prints BEFORE touching the disk or
// the network. quiet=true drops the decorative lines but never the numbers.
export function buildSetupPlan(installed: boolean, quiet: boolean): SetupPlan {
  const lines: string[] = [];
  if (installed) {
    lines.push("fastembed already installed — skipping the package install.");
  } else {
    lines.push(
      `This installs fastembed (~${SETUP_INSTALL_MB} MB of node_modules) into ${LOCAL_PROVIDER_DIR}`,
    );
  }
  lines.push(
    `and downloads the ${LOCAL_EMBED_MODEL} model (~${SETUP_MODEL_MB} MB) on first embed.`,
  );
  if (!quiet) {
    lines.push("Nothing outside ~/.vir is touched; remove that folder to undo.");
  }
  return { lines, needsInstall: !installed };
}

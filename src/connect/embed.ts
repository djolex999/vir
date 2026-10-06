import type { EmbeddingProvider } from "../search/provider.js";
import type { StateDb } from "../state/db.js";
import type { Lesson } from "./types.js";

// Vectors for every lesson, keyed by contentHash. Cached vectors are reused;
// misses are embedded once per distinct hash and stored as they arrive, so a
// retry resumes where this run stopped. A provider failure stops the run
// (spec §10): clustering a fragment of the vault would propose rules from
// partial evidence. Over-long text is not a failure — the provider truncates.
export async function embedLessons(
  lessons: Lesson[],
  db: StateDb,
  provider: EmbeddingProvider,
): Promise<Map<string, number[]>> {
  const textByHash = new Map<string, string>();
  for (const l of lessons) textByHash.set(l.contentHash, l.text);
  const hashes = [...textByHash.keys()];
  const out = db.getLessonEmbeddings(hashes, provider.modelName);
  let embedded = 0;
  for (const hash of hashes) {
    if (out.has(hash)) continue;
    let vec: number[];
    try {
      vec = (await provider.embedDoc(textByHash.get(hash) ?? "")).embedding;
    } catch (err) {
      throw new Error(
        `embedding provider failed after ${embedded} lesson(s) — nothing written: ${(err as Error).message}`,
      );
    }
    db.storeLessonEmbedding(hash, provider.modelName, vec);
    out.set(hash, vec);
    embedded += 1;
  }
  return out;
}

// Self-heal for accepted rules: embedded at accept time, but a provider outage
// then, or a later model switch, would leave them out of embedding search.
// Best-effort — a failed embed is retried on the next sweep. Returns the count.
export async function backfillInsightEmbeddings(db: StateDb, provider: EmbeddingProvider): Promise<number> {
  let n = 0;
  for (const t of db.listInsightEmbeddingTargets(provider.modelName)) {
    let vec: number[];
    try {
      vec = (await provider.embedDoc(`${t.rule}\n${t.why}`)).embedding;
    } catch {
      continue;
    }
    db.setInsightEmbedding(t.id, vec, { model: provider.modelName, dim: vec.length });
    n += 1;
  }
  return n;
}

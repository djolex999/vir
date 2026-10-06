import { embedNoteWithProvider, type EmbeddingProvider } from "../search/provider.js";
import type { StateDb } from "../state/db.js";
import type { Lesson } from "./types.js";

// Vectors for every lesson that can be embedded, keyed by contentHash. Cached
// vectors are reused; misses are embedded once per distinct hash and stored.
// A failed embed leaves that lesson out (clustering ignores it) — never throws.
export async function embedLessons(
  lessons: Lesson[],
  db: StateDb,
  provider: EmbeddingProvider,
): Promise<Map<string, number[]>> {
  const textByHash = new Map<string, string>();
  for (const l of lessons) textByHash.set(l.contentHash, l.text);
  const hashes = [...textByHash.keys()];
  const out = db.getLessonEmbeddings(hashes, provider.modelName);
  for (const hash of hashes) {
    if (out.has(hash)) continue;
    const vec = await embedNoteWithProvider(provider, textByHash.get(hash) ?? "");
    if (vec === null) continue;
    db.storeLessonEmbedding(hash, provider.modelName, vec);
    out.set(hash, vec);
  }
  return out;
}

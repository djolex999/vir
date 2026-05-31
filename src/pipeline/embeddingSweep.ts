import {
  deriveSessionId,
  type EmbeddingTargetRow,
  type StateDb,
} from "../state/db.js";
import {
  embeddingForNote,
  isOllamaAvailableCached,
} from "../search/embedder.js";

// Pure selector mirroring db.listEmbeddingTargets's SQL filter, for unit tests
// against fixture rows. A note needs embedding when it was distilled
// (skipped=0, no error, has content + topic + category, not archived) but its
// `embedding` column is still NULL — the exact complement of getEmbeddings().
// Empty/errored rows belong to `vir reconcile`, not here; we never try to embed
// nothing.
export function selectEmbeddingTargets<T extends EmbeddingTargetRow>(
  rows: T[],
): T[] {
  return rows.filter(
    (r) =>
      r.skipped === 0 &&
      r.error === null &&
      r.content !== null &&
      r.content !== "" &&
      r.embedding === null &&
      r.topic !== null &&
      r.category !== null &&
      (r.archived ?? 0) === 0,
  );
}

export interface EmbedSweepResult {
  // false when the sweep was skipped because Ollama is down — it retries next
  // run rather than erroring now.
  ran: boolean;
  embedded: number;
  errors: number;
  // Notes still without an embedding after the sweep: all targets when skipped,
  // or just the ones whose embedding call failed when it ran.
  pending: number;
}

// Best-effort self-heal sweep. A write-time embedding miss (Ollama down when a
// note was distilled) leaves `embedding = NULL`, which makes the note invisible
// to the embedding-search path: it never enters getEmbeddings()'s candidate set,
// and search() only falls through to TF-IDF (the full-vault path) when
// embeddings return ZERO hits. So a transient outage becomes a *permanent*
// retrieval blind spot. This sweep back-fills those notes on the next run where
// Ollama is up, reusing the same embeddingForNote + storeEmbedding path as
// `vir embed` — no new embedding logic.
//
// When Ollama is down it no-ops (ran=false) and reports how many notes are
// pending, so the caller can log it. Same failure class as the Kie-200 and
// content-null silent failures: a best-effort step must record its skip so a
// reconcile pass can find it later.
export async function sweepEmbeddings(db: StateDb): Promise<EmbedSweepResult> {
  const targets = db.listEmbeddingTargets();
  if (!(await isOllamaAvailableCached())) {
    return { ran: false, embedded: 0, errors: 0, pending: targets.length };
  }
  let embedded = 0;
  let errors = 0;
  for (const t of targets) {
    if (!t.content || t.content.trim().length === 0) continue;
    const vec = await embeddingForNote(t.content);
    if (!vec) {
      errors += 1;
      continue;
    }
    db.storeEmbedding(deriveSessionId(t.path), vec);
    embedded += 1;
  }
  return { ran: true, embedded, errors, pending: errors };
}

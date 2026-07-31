// Similarity thresholds are properties of an embedding model's geometry, not
// of vir. nomic's cosines put unrelated dev notes at ≈0.4–0.55 and genuine
// neighbors at ≥0.6; bge-small runs much hotter (top hits 0.66–0.81 on the
// same vault, with unrelated pairs sitting ≈0.6). One shared constant is wrong
// for any multi-provider setup, so every consumer resolves its floor from the
// model that produced (or will produce) the vectors being compared.
export interface ModelThresholds {
  // Cosine floor below which a doc is not a retrieval candidate.
  minEmbeddingScore: number;
  // Cosine floor below which an embedding neighbor is noise, not a Related link.
  relatedMinSim: number;
}

export const MODEL_THRESHOLDS: Record<string, ModelThresholds> = {
  "nomic-embed-text": { minEmbeddingScore: 0.3, relatedMinSim: 0.6 },
  // Calibrated 2026-07-31 by quantile-matching nomic's floors on a real
  // 389-note vault (20 queries; 75,466 doc-doc pairs). The two models'
  // DOC-DOC cosine distributions are nearly identical (p50 0.744 vs 0.741,
  // p90 0.800 vs 0.795), so relatedMinSim carries over unchanged. QUERY-DOC
  // scores run ~0.15 hotter on bge (its query instruction prefix): nomic's
  // 0.3 floor sits ~0.12 below its in-domain minimum (0.416), so bge gets
  // the same margin below its own minimum (0.456) → 0.35. Remaining unknown:
  // where garbage/out-of-domain queries score under bge — measuring that
  // distribution against the vault would pin the floor exactly.
  "bge-small-en-v1.5": { minEmbeddingScore: 0.35, relatedMinSim: 0.6 },
};

const FALLBACK = MODEL_THRESHOLDS["nomic-embed-text"]!;

export function thresholdsFor(model: string): ModelThresholds {
  return MODEL_THRESHOLDS[model] ?? FALLBACK;
}

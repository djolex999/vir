import { describe, expect, it } from "vitest";
import { MODEL_THRESHOLDS, thresholdsFor } from "./thresholds.js";

describe("per-model similarity thresholds", () => {
  it("keeps the nomic-calibrated values for nomic-embed-text", () => {
    expect(thresholdsFor("nomic-embed-text")).toEqual({
      minEmbeddingScore: 0.3,
      relatedMinSim: 0.6,
    });
  });

  it("bge values are the 2026-07-31 vault-calibrated ones", () => {
    // Derived by quantile-matching nomic's floors on the real 389-note vault
    // (20 queries × 389 query-doc pairs; 75,466 doc-doc pairs). Doc-doc
    // distributions of the two models are nearly identical, so relatedMinSim
    // carries over; bge's query scores run hotter (its query instruction
    // prefix), so the candidate floor rises.
    expect(thresholdsFor("bge-small-en-v1.5")).toEqual({
      minEmbeddingScore: 0.35,
      relatedMinSim: 0.6,
    });
  });

  it("falls back to nomic values for an unknown model", () => {
    expect(thresholdsFor("some-future-model")).toEqual(
      thresholdsFor("nomic-embed-text"),
    );
  });
});

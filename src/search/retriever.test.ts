import { describe, expect, it } from "vitest";
import { mmrRerank, type ScoredCandidate } from "./retriever.js";

function cand(docId: string, score: number, embedding: number[]): ScoredCandidate {
  return { docId, score, embedding, content: `content-${docId}` };
}

describe("mmrRerank", () => {
  // mmrRerank takes the standard MMR lambda (relevance weight); the config field
  // retrievalDiversity is the inverse (lambda = 1 - retrievalDiversity), mapped
  // at the call site. So λ=1.0 ⇔ retrievalDiversity=0.0 ⇔ pure relevance.
  it("λ=1.0 (retrievalDiversity=0.0, pure relevance) is a no-op: returns top-K by score", () => {
    const candidates = [
      cand("a", 0.9, [1, 0, 0]),
      cand("b", 0.8, [0, 1, 0]),
      cand("c", 0.7, [0, 0, 1]),
      cand("d", 0.6, [1, 1, 0]),
      cand("e", 0.5, [0, 1, 1]),
    ];
    const ranked = mmrRerank(candidates, 3, 1.0);
    expect(ranked.map((c) => c.docId)).toEqual(["a", "b", "c"]);
  });

  it("λ=0.0 (retrievalDiversity=1.0, pure diversity): top-scored first, then most dissimilar", () => {
    const candidates = [
      cand("a", 0.9, [1, 0, 0]),
      cand("b", 0.85, [1, 0, 0]), // identical to a
      cand("c", 0.8, [0, 1, 0]), // orthogonal to a
      cand("d", 0.75, [1, 0, 0]), // identical to a
      cand("e", 0.7, [0, 0, 1]), // orthogonal to a and c
    ];
    const ranked = mmrRerank(candidates, 3, 0.0);
    // First pick is pure relevance; the rest minimize similarity to the
    // already-selected set, so the near-duplicates of `a` are skipped.
    expect(ranked[0]?.docId).toBe("a");
    expect(ranked.map((c) => c.docId)).toEqual(["a", "c", "e"]);
  });

  it("identical candidates degenerate to score-only sort", () => {
    const emb = [1, 0, 0];
    const candidates = [
      cand("a", 0.9, emb),
      cand("b", 0.8, emb),
      cand("c", 0.7, emb),
      cand("d", 0.6, emb),
      cand("e", 0.5, emb),
    ];
    const ranked = mmrRerank(candidates, 3, 0.7);
    expect(ranked.map((c) => c.docId)).toEqual(["a", "b", "c"]);
  });

  it("topK=1 skips MMR and returns the single top-scored candidate", () => {
    const candidates = [
      cand("a", 0.6, [1, 0, 0]),
      cand("b", 0.9, [0, 1, 0]),
      cand("c", 0.7, [0, 0, 1]),
    ];
    const ranked = mmrRerank(candidates, 1, 0.7);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.docId).toBe("b");
  });

  it("fewer candidates than topK returns all (sorted by score)", () => {
    const candidates = [
      cand("a", 0.5, [1, 0, 0]),
      cand("b", 0.9, [0, 1, 0]),
      cand("c", 0.7, [0, 0, 1]),
    ];
    const ranked = mmrRerank(candidates, 5, 0.7);
    expect(ranked.map((c) => c.docId)).toEqual(["b", "c", "a"]);
  });

  it("empty candidate list returns empty", () => {
    expect(mmrRerank([], 5, 0.7)).toEqual([]);
  });
});

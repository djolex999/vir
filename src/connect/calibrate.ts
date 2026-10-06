import type { Lesson } from "./types.js";

export interface BandPair {
  band: string; // "<lo>-<hi>"
  a: Lesson;
  b: Lesson;
  sim: number;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

// Deterministic LCG so a calibration sheet can be regenerated exactly.
function seededShuffle<T>(xs: T[], seed: number): T[] {
  const out = xs.slice();
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

// Stratified sample for hand-labeling: random pairs are almost all negatives,
// so bucket every cross-session pair by cosine band and take `perBand` from each.
export function sampleBandPairs(
  lessons: Lesson[],
  vectors: Map<string, number[]>,
  bands: Array<[number, number]>,
  perBand: number,
  seed: number,
): BandPair[] {
  const items = lessons.filter((l) => vectors.has(l.contentHash));
  const buckets = new Map<string, BandPair[]>(bands.map(([lo, hi]) => [`${lo}-${hi}`, []]));
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i] as Lesson;
      const b = items[j] as Lesson;
      if (a.sessionId === b.sessionId) continue;
      const sim = cosine(vectors.get(a.contentHash) ?? [], vectors.get(b.contentHash) ?? []);
      const band = bands.find(([lo, hi]) => sim >= lo && sim < hi);
      if (band) buckets.get(`${band[0]}-${band[1]}`)?.push({ band: `${band[0]}-${band[1]}`, a, b, sim });
    }
  }
  return [...buckets.values()].flatMap((pairs) => seededShuffle(pairs, seed).slice(0, perBand));
}

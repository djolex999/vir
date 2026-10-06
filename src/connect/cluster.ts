import type { Lesson } from "./types.js";

function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
function centroid(vs: number[][]): number[] {
  const dim = vs[0]?.length ?? 0;
  const c = new Array<number>(dim).fill(0);
  for (const v of vs) for (let i = 0; i < dim; i += 1) c[i] = (c[i] ?? 0) + (v[i] ?? 0);
  return unit(c);
}

export function clusterLessons(
  lessons: Lesson[],
  vectors: Map<string, number[]>,
  minSim: number,
  coreSim: number,
  cap = 20,
): Lesson[][] {
  const items = lessons
    .filter((l) => vectors.has(l.contentHash))
    .map((l) => ({ l, v: unit(vectors.get(l.contentHash) ?? []) }));
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i] ?? i] ?? i; i = parent[i] ?? i; }
    return i;
  };
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (dot(items[i]!.v, items[j]!.v) >= minSim) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, typeof items>();
  items.forEach((it, i) => {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(it);
    groups.set(r, g);
  });
  const out: Lesson[][] = [];
  for (let g of groups.values()) {
    if (g.length < 3) continue;
    for (let pass = 0; pass < 2; pass += 1) {
      const c = centroid(g.map((x) => x.v));
      g = g.filter((x) => dot(x.v, c) >= coreSim);
    }
    if (g.length < 3) continue;
    const c = centroid(g.map((x) => x.v));
    g = g
      .map((x) => ({ ...x, d: dot(x.v, c) }))
      .sort((a, b) => b.d - a.d || b.l.noteDate.localeCompare(a.l.noteDate))
      .slice(0, cap);
    out.push(g.map((x) => x.l).sort((a, b) => a.id.localeCompare(b.id)));
  }
  return out.sort((a, b) => (a[0]?.id ?? "").localeCompare(b[0]?.id ?? ""));
}

import { makeRng, sample } from "../rng.js";
import type { LabelRecord, QueryClass } from "../types.js";
import { currentLabels } from "./current.js";
import { rubricHash } from "./judge.js";
import { readLabelStore, readPool, readQuerySet, readRubric } from "./run.js";

// Renders labeled queries for a human: per query, every judged candidate with
// its grade and which arms ranked it where. `--per-class N` samples N queries
// from each class (seeded); default shows everything labeled.
export function showLabels(opts: { perClass: number | null; seed: number }): string {
  const set = readQuerySet();
  const pool = readPool(set);
  const labels = currentLabels(readLabelStore(), set, rubricHash(readRubric()));
  const byQuery = new Map<string, LabelRecord[]>();
  for (const l of labels) {
    const arr = byQuery.get(l.queryId) ?? [];
    arr.push(l);
    byQuery.set(l.queryId, arr);
  }
  const seenIn = new Map<string, Map<string, Array<{ arm: string; rank: number }>>>();
  for (const e of pool) {
    seenIn.set(e.queryId, new Map(e.candidates.map((c) => [c.slug, c.seenIn] as const)));
  }

  const rng = makeRng(opts.seed);
  const classes: QueryClass[] = ["real", "identifier", "conceptual", "garbage"];
  const lines: string[] = [];
  for (const cls of classes) {
    const labeled = set.queries.filter((q) => q.class === cls && byQuery.has(q.id));
    const chosen = opts.perClass === null ? labeled : sample(labeled, opts.perClass, rng);
    for (const q of chosen) {
      const recs = [...(byQuery.get(q.id) ?? [])].sort((a, b) => b.grade - a.grade || a.slug.localeCompare(b.slug));
      const counts = [0, 1, 2].map((g) => recs.filter((r) => r.grade === g).length);
      lines.push(`## ${q.id} [${cls}]  "${q.text}"`);
      if (q.sourceSlug) lines.push(`   source note: ${q.sourceSlug}`);
      lines.push(`   judged ${recs.length}: ${counts[2]}×2  ${counts[1]}×1  ${counts[0]}×0`);
      for (const r of recs) {
        if (r.grade === 0) continue;
        const where = (seenIn.get(q.id)?.get(r.slug) ?? [])
          .map((s) => `${s.arm}#${s.rank}`)
          .join(" ");
        lines.push(`   ${r.grade}  ${r.slug}   (${where})`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

// Lays out a sample of the author's real vault with d3-force at build time and
// writes src/data/graph.json. The JSON is committed: deploy builds have no vault.
//   node scripts/build-graph.mjs [vault/vir dir]
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY } from "d3-force";

const root =
  process.argv[2] ??
  join(JSON.parse(readFileSync(join(process.env.HOME, ".vir/config.json"), "utf8")).vaultPath, "vir");
const MAX_NODES = 110;
// Topics that read as security findings stay out of the public sample.
const EXCLUDE = /leak|bypass|attack|inject|exploit|vuln|self-grant|secur/i;
const W = 1120, H = 640;

const files = [];
for (const dir of ["patterns", "gotchas", "decisions", "tools"]) {
  for (const f of readdirSync(join(root, dir))) if (f.endsWith(".md")) files.push(join(root, dir, f));
}
const notes = new Map(); // file basename (link target) -> {label, cat, links:Set}
for (const p of files) {
  const s = readFileSync(p, "utf8");
  const topic = s.match(/^topic: "(.+)"$/m)?.[1];
  const key = basename(p, ".md");
  const cat = s.match(/^category: (\w+)$/m)?.[1];
  if (!topic || !cat || EXCLUDE.test(topic) || EXCLUDE.test(key)) continue;
  const links = new Set([...s.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()));
  notes.set(key, { label: topic, cat, links });
}
const degree = new Map();
for (const [a, n] of notes) for (const l of n.links) if (notes.has(l) && l !== a) {
  degree.set(a, (degree.get(a) ?? 0) + 1);
  degree.set(l, (degree.get(l) ?? 0) + 1);
}
const chosen = [...notes.keys()].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0)).slice(0, MAX_NODES);
const set = new Set(chosen);
const nodes = chosen.map((id) => ({ id, label: notes.get(id).label, cat: notes.get(id).cat, d: degree.get(id) ?? 0 }));
const seen = new Set();
const links = [];
for (const a of chosen) for (const l of notes.get(a).links) {
  if (!set.has(l) || l === a) continue;
  const k = [a, l].sort().join("|");
  if (seen.has(k)) continue;
  seen.add(k);
  links.push({ source: a, target: l });
}
const sim = forceSimulation(nodes)
  .force("link", forceLink(links).id((d) => d.id).distance(46).strength(0.35))
  .force("charge", forceManyBody().strength(-120).distanceMax(260))
  .force("center", forceCenter(W / 2, H / 2))
  .force("x", forceX(W / 2).strength(0.045))
  .force("y", forceY(H / 2).strength(0.09))
  .force("collide", forceCollide(11))
  .stop();
for (let i = 0; i < 600; i++) sim.tick();
const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
const pad = 24;
const sx = (W - pad * 2) / (maxX - minX), sy = (H - pad * 2) / (maxY - minY), s = Math.min(sx, sy);
const out = {
  w: W, h: H,
  total: { notes: notes.size, links: [...notes.values()].reduce((n, x) => n + x.links.size, 0) },
  nodes: nodes.map((n) => ({
    id: n.id, label: n.label, cat: n.cat,
    x: +(pad + (n.x - minX) * s + ((W - pad * 2) - (maxX - minX) * s) / 2).toFixed(1),
    y: +(pad + (n.y - minY) * s + ((H - pad * 2) - (maxY - minY) * s) / 2).toFixed(1),
    r: +(3.5 + Math.min(n.d, 12) * 0.5).toFixed(1),
  })),
  links: links.map((l) => [l.source.id, l.target.id]),
};
writeFileSync(new URL("../src/data/graph.json", import.meta.url), JSON.stringify(out));
console.log(`graph.json: ${out.nodes.length} nodes, ${out.links.length} links (vault: ${out.total.notes} notes)`);

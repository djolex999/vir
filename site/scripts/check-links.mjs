// Fails the build when an internal link points at a page dist/ doesn't have.
// Astro and Starlight treat hrefs as opaque strings, so a renamed docs page
// silently ships a 404 into the site's own navigation.
//   cd site && npm run build && node scripts/check-links.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(DIST);
const pages = files.filter((f) => f.endsWith(".html"));

// Every path the built site can actually serve.
const served = new Set();
for (const f of files) {
  const rel = `/${relative(DIST, f)}`;
  served.add(rel);
  if (rel.endsWith("/index.html")) {
    served.add(rel.slice(0, -"index.html".length)); // /docs/
    served.add(rel.slice(0, -"/index.html".length)); // /docs
  }
}

const broken = [];
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const from = `/${relative(DIST, page)}`;
  for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]*)(?:[#?][^"]*)?"/g)) {
    const target = m[1];
    if (!target || target.startsWith("//")) continue;
    if (target.startsWith("/_vercel/")) continue; // injected at serve time
    if (served.has(target) || served.has(`${target}/`) || served.has(`${target}/index.html`)) continue;
    broken.push({ from, target });
  }
}

if (broken.length > 0) {
  console.error(`${broken.length} broken internal link(s):\n`);
  for (const b of broken) console.error(`  ${b.from}\n    → ${b.target}`);
  process.exit(1);
}
console.log(`internal links OK (${pages.length} pages checked)`);

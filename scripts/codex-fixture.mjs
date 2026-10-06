// Builds the LOCAL-ONLY fixture for src/sources/codex/inject.fixture.test.ts
// from your own ~/.codex/sessions. The output dir is gitignored: it holds your
// real prompts and must never be committed. Run: npm run fixture:codex
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DROP_PREFIXES, WRAPPER_PREFIXES, stripCodexInjected } from "../dist/sources/codex/inject.js";

const root = process.argv[2] ?? join(homedir(), ".codex", "sessions");
const out = new URL("../src/sources/codex/fixtures/", import.meta.url).pathname;

const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith(".jsonl")) files.push(p);
  }
})(root);

// Same flattening as the parser: text parts verbatim, other parts as [type].
const messages = new Set();
for (const f of files) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    const p = evt?.payload;
    if (evt?.type !== "response_item" || p?.type !== "message" || p.role !== "user" || !Array.isArray(p.content)) continue;
    messages.add(p.content.map((c) => (typeof c?.text === "string" ? c.text : `[${c?.type}]`)).join("\n"));
  }
}

mkdirSync(out, { recursive: true });
const sorted = [...messages].sort();
writeFileSync(join(out, "user-messages.json"), JSON.stringify(sorted, null, 1));

// Headings file is hand-curated: written once from candidates (heading-shaped
// text the filter keeps), never overwritten. Review it — every line must be the
// first line of a prompt YOU wrote; delete the file to regenerate.
const known = [...DROP_PREFIXES, ...WRAPPER_PREFIXES];
const candidates = [
  ...new Set(
    sorted
      .map((m) => stripCodexInjected(m)?.trimStart() ?? "")
      .filter((t) => /^[#<]/.test(t) && !known.some((k) => t.startsWith(k)))
      .map((t) => t.split("\n")[0]),
  ),
];
const headingsPath = join(out, "known-user-headings.json");
if (!existsSync(headingsPath)) writeFileSync(headingsPath, JSON.stringify(candidates, null, 1));
console.log(`${files.length} rollouts → ${sorted.length} unique user messages → ${out}`);
console.log(`${candidates.length} heading-shaped prompt(s); review ${headingsPath}:`);
for (const c of candidates) console.log(`  ${c.slice(0, 80)}`);

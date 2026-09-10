// Publishes the notes vir wrote about vir as public docs pages.
//
// This is the only honest proof of output quality: not a sample note chosen to
// flatter the tool, but everything it produced about one project, including the
// thin ones. Scoped to project "vir" — no other project's knowledge is public.
//
//   cd site && node scripts/build-vault.mjs
//
// Output is committed; Vercel has no vault.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME ?? "";
const cfg = JSON.parse(readFileSync(join(home, ".vir/config.json"), "utf8"));
const vault = join(cfg.vaultPath.replace(/^~/, home), cfg.outputDir ?? "vir");
const OUT = new URL("../src/content/docs/vault/", import.meta.url).pathname;

const PROJECT = "vir";
const CATS = { patterns: "Patterns", gotchas: "Gotchas", decisions: "Decisions", tools: "Tools" };
// Same rule as the hero graph: findings that read as live vulnerabilities stay private.
const EXCLUDE = /leak|bypass|attack|inject|exploit|vuln|self-grant|secur/i;

function parse(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+): (.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^"|"$/g, "");
  }
  return { fm, body: m[2] };
}

const notes = [];
for (const [dir, label] of Object.entries(CATS)) {
  let files = [];
  try {
    files = readdirSync(join(vault, dir)).filter((f) => f.endsWith(".md"));
  } catch {
    continue;
  }
  for (const f of files) {
    const parsed = parse(readFileSync(join(vault, dir, f), "utf8"));
    if (!parsed) continue;
    const { fm, body } = parsed;
    if (fm.project !== PROJECT) continue;
    if (EXCLUDE.test(fm.topic ?? "") || EXCLUDE.test(f)) continue;
    notes.push({ slug: f.replace(/\.md$/, ""), dir, label, fm, body });
  }
}

const bySlug = new Map(notes.map((n) => [n.slug, n]));
const byAlias = new Map(notes.map((n) => [n.slug.replace(/-[0-9a-f]{6,}$/, ""), n]));

function rewrite(body) {
  return (
    body
      // the writer's Project:/Category: header is metadata, shown in the page frame instead
      .replace(/^Project: \[\[[^\]]+\]\]\nCategory: \[\[[^\]]+\]\]\n+/m, "")
      // [[slug-hash|Label]] and [[slug]] → a link when the target is published,
      // otherwise the label as plain text so nothing dangles
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => {
        const text = label ?? target;
        const hit = bySlug.get(target) ?? byAlias.get(target);
        return hit ? `[${text}](/vault/${hit.dir}/${hit.slug}/)` : text;
      })
      .trim()
  );
}

rmSync(OUT, { recursive: true, force: true });
const counts = {};
for (const n of notes) {
  const dir = join(OUT, n.dir);
  mkdirSync(dir, { recursive: true });
  counts[n.label] = (counts[n.label] ?? 0) + 1;
  const date = (n.fm.date ?? "").slice(0, 10);
  const first =
    rewrite(n.body).replace(/^#+ .*$/gm, "").split("\n").find((l) => l.trim().length > 40) ?? "";
  writeFileSync(
    join(dir, `${n.slug}.md`),
    `---
title: ${JSON.stringify(n.fm.topic ?? n.slug)}
description: ${JSON.stringify(`${n.label.replace(/s$/, "")} distilled by vir from a Claude Code session on ${date}. ${first.slice(0, 120)}`.trim())}
editUrl: false
---

:::note[Written by vir, not by a human]
**${n.label.replace(/s$/, "")}** · session \`${(n.fm.session_id ?? "").slice(0, 8)}\` · ${date} · classifier confidence ${n.fm.confidence ?? "—"}
:::

${rewrite(n.body)}
`,
  );
}

console.log(
  `vault/: ${notes.length} notes — ${Object.entries(counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")}`,
);

import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SITE_URL } from "../consts";

interface Release {
  version: string;
  date: Date;
  body: string;
}

// One feed item per release, parsed from the repo CHANGELOG.md — the same
// file `scripts/sync-changelog.mjs` renders as the docs page, so the feed can
// never disagree with the site.
export function parseReleases(md: string): Release[] {
  const out: Release[] = [];
  const heading = /^## (\d+\.\d+\.\d+)\s+[—-]\s+(\d{4}-\d{2}-\d{2})\s*$/gm;
  const marks: { version: string; date: string; start: number; end: number }[] = [];
  for (const m of md.matchAll(heading)) {
    const at = m.index ?? 0;
    const prev = marks[marks.length - 1];
    if (prev) prev.end = at;
    marks.push({ version: m[1]!, date: m[2]!, start: at + m[0].length, end: md.length });
  }
  for (const k of marks) {
    out.push({
      version: k.version,
      date: new Date(`${k.date}T12:00:00Z`),
      body: md.slice(k.start, k.end).trim(),
    });
  }
  return out;
}

export async function GET(context: APIContext) {
  // cwd is site/ during `astro build`; import.meta.url is unreliable once bundled.
  const md = readFileSync(resolve(process.cwd(), "..", "CHANGELOG.md"), "utf8");
  const releases = parseReleases(md).slice(0, 30);
  return rss({
    title: "vir releases",
    description: "Release notes for vir, an LLM Wiki for Claude Code in your Obsidian vault.",
    site: context.site ?? SITE_URL,
    items: releases.map((r) => ({
      title: `vir ${r.version}`,
      pubDate: r.date,
      link: `${SITE_URL}/docs/changelog/`,
      description: r.body.split("\n\n")[0]?.replace(/\n/g, " ").slice(0, 400) ?? "",
      content: r.body,
    })),
    customData: "<language>en</language>",
  });
}

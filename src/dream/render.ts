import { CHANGELOG_HEADER } from "../pipeline/summarizer.js";
import type { DreamEntry, DreamPage, DreamStats } from "./validate.js";

// The page an agent reads through vir_project_summary. Links, labels and
// ordering are all decided here from validated data, never by the model.

function entryLines(e: DreamEntry): string {
  const parts = [`- ${e.claim} — [[${e.ref}]]`, e.confirmed ? "confirmed" : "unconfirmed"];
  if (e.surfaced > 0) parts.push(`retrieved ${e.surfaced}×`);
  if (e.alsoRefs.length > 0) parts.push(`also ${e.alsoRefs.map((r) => `[[${r}]]`).join(", ")}`);
  return `${parts.join(" · ")}\n  > ${e.quote.replace(/\s+/g, " ").trim()}`;
}

export function renderBody(page: DreamPage): string {
  const out: string[] = [];
  if (page.overview !== "") out.push(`## Overview\n\n${page.overview}`);
  for (const s of page.sections) {
    const ordered = [...s.entries].sort(
      (a, b) => Number(b.confirmed) - Number(a.confirmed) || b.surfaced - a.surfaced,
    );
    out.push(`## ${s.heading}\n\n${ordered.map(entryLines).join("\n")}`);
  }
  if (page.conflicts.length > 0) {
    const lines = page.conflicts.map((c) => `- [[${c.a}]] and [[${c.b}]] disagree: ${c.about}`);
    out.push(`## Needs review\n\n${lines.join("\n")}`);
  }
  if (page.gaps.length > 0) out.push(`## Gaps\n\n${page.gaps.map((g) => `- ${g}`).join("\n")}`);
  return out.join("\n\n");
}

export function renderDreamFile(args: {
  projectSlug: string;
  page: DreamPage;
  stats: DreamStats;
  notes: number;
  sessions: number;
  inputHash: string;
  model: string;
  generated: string;
  existingChangelog: string[];
}): string {
  const { stats } = args;
  const frontmatter = [
    "---",
    `project: ${args.projectSlug}`,
    `generated: ${args.generated}`,
    `sessions: ${args.sessions}`,
    "kind: dream",
    `input_hash: ${args.inputHash}`,
    `notes: ${args.notes}`,
    `entries: ${stats.kept}`,
    `confirmed: ${stats.confirmed}`,
    `ratio: ${stats.ratio.toFixed(2)}`,
    `model: ${args.model}`,
    "---",
  ].join("\n");
  const today = `- ${args.generated.slice(0, 10)}: dream, ${args.notes} notes, ${stats.kept} entries (${stats.confirmed} confirmed)`;
  const changelog = [CHANGELOG_HEADER, today, ...args.existingChangelog].join("\n");
  return `${frontmatter}\n\nProject: [[${args.projectSlug}]]\n\n${renderBody(args.page)}\n\n---\n${changelog}\n`;
}

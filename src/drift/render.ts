import { driftCount, type DriftItem, type DriftReport } from "./types.js";

// Markdown report: only the differences, grouped per doc, stale then changed.

export const NO_DRIFT = "No drift detected";

function itemLine(i: DriftItem): string {
  const now = i.now !== undefined ? ` → \`${i.now}\`` : "";
  return `- L${i.claim.line} \`${i.claim.text}\`${now} — ${i.detail}`;
}

export function renderDrift(r: DriftReport): string {
  const total = driftCount(r);
  const checked = r.docs.reduce((n, d) => n + d.checked, 0);
  const out: string[] = [
    "---",
    "kind: drift",
    `project: ${r.slug}`,
    `date: ${r.date}`,
    `head: ${r.head ?? "none"}`,
    `docs: ${r.docs.length}`,
    `claims_checked: ${checked}`,
    `drift: ${total}`,
    "---",
    "",
    `# Docs drift: ${r.slug} (${r.date})`,
    "",
    `${r.docs.length} doc(s), ${checked} claim(s) checked against \`${r.head ?? "working tree"}\`.`,
    "",
  ];
  if (total === 0) {
    out.push(`${NO_DRIFT}.`, "");
    return out.join("\n");
  }
  for (const d of r.docs) {
    if (d.items.length === 0) continue;
    const from = d.source !== undefined ? ` (from ${d.source})` : "";
    out.push(`## ${d.doc}${from}`, "");
    const stale = d.items.filter((i) => i.kind === "stale");
    const changed = d.items.filter((i) => i.kind === "changed");
    if (stale.length > 0) out.push("### Stale: the doc says it, the code has none", "", ...stale.map(itemLine), "");
    if (changed.length > 0) out.push("### Changed: the doc says X, the code has Y", "", ...changed.map(itemLine), "");
  }
  if (r.undocumented.length > 0) {
    out.push("## Undocumented: in the code, in no doc", "");
    for (const u of r.undocumented) out.push(`- \`${u.name}\` (${u.kind === "src-dir" ? "source module" : "CLI command"})`);
    if (r.undocumentedMore > 0) out.push(`- …and ${r.undocumentedMore} more`);
    out.push("");
  }
  return out.join("\n");
}

// `vir drift`: where a repo's docs say something the code no longer backs.

export type ClaimKind = "path" | "npm-script" | "cli-command" | "cli-flag" | "env-var" | "dependency" | "package-manager";

export interface Claim {
  kind: ClaimKind;
  // What the doc says, as written (`src/foo.ts`, `npm run build`, `vir sync`).
  text: string;
  // The thing checked: a repo-relative path, a script name, a command path…
  value: string;
  line: number;
  // Paths only: where it was written. A tree entry or link resolves against
  // the doc's folder first, a code span against the repo root. A link is
  // always a claim about the repo; a span or tree entry only when its first
  // folder exists (otherwise it describes the vault, ~ or another repo).
  via?: "span" | "tree" | "link";
}

export type DriftKind = "stale" | "changed";

export interface DriftItem {
  kind: DriftKind;
  claim: Claim;
  // Why it drifted, in a few words ("no such file", "renamed in a1b2c3d").
  detail: string;
  // `changed` only: what the code has instead.
  now?: string;
}

export interface DocReport {
  // Repo-relative path of the doc.
  doc: string;
  // Set when the doc came from somewhere other than the checked tree, e.g.
  // the main checkout's gitignored CLAUDE.md read from a worktree.
  source?: string;
  checked: number;
  items: DriftItem[];
}

export interface Undocumented {
  kind: "src-dir" | "cli-command";
  name: string;
}

export interface DriftReport {
  root: string;
  slug: string;
  date: string;
  head: string | null;
  docs: DocReport[];
  undocumented: Undocumented[];
  // How many undocumented entries were cut by the cap.
  undocumentedMore: number;
}

export function driftCount(r: DriftReport): number {
  return r.docs.reduce((n, d) => n + d.items.length, 0) + r.undocumented.length + r.undocumentedMore;
}

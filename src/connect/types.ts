import type { Category } from "../pipeline/types.js";

// One lesson: a bolded item under a note's "## What Was Learned" (or its
// Summary when the section is missing), normalized for hashing and embedding.
export interface Lesson {
  id: string; // `${noteSlug}#${itemIndex}`, unique per run
  noteSlug: string; // filename (no .md) the text came from
  citeSlug: string; // citation target: the live merge winner for archived lessons
  sessionId: string;
  noteDate: string; // ISO, from frontmatter `date`
  project: string; // kebab slug of frontmatter `project`
  category: Category;
  itemIndex: number;
  text: string; // normalized
  contentHash: string; // sha256(text), first 16 hex
  archivedVia: string | null; // winner slug when read from archived/
}

export type InsightStatus = "proposed" | "accepted" | "rejected";
export type Promotion = "none" | "promoted" | "declined";

export interface InsightEvidence {
  sessionId: string;
  citeSlug: string;
  project: string;
  date: string;
  quote: string;
  // From a note `vir dedupe` merged away: citeSlug is the note it merged into,
  // so the same slug can appear twice — this tells them apart.
  merged?: boolean;
}

// One proposed/accepted/rejected rule. The DB row is the source of truth; the
// markdown file mirrors it.
export interface InsightRow {
  id: string;
  slug: string;
  insightType: "recurring-rule";
  status: InsightStatus;
  promotion: Promotion;
  scope: string;
  rule: string;
  why: string;
  memberSessionIds: string[];
  memberHashes: string[];
  sources: string[]; // cite slugs
  evidence: InsightEvidence[];
  sessions: number;
  projects: string[];
  firstSeen: string;
  lastSeen: string;
  evidenceChanged: boolean;
  pending: InsightEvidence[] | null;
  model: string;
  createdAt: string;
  updatedAt: string;
}

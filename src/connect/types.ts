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

// The ONE definition of how a note's filename slug is built. db.ts, the
// dedupe merger, and the linter all reconstruct note paths from DB rows —
// any local reimplementation that skips the 50-char truncation or the
// `note-` fallback silently diverges from the files the writer actually
// wrote (notes vanish from embedding search, merges target phantom paths).
// This module stays dependency-free so anything may import it without cycles.
export function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function makeSlug(topic: string, sessionId: string): string {
  const base = kebab(topic).slice(0, 50);
  const suffix = sessionId.slice(0, 8);
  return base.length > 0 ? `${base}-${suffix}` : `note-${suffix}`;
}

// The half of a note filename that identifies its session. MUST stay in step
// with the suffix makeSlug appends: callers resolve an existing note by this
// when the topic half has changed underneath them.
export function sessionSuffix(sessionId: string): string {
  return sessionId.slice(0, 8);
}

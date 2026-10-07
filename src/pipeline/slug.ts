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
  const suffix = sessionSuffix(sessionId);
  return base.length > 0 ? `${base}-${suffix}` : `note-${suffix}`;
}

// The half of a note filename that identifies its session. MUST stay in step
// with the suffix makeSlug appends: callers resolve an existing note by this
// when the topic half has changed underneath them.
// Codex ids are `rollout-<ts>-<uuidv7>`: the head is the same for every note,
// and a v7 uuid's leading hex is a timestamp, so take its random tail.
const CODEX_ROLLOUT_ID = /^rollout-.*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{12})$/;

export function sessionSuffix(sessionId: string): string {
  const codex = CODEX_ROLLOUT_ID.exec(sessionId);
  const tail = codex?.[1];
  return tail !== undefined ? tail.slice(-8) : sessionId.slice(0, 8);
}

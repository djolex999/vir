import { sample, type Rng } from "../rng.js";
import type { RetrievedHit } from "./types.js";

export const FETCH_K = 30;
export const TOP_K = 8;
export const MAX_EXPOSED = 60;
export const MAX_CONTROL = 20;

// Post-filter production's top-30 down to 8 the question may legitimately see
// (spec D5). ISO timestamps compare correctly as strings.
export function filterForCutoff(
  hits: readonly RetrievedHit[],
  q: { sessionId: string; cutoff: string },
  k: number = TOP_K,
): { top: RetrievedHit[]; droppedNonSession: number; droppedLeak: number } {
  const top: RetrievedHit[] = [];
  let droppedNonSession = 0;
  let droppedLeak = 0;
  for (const h of hits) {
    if (top.length >= k) break;
    if (h.sessionId === null) {
      droppedNonSession += 1;
      continue;
    }
    // A note with no start time cannot be shown to predate the question.
    if (h.sessionId === q.sessionId || h.startedAt === null || h.startedAt >= q.cutoff) {
      droppedLeak += 1;
      continue;
    }
    top.push(h);
  }
  return { top, droppedNonSession, droppedLeak };
}

export function exposedTo(top: readonly RetrievedHit[], rejectIds: ReadonlySet<string>): string[] {
  return top.flatMap((h) => (h.sessionId !== null && rejectIds.has(h.sessionId) ? [h.sessionId] : []));
}

export function sampleSets(
  exposedIds: readonly string[],
  otherIds: readonly string[],
  rng: Rng,
  maxExposed: number = MAX_EXPOSED,
  maxControl: number = MAX_CONTROL,
): { exposed: string[]; control: string[] } {
  const exposed = exposedIds.length <= maxExposed ? [...exposedIds] : sample(exposedIds, maxExposed, rng);
  return { exposed, control: sample(otherIds, maxControl, rng) };
}

// The full session id in frontmatter is the authority; the 8-hex filename
// suffix can collide (writer.ts belongsToSession).
export function sessionIdFromNote(content: string): string | null {
  const block = /^---\n([\s\S]*?)\n---/.exec(content)?.[1];
  if (block === undefined) return null;
  const m = /^session_id:\s*(\S+)\s*$/m.exec(block);
  return m?.[1] ?? null;
}

import type { GroundRow } from "../state/db.js";
import { isVerified } from "./retriever.js";

// How far a retrieved note can be trusted, for the agent reading it. Agents
// that know which facts are confirmed lean on those without re-checking; a note
// is otherwise indistinguishable from a guess written as fact.
//   verified             a human approved it in `vir review`
//   transcript-supported `vir audit --transcript` found every claim in its session
//   unbacked             some claims have no support in the transcript
//   contradicted         the transcript shows something different
//   unchecked            none of the above (or the note changed since the check)
export type NoteStatus = "verified" | "transcript-supported" | "unbacked" | "contradicted" | "unchecked";

const SESSION_SUFFIX = /-([0-9a-f]{8})$/;

function sessionIdOf(transcriptPath: string): string {
  const base = transcriptPath.slice(transcriptPath.lastIndexOf("/") + 1);
  return base.replace(/\.jsonl$/, "");
}

// Fresh transcript-check results, looked up by a note's file name: a session
// note's file ends with the first 8 characters of its session id.
export function noteStatusLookup(grounds: GroundRow[]): (hit: { title: string; content: string }) => NoteStatus {
  const bySuffix = new Map<string, GroundRow["verdict"]>();
  const ambiguous = new Set<string>();
  for (const g of grounds) {
    if (!g.fresh) continue;
    const suffix = sessionIdOf(g.path).slice(0, 8);
    if (bySuffix.has(suffix)) ambiguous.add(suffix);
    bySuffix.set(suffix, g.verdict);
  }
  return (hit) => {
    if (isVerified(hit.content)) return "verified";
    const base = hit.title.slice(hit.title.lastIndexOf("/") + 1);
    const suffix = base.match(SESSION_SUFFIX)?.[1];
    if (suffix === undefined || ambiguous.has(suffix)) return "unchecked";
    const verdict = bySuffix.get(suffix);
    if (verdict === "supported") return "transcript-supported";
    return verdict ?? "unchecked";
  };
}

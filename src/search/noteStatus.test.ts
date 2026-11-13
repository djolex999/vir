import { describe, expect, it } from "vitest";
import type { GroundRow } from "../state/db.js";
import type { SearchHit } from "./retriever.js";
import { buildSynthesisPrompt } from "./synthesizer.js";
import { noteStatusLookup } from "./noteStatus.js";

const ground = (sessionId: string, verdict: GroundRow["verdict"], fresh = true): GroundRow => ({
  path: `/p/-home-u-vir/${sessionId}.jsonl`,
  verdict,
  reason: "",
  groundedAt: "",
  fresh,
});
const hit = (title: string, content = "---\ntopic: \"x\"\n---\nbody", score = 0.8): SearchHit => ({
  filePath: `/v/${title}.md`,
  title,
  content,
  score,
  method: "embedding",
});

describe("noteStatusLookup", () => {
  const statusOf = noteStatusLookup([
    ground("aaaa1111-0000-4000-8000-000000000001", "supported"),
    ground("bbbb2222-0000-4000-8000-000000000001", "contradicted"),
    ground("cccc3333-0000-4000-8000-000000000001", "unbacked"),
    ground("dddd4444-0000-4000-8000-000000000001", "contradicted", false),
  ]);

  it("maps a fresh transcript check to the note by its session suffix", () => {
    expect(statusOf(hit("gotchas/x-aaaa1111"))).toBe("transcript-supported");
    expect(statusOf(hit("gotchas/y-bbbb2222"))).toBe("contradicted");
    expect(statusOf(hit("patterns/z-cccc3333"))).toBe("unbacked");
  });

  it("ignores a check on an older version of the note, and notes without a session suffix", () => {
    expect(statusOf(hit("gotchas/w-dddd4444"))).toBe("unchecked");
    expect(statusOf(hit("topics/auth-flow-patterns"))).toBe("unchecked");
  });

  it("puts human approval first", () => {
    expect(statusOf(hit("gotchas/y-bbbb2222", "---\nverified: true\n---\nbody"))).toBe("verified");
  });

  it("refuses to guess when two checked sessions share a suffix", () => {
    const s = noteStatusLookup([
      ground("eeee5555-0000-4000-8000-000000000001", "supported"),
      ground("eeee5555-1111-4000-8000-000000000001", "contradicted"),
    ]);
    expect(s(hit("gotchas/v-eeee5555"))).toBe("unchecked");
  });
});

describe("buildSynthesisPrompt with statuses", () => {
  const hits = [hit("gotchas/x-aaaa1111"), hit("gotchas/y-bbbb2222")];

  it("is byte-identical when no hit has been checked", () => {
    expect(buildSynthesisPrompt("q", hits, () => "unchecked")).toBe(buildSynthesisPrompt("q", hits));
  });

  it("labels checked notes and warns against a contradicted one", () => {
    const p = buildSynthesisPrompt("q", hits, (h) => (h.title.endsWith("bbbb2222") ? "contradicted" : "transcript-supported"));
    expect(p).toContain("### gotchas/x-aaaa1111 (score: 0.8, matches its session transcript)");
    expect(p).toContain("### gotchas/y-bbbb2222 (score: 0.8, CONTRADICTED by its session transcript)");
    expect(p).toContain("do not state its claims as fact");
  });

  it("adds no warning when every checked note is supported or verified", () => {
    const p = buildSynthesisPrompt("q", hits, () => "transcript-supported");
    expect(p).not.toContain("do not state its claims as fact");
  });
});

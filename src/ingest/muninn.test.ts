import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMeetingNote,
  IngestError,
  meetingRelPath,
  meetingSlug,
  parseMuninnNote,
  stripTranscript,
} from "./muninn.js";

const SAMPLE = readFileSync(join(import.meta.dirname, "fixtures", "muninn-meeting.md"), "utf8");
const SRC = "/Users/test/Meetings/2026-11-20 0930 Launch sync.md";

describe("parseMuninnNote", () => {
  it("reads the frontmatter fields Muninn writes", () => {
    const n = parseMuninnNote(SAMPLE);
    expect(n.id).toBe("2026-11-20-0930-launch-sync");
    expect(n.kind).toBe("meeting");
    expect(n.title).toBe("Launch sync");
    expect(n.date).toBe("2026-11-20T09:30:00+01:00");
    expect(n.durationMin).toBe(25);
    expect(n.people).toEqual(["Ja", "Oni"]);
    expect(n.project).toBeNull();
    expect(n.language).toBe("sr");
    expect(n.body.startsWith("\n# Launch sync")).toBe(true);
  });

  it("refuses a file without frontmatter", () => {
    expect(() => parseMuninnNote("# just a note\n")).toThrow(/no YAML frontmatter/);
  });

  it("refuses a note without muninn: 1", () => {
    expect(() => parseMuninnNote("---\nid: x\n---\nbody\n")).toThrow(/no `muninn: 1`/);
    expect(() => parseMuninnNote("---\nmuninn: 2\nid: x\n---\nbody\n")).toThrow(/version: muninn: 2/);
  });

  it("refuses a missing or unsafe id", () => {
    expect(() => parseMuninnNote("---\nmuninn: 1\n---\nbody\n")).toThrow(/no frontmatter `id`/);
    expect(() => parseMuninnNote('---\nmuninn: 1\nid: "../../etc"\n---\n')).toThrow(IngestError);
    expect(() => parseMuninnNote("---\nmuninn: 1\nid: a/b\n---\n")).toThrow(/path separator/);
  });

  it("accepts CRLF line endings and falls back to the id for a missing title", () => {
    const n = parseMuninnNote("---\r\nmuninn: 1\r\nid: idea-1\r\nkind: idea\r\n---\r\nBody\r\n");
    expect(n.title).toBe("idea-1");
    expect(n.kind).toBe("idea");
  });
});

describe("stripTranscript", () => {
  it("drops the collapsed Transkript callout and keeps everything before it", () => {
    const { body, stripped } = stripTranscript(parseMuninnNote(SAMPLE).body);
    expect(stripped).toBe(true);
    expect(body).not.toContain("Transkript");
    expect(body).not.toContain("transkriptreč");
    expect(body).toContain("## Follow-up mejl");
    expect(body.endsWith("lansiranje je u utorak.\n")).toBe(true);
  });

  it("also matches an English Transcript callout, and keeps text after it", () => {
    const { body } = stripTranscript("a\n\n> [!quote]+ Transcript\n> line\n\nafter\n");
    expect(body).toBe("a\n\nafter\n");
  });

  it("leaves a note without a transcript unchanged", () => {
    expect(stripTranscript("## Sažetak\nx\n")).toEqual({ body: "## Sažetak\nx\n", stripped: false });
  });
});

describe("meetingSlug", () => {
  it("keeps a clean id as the file name", () => {
    expect(meetingSlug("2026-11-20-0930-launch-sync")).toBe("2026-11-20-0930-launch-sync");
    expect(meetingRelPath("abc")).toBe("meetings/abc.md");
  });

  it("adds a hash suffix when the id is not a clean slug, so ids can't collide", () => {
    const a = meetingSlug("Sastanak Čeka");
    const b = meetingSlug("sastanak-eka");
    expect(a).toMatch(/^sastanak-eka-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe("buildMeetingNote", () => {
  const note = parseMuninnNote(SAMPLE);

  it("writes meeting frontmatter, a link back to the source, and the summary only", () => {
    const out = buildMeetingNote(note, SRC, "muninn");
    expect(out).toMatch(/^---\ntype: meeting\nsource: muninn\nmuninn_id: "2026-11-20-0930-launch-sync"\n/);
    expect(out).toContain('title: "Launch sync"');
    expect(out).toContain('people: ["Ja", "Oni"]');
    expect(out).not.toContain("project:");
    expect(out).toContain(`source_path: "${SRC}"`);
    expect(out).toContain(
      "Source: [2026-11-20 0930 Launch sync.md](file:///Users/test/Meetings/2026-11-20%200930%20Launch%20sync.md)",
    );
    expect(out).toContain("meeting · 2026-11-20 · 25 min · people: Ja, Oni");
    expect(out).toContain("## Akcije");
    expect(out).not.toContain("Transkript");
    expect(out.match(/^# Launch sync$/gm)).toHaveLength(1);
  });

  it("keeps the transcript when asked", () => {
    expect(buildMeetingNote(note, SRC, "muninn", { withTranscript: true })).toContain("transkriptreč");
  });

  it("is deterministic, so an unchanged re-ingest keeps the stored content", () => {
    expect(buildMeetingNote(note, SRC, "muninn")).toBe(buildMeetingNote(note, SRC, "muninn"));
  });
});

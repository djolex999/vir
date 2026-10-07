import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DROP_PREFIXES, WRAPPER_PREFIXES, stripCodexInjected } from "./inject.js";

// Local-only: built from your own ~/.codex by `npm run fixture:codex` into a
// gitignored dir (it holds real prompts). Skipped where it doesn't exist (CI).
const dir = join(import.meta.dirname, "fixtures");
const messagesPath = join(dir, "user-messages.json");
const headingsPath = join(dir, "known-user-headings.json");
const present = existsSync(messagesPath) && existsSync(headingsPath);

describe.skipIf(!present)("stripCodexInjected over your real Codex messages", () => {
  // Allow-list, not a shape regex: real users write "# Heading" prompts.
  it("never keeps a message that still starts with a known harness/wrapper prefix", () => {
    const messages = JSON.parse(readFileSync(messagesPath, "utf8")) as string[];
    const knownHeadings = JSON.parse(readFileSync(headingsPath, "utf8")) as string[];
    const known = [...DROP_PREFIXES, ...WRAPPER_PREFIXES];
    for (const m of messages) {
      const kept = stripCodexInjected(m);
      if (kept === null) continue;
      const head = kept.trimStart();
      expect(known.some((p) => head.startsWith(p)), head.slice(0, 80)).toBe(false);
      if (/^[#<]/.test(head)) {
        expect(knownHeadings, head.slice(0, 80)).toContain(head.split("\n")[0]);
      }
    }
  });
});

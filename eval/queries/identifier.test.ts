import { describe, expect, it } from "vitest";
import { makeRng } from "../rng.js";
import { buildIdentifierQuery, extractIdentifiers } from "./identifier.js";
import * as idmod from "./identifier.js";

const raw = `---
topic: "x"
---
## Summary
Wire \`recordQueryEvent\` through \`cfg.logQueries\` and set \`QUERY_LOG_MAX_BYTES\`.
Plain words like \`vir\` or \`null\` are not identifiers, nor is \`a\`.
Error text: \`ENOENT: no such file\`. Kebab keys: \`--force-model\`.

\`\`\`ts
const inFence = \`ignoredIdentifier\`;
\`\`\`
Repeated \`recordQueryEvent\` must not duplicate.`;

describe("extractIdentifiers", () => {
  it("keeps camelCase, dotted, SCREAMING_SNAKE and kebab spans; drops plain words and fenced code", () => {
    expect(extractIdentifiers(raw)).toEqual([
      "recordQueryEvent",
      "cfg.logQueries",
      "QUERY_LOG_MAX_BYTES",
      "--force-model",
    ]);
  });

  it("returns [] for a note without inline code", () => {
    expect(extractIdentifiers("# Title\n\nJust prose here.")).toEqual([]);
  });
});

describe("buildIdentifierQuery", () => {
  it("joins one or two distinct identifiers, deterministic per seed", () => {
    const ids = ["recordQueryEvent", "cfg.logQueries", "QUERY_LOG_MAX_BYTES"];
    const a = buildIdentifierQuery(ids, makeRng(3));
    const b = buildIdentifierQuery(ids, makeRng(3));
    expect(a).toBe(b);
    if (a === null) throw new Error("expected an identifier query");
    const parts = a.split(" ");
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(parts.length).toBeLessThanOrEqual(2);
    expect(new Set(parts).size).toBe(parts.length);
    for (const p of parts) expect(ids).toContain(p);
  });

  it("returns null when the note has no identifiers", () => {
    expect(buildIdentifierQuery([], makeRng(1))).toBeNull();
  });
});

describe("pickIdentifierQuery", () => {
  // df over retriever tokens in a 100-doc corpus. "context" and "sync" are
  // everywhere (a skill name); "logqueries" is in 2 docs; "cfg" in 60.
  const df = (t: string): number =>
    ({ context: 80, sync: 70, cfg: 60, logqueries: 2, recordqueryevent: 1 })[t] ?? 0;

  it("keeps only identifiers with at least one corpus-rare token and skips used ones", () => {
    const { pickIdentifierQuery } = idmod;
    const q = pickIdentifierQuery(
      ["context-sync", "cfg.logQueries", "recordQueryEvent"],
      df,
      100,
      0.05,
      new Set(["recordQueryEvent"]),
      makeRng(1),
    );
    expect(q).toBe("cfg.logQueries");
  });

  it("returns null when nothing rare and unused remains", () => {
    const { pickIdentifierQuery } = idmod;
    expect(
      pickIdentifierQuery(["context-sync"], df, 100, 0.05, new Set(), makeRng(1)),
    ).toBeNull();
  });
});

# Verification of code-audit-2026-07.md — 2026-07-07

Independent re-check: every claim re-verified by opening the cited files at
HEAD (v0.11.1), not by trusting the audit agents. Verdict per claim with
quoted evidence. **Result: 13/13 CONFIRMED, 0 FALSE, 0 PARTIAL.**

Severity scale: trivial / low / medium / high. Phase refers to
`tasks/vir-roadmap-2026-07.md`.

| # | Claim | Verdict | Evidence (quoted from source) | Severity → Phase |
|---|---|---|---|---|
| 1 | Structure tree omits `src/cli/` (dir), `output/json.ts`, `embeddingSweep.ts`, `pdfReader.ts`, `pdfDistiller.ts`, `periodSummary.ts` | **CONFIRMED** | All exist on disk (`ls src/cli/` → `reconcile.ts review.ts runAction.ts` + tests; `ls src/output/` → `json.ts`; all four pipeline files present). Grep of the CLAUDE.md Structure section (`## Structure` → `## Key conventions`) for `cli/\|output/\|json.ts\|embeddingSweep\|pdfReader\|pdfDistiller\|periodSummary`: **no matches**. | low → Phase 0 byproduct (fix while exporting the architecture chapter) / Phase 2 |
| 2 | Undocumented CLI surfaces: `vir calibrate`, `query --json`, `query --limit`, `doctor --json` | **CONFIRMED** | `cli.ts:280` `.command("calibrate <sessionId>")`; under `.command("query <question>")`: `cli.ts:1025` `.option("--json", "Emit machine-readable JSON…")`, `cli.ts:1026` `.option("--limit <n>", "Number of notes to retrieve", "8")`; under `.command("doctor")`: `cli.ts:1279` `.option("--json", …)`. Grep of CLAUDE.md Commands section for `calibrate\|query.*json\|doctor.*json`: **no matches**. | low-medium (`query --json` is the plugin's contract and invisible in docs) → Phase 2 |
| 3 | Commands says reconcile targets "pre-0.8.0"; code + conventions say pre-0.7.2 | **CONFIRMED** | `CLAUDE.md:537` "report sessions that silently failed **pre-0.8.0**" vs `cli.ts:1254` "Retry sessions that silently failed **pre-0.7.2**" and `CLAUDE.md:476` "the **pre-0.7.2** Kie-200 silent-failure shape" (also `reconcile.ts:33`). | trivial → Phase 2 |
| 4 | `vir mcp` help lists 5 tools; server registers 6 | **CONFIRMED** | Help string (`cli.ts` ~1295–1306) lists exactly `vir_query, vir_status, vir_recent_notes, vir_recent_articles, vir_project_summary` — no `vir_compose`. `mcp/server.ts` has six `server.registerTool(` calls: lines 219, 314, 372, 456, 521, 566. | trivial → Phase 2 |
| 5 | CLI emits `project` as `string \| null` / `date` as always-`string`; plugin types both optional | **CONFIRMED** | CLI `output/json.ts:25` `project: string \| null;`, `:26` `date: string;`; emitter `:147` `project: fm.project && fm.project.length > 0 ? fm.project : null,`, `:148` `date: fm.date ?? "",` — keys always assigned. Plugin `types.ts:18` `project?: string;`, `:19` `date?: string;`. The `null`-vs-`string\|undefined` mismatch is real; the `?` describes wire cases that never occur. | medium → Phase 2 (shared type source, item 2) |
| 6 | Plugin parses with bare `JSON.parse(stdout) as T`, no runtime validation | **CONFIRMED** | `vir-client.ts:127–135`: `private parse<T>(stdout: string): T { … parsed = JSON.parse(stdout); … return parsed as T; }` — try/catch guards malformed JSON only; zero shape/enum checks. Used by `query()` at `:63–68` (`["query", "--json", "--limit", …]`). | medium → Phase 2 (same item) |
| 7 | Category enums IN SYNC — both include `topic` + `pdf` (prior drift note stale) | **CONFIRMED** | CLI `json.ts:10–17` `VirQueryCategory = "pattern"\|"gotcha"\|"decision"\|"tool"\|"article"\|"topic"\|"pdf"`; plugin `types.ts:1–8` `VirCategory` — identical 7 members, same order. The roadmap's "plugin enum has no topic member" line is stale and should be discounted. | none (correct the roadmap wording) |
| 8 | Prose/transcript split has a DIRECT test | **CONFIRMED** | `parser.test.ts:24` `it("emits tool_use and tool_result into transcriptText, not prose")` — positive: `:60–63` `expect(parsed.transcriptText).toContain("[tool_use: Bash]")` etc.; negative: `:66–69` `expect(parsed.assistantText).not.toContain("[tool_use")`, same for `userText`/`rawSummary`. | none — thesis eval cites it as the positive example |
| 9 | Idempotency-by-hash: DIRECT for PDFs only; NONE for sessions/articles | **CONFIRMED** | Full-suite grep for `isProcessed\|isArticleProcessed\|isPdfProcessed\|hashFile\|sha256\|createHash` in `*.test.ts` hits ONLY `pdfStore.test.ts:51–55,88` (`isPdfProcessed` hash gating) and `pdfReader.test.ts:50` (PDF sha256). Zero tests reference session `isProcessed` or `isArticleProcessed`. | medium → thesis-eval raw material + Phase 2 |
| 10 | Cost chokepoint: `callLLM` mocked everywhere; record-once/no-double-count never asserted | **CONFIRMED** | Grep for `appendCostRecord\|recordCost` in `*.test.ts`: **zero hits**. `callLLM` appears only as `vi.fn(` mocks (`composer.test.ts:31`, `periodSummary.test.ts:32`). Closest test, `periodSummary.test.ts:344–350`, asserts only `toHaveBeenCalledTimes(1)` with a cost context on the mock — the real recording path (`distiller.ts`) never executes under test. | medium → Phase 2; state as a caveat in the thesis implementation chapter |
| 11 | Per-session fault isolation: NO test | **CONFIRMED** | `run.test.ts` is 38 lines, sole describe: `estimatePerDocDistillCost` (`:15–25`). All other `errored` grep hits are embeddingSweep target-selector tests (`embeddingSweep.test.ts:99,156,182`) and reconcile shape tests (`reconcile.test.ts:24`) — none drive the session loop with a throwing distill. | medium-high (the "daemon never dies" claim is vir's flagship reliability invariant) → Phase 2 |
| 12 | Copyright bound: NO test | **CONFIRMED** | Grep for `verbatim\|copyright\|15 consecutive\|consecutive words` in `*.test.ts`: **zero hits**. Clause exists only in source prompts: `articleDistiller.ts:109` "COPYRIGHT — strict: never reproduce more than 15 consecutive words verbatim", `pdfDistiller.ts:110`. | low (string-contains prompt guard is a cheap direct test) → Phase 2 |
| 13 | Exactly one TODO in src/ (`cost/pricing.ts:22`); zero FIXME/HACK/XXX | **CONFIRMED** | Full grep `\b(TODO\|FIXME\|HACK\|XXX)\b` over `src/**/*.ts` (tests included): only `pricing.ts:20` (prose *quoting* the marker inside an explanatory comment — not actionable) and `pricing.ts:22` `// TODO(pricing): refresh against https://kie.ai/pricing`. | trivial → Phase 2 housekeeping (re-check Kie rates) |

## What to act on (all real, none Phase 0 except as noted)

- **Nothing here blocks the thesis month.** Items 8–12 are *raw material* for
  the thesis implementation/eval chapters (which invariants are test-enforced
  vs convention-enforced) — cite them, don't fix them now. Item 1 fixes itself
  as a byproduct of exporting the architecture chapter to `docs/`.
- **Phase 2, in priority order:** fault-isolation test (11), shared
  `VirQueryResult` type + runtime validation (5+6), cost-chokepoint direct
  test (10), session/article idempotency tests (9), docs sync (1–4),
  copyright prompt guard (12), pricing TODO (13).
- **Discard from the roadmap:** the "plugin enum has no `topic` member" claim
  (7) — already fixed in plugin 0.1.2+; the enums are byte-identical today.

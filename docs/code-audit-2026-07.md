# Code audit — 2026-07-07

Read-only audit pass against v0.11.1 (HEAD, tree clean). No code changed.
Scope: (1) CLAUDE.md vs code drift, (2) the `VirQueryResult` CLI/plugin drift,
(3) test coverage on the documented invariants, (4) aged TODO markers.
Feeds the thesis implementation chapter. Companion to `audit-2026-06-12.md`.

---

## 1. CLAUDE.md vs code

### 1a. Structure tree — 6 real files omitted

All six are referenced in the Key-conventions prose but never appear in the
Structure tree itself; a reader navigating by the tree won't find them.

| Missing from tree | Actual location | Holds |
|---|---|---|
| `cli/runAction.ts` | `src/cli/runAction.ts` | the error chokepoint every `.action()` wires through |
| `cli/review.ts` | `src/cli/review.ts` | `vir review` verdict stamping |
| `cli/reconcile.ts` | `src/cli/reconcile.ts` | `selectReconcileTargets` + recovery command |
| `output/json.ts` | `src/output/json.ts` | `VirQueryResult`, `buildQueryResults`, `errorPayload` — the plugin's wire contract |
| `pipeline/embeddingSweep.ts` | `src/pipeline/embeddingSweep.ts` | `sweepEmbeddings`, `selectArticleEmbeddingTargets`, `selectPdfEmbeddingTargets` |
| `pipeline/pdfReader.ts` / `pipeline/pdfDistiller.ts` / `pipeline/periodSummary.ts` | `src/pipeline/` | the entire 0.10.0/0.11.0 feature set (prose-only) |

No phantom entries: every path that IS in the tree resolves to a real file.

### 1b. Commands section — 4 undocumented surfaces + 1 contradiction

| Divergence | Code | Doc |
|---|---|---|
| `vir calibrate <sessionId>` — whole command undocumented | `cli.ts:280–340` (`--model haiku\|sonnet`, default sonnet; distills one session to stdout, no vault/DB write) | absent |
| `vir query --json` undocumented | `cli.ts:1025` (+ `runQueryJson`, `cli.ts:987`) — the flag the Obsidian plugin depends on | absent |
| `vir query --limit <n>` undocumented | `cli.ts:1026`, default `8` | absent |
| `vir doctor --json` undocumented | `cli.ts:1279` | absent |
| `vir reconcile` version label | code + Key conventions both say sessions that silently failed **pre-0.7.2** (`cli.ts:1254`) | Commands line says **pre-0.8.0** — contradicts the code AND the doc's own conventions section |

No documented-but-unimplemented commands. Spot-checked defaults all correct
(`cost --since 7d` / `--top 5`, `compose --limit 20` max 50, `review --limit
50`, `mcp install --scope user`).

Adjacent code-side staleness (doc is right, code is stale): `vir mcp` help
text (`cli.ts:1301–1306`) advertises 5 tools and omits `vir_compose`; the
server exposes 6.

### 1c. Named symbols — no drift

All 12 spot-checked symbols exist as described (`selectDistillModel`
distiller.ts:91, `selectReconcileTargets` reconcile.ts:36,
`selectArticleEmbeddingTargets` / `selectPdfEmbeddingTargets`
embeddingSweep.ts:52/69, `composeLookup` server.ts:163, `buildSummaryPrompt`
summarizer.ts:114 (reused by `buildPeriodPrompt` periodSummary.ts:142),
`renderThemesLines` writer.ts:564, `preservedThemesBlock` writer.ts:417
(private method, as doc implies), `estimatePerDocDistillCost` run.ts:69,
`runEmbeddingSweep` run.ts:659 (module-local), `KIE_TIMEOUT_MS`
distiller.ts:32 (=120_000), `expandHome` config.ts:152).

---

## 2. The `VirQueryResult` drift — documented, not fixed

**Integration path:** the plugin shells out to `vir query --json --limit N`
(`vir-obsidian/src/vir-client.ts:63–69`). It does NOT use the MCP server —
`mcp/server.ts`'s result shape (`topic`/`category`/`project`/`type`/`url`) is
a separate, incompatible surface and not the plugin's contract.

**The two sources:**

- CLI (producer): `interface VirQueryResult` — `vir/src/output/json.ts:19–27`;
  serializer `buildQueryResults` — `json.ts:131–152`; the object literal at
  `json.ts:141–149` assigns all 7 keys unconditionally, so **every field is
  always present on the wire**. Emitted via `JSON.stringify` at
  `cli.ts:1010–1011`.
- Plugin (consumer): `interface VirQueryResult` —
  `vir-obsidian/src/types.ts:12–20`; parsed by
  `VirClient.parse<VirQueryResult[]>()` at `vir-client.ts:127–135`.

**Field-by-field delta:**

| Field | CLI (as emitted) | Plugin type | Delta |
|---|---|---|---|
| `path` | `string`, always | `string` | match |
| `score` | `number`, always | `number` | match |
| `category` | `VirQueryCategory`, always | `VirCategory` | match — enums identical, 7 members incl. `topic` + `pdf` |
| `confidence` | `number`, always (NaN→0) | `number` | match |
| `preview` | `string`, always | `string` | match |
| `project` | `string \| null` — key always present, value is a string **or literal `null`** (`json.ts:147`) | `project?: string` (`types.ts:18`) | **DRIFT.** Wrong twice: the key is never absent (optionality is fiction) and `null` is not assignable to `string \| undefined` — a real runtime/type mismatch |
| `date` | `string`, always — ISO 8601 or `""` fallback (`json.ts:148`) | `date?: string` (`types.ts:19`) | **DRIFT.** Optional `?` describes a wire case that never occurs |

**Validation mechanism:** bare `JSON.parse(stdout) as T`
(`vir-client.ts:130–134`) — the try/catch guards only malformed JSON; zero
field-presence, type, or enum checks. An out-of-enum `category` degrades
silently to a muted badge (`lib/format.ts:23` `default` case) rather than
erroring.

**Stale prior claims corrected:** the roadmap's "plugin enum has no `topic`
member" is no longer true — both enums contain
`pattern|gotcha|decision|tool|article|topic|pdf`, in the same order. The live
drift is exactly the two mistypings above plus the unchecked cast.

**Same looseness pattern elsewhere (for completeness):** `VirErrorPayload` —
CLI `kind: VirErrorKind` required/closed union (`json.ts:35–38`) vs plugin
`kind?: string` optional/open (`types.ts:39–42`); `VirDoctorResult`
structurally aligned with the same optional-`kind` looseness.

---

## 3. Test coverage on the documented invariants

276 tests, but coverage concentrates on pure helpers. Verdicts (DIRECT = a
test that fails if the invariant breaks):

| Invariant | Verdict | Evidence |
|---|---|---|
| Prose/transcript split | **DIRECT** | `parser.test.ts:24` — asserts tool markers appear in `transcriptText` and NOT in `assistantText`/`userText`/`rawSummary`; plus errored-result and unknown-tool-id cases. Solid. |
| Idempotency-by-hash | **DIRECT for PDFs only** | `pdfStore.test.ts:51` (same path + different hash ⇒ reprocess) and `:85` (idempotent overwrite). **Sessions (`db.isProcessed`, db.ts:284) and articles (`isArticleProcessed`, db.ts:657): NO test.** `hashFile`/sha256 in scanner.ts:11 untested; the session re-distill gate (run.ts:388) untested. |
| Cost chokepoint | **INDIRECT** | `periodSummary.test.ts:344` proves one orchestrator routes through `callLLM` with a cost context — but `callLLM` is mocked everywhere, so real `recordCost`/`appendCostRecord` (distiller.ts:269–332) never runs. Nothing asserts record-once-on-success, no-double-count-on-retry, nothing-on-failure, or that `appendCostRecord` errors are swallowed. |
| Per-session fault isolation | **NONE** | Mechanism exists (run.ts:565–566 per-session try/catch, `summary.errored += 1`, `continue`; article/PDF variants :830/:925) but `run.test.ts` (38 lines) tests only `estimatePerDocDistillCost`. No test drives the loop with a throwing distill. |
| Copyright bound (≤15 verbatim words) | **NONE** | Prompt-enforced (`articleDistiller.ts:109`, `pdfDistiller.ts:110`); no test asserts the prompt even contains the clause. |

What direct tests would assert (for the thesis chapter / future work):

- **Cost:** spy on `appendCostRecord`; stub provider success ⇒ exactly 1
  record after return; retry-then-succeed ⇒ exactly 1; permanent failure ⇒ 0;
  `appendCostRecord` throwing ⇒ `callLLM` still returns.
- **Idempotency (sessions/articles):** mirror the existing PDF test against
  the `sessions`/`articles` tables; plus a `hashFile` byte-flip test.
- **Fault isolation:** pipeline over 2 sessions, one throws ⇒ run returns,
  `errored === 1`, error persisted to DB, second session distilled.
- **Copyright bound:** string-contains guard that the distill prompts carry
  the "15 consecutive words verbatim" clause (behavioral enforcement isn't
  testable without the live model; pinning the prompt is the honest proxy).

---

## 4. Aged TODO/FIXME/HACK markers

v0.8.0 cutoff: tag `v0.8.0` = commit `e254fd1`, **2026-05-28**.

Exactly **one** real marker exists in all of `src/` (none in tests; no
FIXME/HACK/XXX anywhere):

| Location | Marker | Blame date | Pre-0.8.0? |
|---|---|---|---|
| `src/cost/pricing.ts:22` | `TODO(pricing): refresh against https://kie.ai/pricing` | 2026-05-27 (commit `5877ae0`) | Yes — by one day; has survived to v0.11.1 |

(`pricing.ts:20` also greps as TODO but is prose *quoting* the marker inside
an explanatory comment — not an actionable marker.)

---

## Summary for the thesis

The invariants CLAUDE.md documents are real in code (no phantom claims found,
all 12 spot-checked symbols exist), but their *enforcement* is uneven: the
prose/transcript split is properly locked by tests, PDF idempotency is locked,
while the cost chokepoint, session/article idempotency, fault isolation, and
the copyright bound rest on convention + review rather than tests. Docs drift
is real but shallow — omissions and one label contradiction, not
misinformation. The one aged TODO is a pricing-refresh reminder, apt given
the cost-telemetry emphasis. The `VirQueryResult` drift is narrower than
previously recorded (enums are in sync); the residual risk is the plugin's
unchecked `JSON.parse as T` combined with two optionality/nullability
mistypings on `project`/`date`.

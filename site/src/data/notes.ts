export type Category = "pattern" | "gotcha" | "decision" | "tool";

export interface SampleNote {
  category: Category;
  label: string;
  markdown: string;
}

// Hand-written for the site, in the exact shape src/pipeline/writer.ts emits.
// If writer.ts frontmatter changes, these must change with it.
export const NOTES: SampleNote[] = [
  {
    category: "gotcha",
    label: "Gotcha",
    markdown: `---
topic: "Kie.ai returns 200 with an error body"
aliases:
  - "kie-ai-returns-200-with-an-error-body"
category: gotcha
project: "growthq"
session_id: 4f2a9c31
date: 2026-06-01T09:14:22.000Z
confidence: 0.86
themes:
  - kie error handling
  - retry safety
---
Project: [[growthq]]
Category: [[gotcha]]

The Kie.ai image endpoint answers HTTP 200 even when generation fails.
The failure is only visible as \`{ "code": 422, "msg": "..." }\` in the
body. Checking \`res.ok\` alone treats every failure as success and the
job polls forever.

Fix: parse the body first and throw when \`code !== 200\`. Retry only on
\`code\` 5xx — 422 means the prompt was rejected and will be rejected again.

## Related
- [[retry-with-backoff-on-idempotent-writes]]
- [[kie-ai-task-polling-loop]]
`,
  },
  {
    category: "pattern",
    label: "Pattern",
    markdown: `---
topic: "Offline-first writes go through a Dexie outbox"
aliases:
  - "offline-first-writes-go-through-a-dexie-outbox"
category: pattern
project: "vizita"
session_id: 9b17e0d4
date: 2026-05-19T14:02:08.000Z
confidence: 0.91
themes:
  - offline sync
  - conflict handling
---
Project: [[vizita]]
Category: [[pattern]]

Every mutation is appended to an \`outbox\` table before it touches the UI
state. A single sync worker drains the outbox in order, marks rows as
\`sent\`, and only deletes them once the server acknowledges.

Because the outbox is the source of truth for pending work, a reload
mid-sync loses nothing — the worker just resumes from the first unsent row.

## Related
- [[dexie-schema-versioning]]
- [[last-write-wins-is-fine-for-field-surveys]]
`,
  },
  {
    category: "decision",
    label: "Decision",
    markdown: `---
topic: "Refresh tokens live in an httpOnly cookie, not localStorage"
aliases:
  - "refresh-tokens-live-in-an-httponly-cookie-not-localstorage"
category: decision
project: "growthq"
session_id: c3d8a5f2
date: 2026-04-27T20:41:55.000Z
confidence: 0.94
themes:
  - auth
  - xss surface
---
Project: [[growthq]]
Category: [[decision]]

Decided: access token in memory, refresh token in an \`httpOnly; Secure;
SameSite=Strict\` cookie scoped to \`/auth/refresh\`.

Rejected: refresh token in localStorage. One XSS anywhere in the React
bundle would hand over a long-lived credential. The cookie path scope
means it is never sent with ordinary API calls, so CSRF exposure is limited
to the one refresh route, which checks an \`Origin\` header.

## Related
- [[jwt-access-token-15-minute-ttl]]
- [[axios-interceptor-single-flight-refresh]]
`,
  },
  {
    category: "tool",
    label: "Tool",
    markdown: `---
topic: "Ollama bge-m3 for local embeddings"
aliases:
  - "ollama-bge-m3-for-local-embeddings"
category: tool
project: "vir"
session_id: 71ac4e9b
date: 2026-07-08T11:23:40.000Z
confidence: 0.88
themes:
  - embeddings
  - local-first
---
Project: [[vir]]
Category: [[tool]]

\`ollama pull bge-m3\` gives a 1024-dim multilingual model that runs fine
on an M-series laptop. Cosine similarity between distilled notes lands
around 0.55–0.75 for genuinely related topics; the threshold that keeps
the Related section useful is 0.62.

When Ollama is down the writer skips the embedding and a later run
back-fills it — never block a note on the vector.

## Related
- [[tf-idf-fallback-when-no-embedding-provider]]
- [[per-model-similarity-thresholds]]
`,
  },
];

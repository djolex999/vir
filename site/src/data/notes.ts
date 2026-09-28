export type Category = "pattern" | "gotcha" | "decision" | "tool";

export interface SampleNote {
  category: Category;
  label: string;
  markdown: string;
}

// Hand-written for the site, in the exact shape src/pipeline/writer.ts emits.
// If writer.ts frontmatter or the distiller's section headings change, these
// must change with it.
export const NOTES: SampleNote[] = [
  {
    category: "gotcha",
    label: "Gotcha",
    markdown: `---
topic: "kie-200-error-body"
aliases:
  - "kie-200-error-body"
category: gotcha
project: "growthq"
session_id: 4f2a9c31-7d0e-4b8a-9c55-1e2f3a4b5c6d
date: 2026-06-01T09:14:22.000Z
confidence: 0.86
themes:
  - "kie-error-handling"
  - "retry-safety"
branches:
  - "fix/blank-posts"
---
Project: [[growthq]]
Category: [[gotcha]]

## Summary

This session debugged blank posts in growthq's image pipeline. The Kie.ai endpoint answers HTTP 200 even when generation fails: the error is only visible as \`{ "code": 422, "msg": "..." }\` in the body, so \`res.ok\` treats every failure as success and the job polls forever.

## What Was Learned

- **Check the body's \`code\`, not the HTTP status.** The client now throws when \`code !== 200\` before trusting \`res.ok\`.
- **Retry only on \`code\` 5xx.** 422 means the prompt was rejected and will be rejected again.

## Context

The generation queue had been producing blank posts for two days.

## Related

- [[retry-with-backoff-0c91be7a|retry-with-backoff]]
- [[kie-ai-task-polling-loop-a83e21f0|kie-ai-task-polling-loop]]
`,
  },
  {
    category: "pattern",
    label: "Pattern",
    markdown: `---
topic: "dexie-outbox-for-offline-writes"
aliases:
  - "dexie-outbox-for-offline-writes"
category: pattern
project: "vizita"
session_id: 9b17e0d4-2c6a-4f1b-8e3d-5a7b9c0d1e2f
date: 2026-05-19T14:02:08.000Z
confidence: 0.91
themes:
  - "offline-sync"
  - "conflict-handling"
branches:
  - "main"
---
Project: [[vizita]]
Category: [[pattern]]

## Summary

This session made vizita's field-survey writes survive a dropped connection. Every mutation is appended to a Dexie \`outbox\` table before it touches UI state, and one sync worker drains it in order.

## What Was Learned

- **The outbox is the source of truth for pending work.** Rows are marked \`sent\` and deleted only once the server acknowledges, so a reload mid-sync loses nothing: the worker resumes from the first unsent row.
- **One worker, in order.** Chosen over parallel sends, which reordered edits to the same record.

## Context

Surveyors work in basements with no signal for hours at a time.

## Related

- [[dexie-schema-versioning-3f9a1c77|dexie-schema-versioning]]
- [[last-write-wins-for-field-surveys-b2d40e19|last-write-wins-for-field-surveys]]
`,
  },
  {
    category: "decision",
    label: "Decision",
    markdown: `---
topic: "refresh-token-in-httponly-cookie"
aliases:
  - "refresh-token-in-httponly-cookie"
category: decision
project: "growthq"
session_id: c3d8a5f2-9e1b-4d7c-a6f0-3b8e2d1c4a95
date: 2026-04-27T20:41:55.000Z
confidence: 0.94
themes:
  - "auth"
  - "xss-surface"
branches:
  - "feat/refresh-tokens"
---
Project: [[growthq]]
Category: [[decision]]

## Summary

This session moved growthq's auth to short-lived access tokens. The access token lives in memory; the refresh token lives in an \`httpOnly; Secure; SameSite=Strict\` cookie scoped to \`/auth/refresh\`.

## What Was Learned

- **Chosen over localStorage.** One XSS anywhere in the React bundle would hand over a long-lived credential.
- **The path scope limits CSRF to one route.** The cookie is never sent with ordinary API calls, and \`/auth/refresh\` checks the \`Origin\` header.

## Context

Access tokens were moving to a 15-minute TTL, which made refresh a hot path.

## Related

- [[jwt-access-token-15-minute-ttl-7e2b90c4|jwt-access-token-15-minute-ttl]]
- [[axios-single-flight-refresh-d51a6e38|axios-single-flight-refresh]]
`,
  },
  {
    category: "tool",
    label: "Tool",
    markdown: `---
topic: "ollama-bge-m3-local-embeddings"
aliases:
  - "ollama-bge-m3-local-embeddings"
category: tool
project: "vir"
session_id: 71ac4e9b-5d3f-4a2e-b8c1-6f9e0a7d2b43
date: 2026-07-08T11:23:40.000Z
confidence: 0.88
themes:
  - "embeddings"
  - "local-first"
branches:
  - "main"
---
Project: [[vir]]
Category: [[tool]]

## Summary

This session set up local embeddings for vir's Related sections. \`ollama pull bge-m3\` gives a 1024-dim multilingual model that runs fine on an M-series laptop.

## What Was Learned

- **0.62 is the useful cutoff.** Cosine similarity between genuinely related notes lands around 0.55–0.75; below 0.62 the Related links turn into noise.
- **Never block a note on the vector.** When Ollama is down the writer skips the embedding and a later run back-fills it.

## Context

The TF-IDF fallback linked notes that shared words, not ideas.

## Related

- [[tf-idf-fallback-without-embeddings-0d4c8b21|tf-idf-fallback-without-embeddings]]
- [[per-model-similarity-thresholds-9a7f3e65|per-model-similarity-thresholds]]
`,
  },
];

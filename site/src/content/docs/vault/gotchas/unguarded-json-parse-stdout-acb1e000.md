---
title: "unguarded-json-parse-stdout"
description: "Gotcha distilled by vir from a Claude Code session on 2026-05-27. The developer investigated a potential security vulnerability in the `vir` project's search/retrieval pipeline. They tra"
editUrl: false
---

:::note[Written by vir, not by a human]
**Gotcha** · session `acb1e000` · 2026-05-27 · classifier confidence 0.85
:::

## Summary

The developer investigated a potential security vulnerability in the `vir` project's search/retrieval pipeline. They traced how `filePath` values are constructed in embedding rows—sourced from user-controlled vault roots and article note paths—and verified that the search code path contains no stdout writes that would corrupt JSON parsing contracts.

## What Was Learned

1. **filePath Construction**: The `filePath` field in `EmbeddingRow` objects is built server-side from two sources:
   - Session embeddings: `${vaultRoot}/${dir}/${slug}-${suffix}.md` (where `vaultRoot` is user-provided)
   - Article embeddings: `note_path` from the articles table (database-sourced)

2. **No Stdout Pollution**: A grep across `~/projects/vir/src/search/` confirmed zero `console.log`, `console.info`, `console.warn`, `console.error`, or `process.stdout.write` calls, meaning the JSON output stream is guaranteed unguarded.

3. **Data Flow**: Embedding rows from `getEmbeddings()` and `getArticleEmbeddings()` are concatenated by the retriever and consumed downstream, likely by plugins that deserialize the `filePath` field.

## Context

- **Project**: vir
- **Category**: gotcha
- **Date**: 2026-05-27T18:55:32.189Z
- **Files Inspected**: `json.ts`, `retriever.ts`, `cli.ts`, `doctor.ts`, `db.ts`, `search/` directory

## Related

- json-output-contract
- [search-result-filtering](/vault/gotchas/search-result-filtering-01e12b99/)
- [parser-fallback-robustness](/vault/decisions/parser-fallback-robustness-67301cf4/)
- untyped-json-parsing
- [json-output-contract](/vault/decisions/json-output-contract-7bcca3cb/)

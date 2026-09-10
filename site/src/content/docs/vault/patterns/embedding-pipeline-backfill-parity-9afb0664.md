---
title: "embedding-pipeline-backfill-parity"
description: "Pattern distilled by vir from a Claude Code session on 2026-06-26. The session reviewed security implications of a new `vir_compose` MCP tool and article embedding pipeline additions. The"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `9afb0664` · 2026-06-26 · classifier confidence 0.92
:::

## Summary

The session reviewed security implications of a new `vir_compose` MCP tool and article embedding pipeline additions. The analysis traced user-controlled topic strings through slug generation, filesystem writes, and SQL operations, confirming no path-traversal, injection, or information-disclosure vulnerabilities.

## What Was Learned

**Slug generation pattern:** The `kebab()` function safely neutralizes path-traversal attempts by collapsing all non-alphanumeric characters to hyphens, then enforcing a 60-character limit. This makes `../../etc/passwd` → `-etc-passwd`, eliminating directory traversal even before the constraint to a topics subdirectory.

**Safe sink verification:** SQL operations use parameterized queries with `?` placeholders for both embedding vectors and file paths, preventing injection. The article embedding sweep correctly mirrors existing content-validity gates (non-null, non-empty, no prior errors) from the baseline query.

**Read-only invariant preservation:** The MCP server deliberately returns a pointer to topic composition rather than executing synthesis, maintaining the read-only constraint of the MCP interface.

**Differential testing consideration:** New code paths (article sweep, embedding storage) use identical filtering criteria to existing paths, avoiding validator divergence that could leak unvalidated data.

## Context

- **Project:** vir
- **Category:** pattern
- **Date:** 2026-06-26T00:59:13.106Z
- **Focus:** Security audit of `vir_compose` tool and article embedding pipeline

## Related

- [mirrored-sweep-for-new-entity-type](/vault/patterns/mirrored-sweep-for-new-entity-type-7415aa64/)
- [sanitization-alone-insufficient-for-path-safety](/vault/gotchas/sanitization-alone-insufficient-for-path-safety-3a425d11/)
- [llm-wiki-ingestion](/vault/patterns/llm-wiki-ingestion-0393252f/)
- [unguarded-json-parse-stdout](/vault/gotchas/unguarded-json-parse-stdout-acb1e000/)
- [parser-fallback-robustness](/vault/decisions/parser-fallback-robustness-67301cf4/)

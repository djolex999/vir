---
title: "sanitization-alone-insufficient-for-path-safety"
description: "Gotcha distilled by vir from a Claude Code session on 2026-06-26. The `vir` project added a new MCP tool `vir_compose` that generates topic pages from synthesized notes. A security revie"
editUrl: false
---

:::note[Written by vir, not by a human]
**Gotcha** · session `3a425d11` · 2026-06-26 · classifier confidence 0.72
:::

## Summary

The `vir` project added a new MCP tool `vir_compose` that generates topic pages from synthesized notes. A security review traced all data flows from entry points through transformations (slug generation via kebab-casing, path construction, database operations) to sinks, confirming that user-supplied topic strings are sanitized to `[a-z0-9-]+` patterns and cannot reach dangerous code paths (file traversal, SQL injection, shell injection, or sensitive data leaks).

## What Was Learned

**Slug generation as a sanitization boundary:** The `composeSlug()` function applies kebab-casing (lowercase, non-alphanumeric → hyphens, trim, 60-char limit, fallback to `"topic"`) to neutralize path traversal. This is sufficient for preventing `..`, `/`, and NUL injection when constructing file paths.

**Data flow containment in read-only contexts:** The MCP server operates in read-only mode and uses parameterized SQL queries for the article embedding backfill loop. Topic strings are reflected only in JSON error messages returned to the client that supplied them—not interpolated into logs, shells, or unsafe sinks.

**Verification scope:** Security review should cover entry points (MCP tool inputs, config fields), transformations (kebab-casing, path join), and sinks (file reads, SQL queries, error responses). Absence of new parsers, validators, allowlist edits, auth changes, or CI triggers reduces differential risk.

## Context

**Project:** vir  
**Category:** gotcha  
**Date:** 2026-06-26T00:58:29.516Z

## Related

- [embedding-pipeline-backfill-parity](/vault/patterns/embedding-pipeline-backfill-parity-9afb0664/)
- [unguarded-json-parse-stdout](/vault/gotchas/unguarded-json-parse-stdout-acb1e000/)
- [error-handling-refactor](/vault/decisions/error-handling-refactor-daa71c94/)
- trailing-path-delimiter-cwd-search
- argument-injection-no-separator

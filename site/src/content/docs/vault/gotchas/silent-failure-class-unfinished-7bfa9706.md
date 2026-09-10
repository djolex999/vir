---
title: "silent-failure class unfinished"
description: "Gotcha distilled by vir from a Claude Code session on 2026-06-12. The vir CLI is a TypeScript daemon that extracts durable knowledge from Claude Code transcripts into an Obsidian vault,"
editUrl: false
---

:::note[Written by vir, not by a human]
**Gotcha** · session `7bfa9706` · 2026-06-12 · classifier confidence 0.92
:::

## Summary

The vir CLI is a TypeScript daemon that extracts durable knowledge from Claude Code transcripts into an Obsidian vault, with hybrid LLM routing, embedding-based search, and a read-only MCP interface. The audit identified four instances of the silent-failure class (NULL embeddings), untested side-effectful modules (especially the CLAUDE.md rewriter), and ~30 console.log violations of the display-monopoly convention.

## What Was Learned

**Architecture & Data Flow:**
- Pipeline is well-orchestrated (per-session try/catch isolation prevents daemon crashes from single bad transcripts)
- Scrubber runs early and completely (secrets/paths/emails stripped before distill/write/DB)
- Three distinct output targets: vault notes (wikilinked + indexed), topics (synthesized via embeddings), and CLAUDE.md sync blocks
- Search layer supports graceful degradation (embeddings → TF-IDF fallback when Ollama is down)
- MCP server is genuinely read-only (readonly mode on StateDb, no mutation endpoints)

**Security Posture:**
- All SQL parameterized (better-sqlite3 prepared statements, zero interpolation)
- All subprocess calls use arg arrays (launchd, systemd, cron, osascript all properly escaped)
- All outbound fetch calls have explicit timeouts (Kie 120s, Ollama 10s+3s ping, doctor 15s)
- Config file healing (chmod 0600 on load) prevents credential exposure
- Cost log only records metadata (never raw content or API keys)
- Plugin wire contract is defensive (safe parse, category color fallbacks)

**Debt & Gaps:**
1. **Articles NULL-embedding blind spot** — `embeddingSweep.ts` covers sessions+topics but not articles; `maybeEmbedArticle` at write-time has no retry path when Ollama is down (fourth instance of the silent-failure class)
2. **Untested side-effectful modules** — `updater.ts` (CLAUDE.md VIR:START/END rewriter), `daemon/*.ts`, `lint/linter.ts`, `dedupe/merger.ts`, `mcp/server.ts` total ~2,000 lines with zero unit tests
3. **console.log violations** — ~30 call sites in cli.ts (calibrate, dedupe, lint, summarize, query, compose, renderKnowledge) + writer.ts:362 violate the display.ts monopoly
4. **Wire-contract drift** — plugin's `VirQueryResult.date` and `.project` are optional; CLI always sends them (low practical risk due to defensive parsing, but the plugin's bare `JSON.parse(...) as T` cast has no runtime shape check)
5. **Preflight visibility** — `listEmbeddingTargets()` at run.ts:249 counts sessions+topics only, missing articles with NULL embeddings

**Known Mitigations Already in Place:**
- Heuristic filter drops ~50% of transcripts before any LLM call (saves cost + latency)
- Embedding self-heal sweep for sessions/topics (but not articles)
- Retry logic with exponential backoff on transient errors
- Hash-based idempotency (per-file SHA-256 prevents re-processing)
- Best-effort embed (write doesn't fail if embedding is down)
- Review verdicts preserved on every note rewrite

## Context

**Project:** vir  
**Category:** gotcha  
**Date:** 2026-06-12T16:53:51.752Z  
**Current State:** v0.8.3 on npm (184 tests, all passing); vir-obsidian v0.1.3 locally (v0.1.2 shipped to marketplace); three silent-failure classes fixed, fourth identified; daemon lifecycle & CLAUDE.md mutation untested; console.log sweep pending

## Related

- [exit-code-propagation-strategy](/vault/decisions/exit-code-propagation-strategy-1d4fa0af/)
- [fetch-timeout-safety](/vault/patterns/fetch-timeout-safety-2140b459/)
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- [parser-fallback-robustness](/vault/decisions/parser-fallback-robustness-67301cf4/)
- security-audit-patch

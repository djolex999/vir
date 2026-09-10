---
title: "timeout-abort-safety"
description: "Pattern distilled by vir from a Claude Code session on 2026-05-29. A Claude Code session analyzed security implications of adding an AbortController-based timeout mechanism to `callKie`,"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `cb814268` · 2026-05-29 · classifier confidence 0.92
:::

## Summary

A Claude Code session analyzed security implications of adding an AbortController-based timeout mechanism to `callKie`, a TypeScript function that wraps LLM API requests. The change introduces `KieTimeoutError`, marks it as retryable, and exports `callKie` for testing. No security vulnerabilities were identified; the timeout is self-initiated and cannot be exploited by attackers.

## What Was Learned

**Timeout Implementation Pattern:**
- Use `AbortController` with a timer to enforce client-side request deadlines without blocking event loops
- Clear the timer in a `finally` block to prevent resource leaks
- Distinguish between genuine network errors (abort signal false) and self-initiated aborts (signal true)

**Error Classification for Retry Logic:**
- Classify timeout errors as retryable to enable exponential backoff (60/120/240s intervals)
- Exclude sensitive data (credentials, URLs, PII) from error messages; use only numeric values
- Return opaque status strings (`"?"`) for custom error types in observability sinks to avoid information leakage

**Security Analysis of Dependency Injection:**
- Widening an export surface (e.g., `callKie`) for test purposes is safe if no production caller uses the injection point
- Verify that new optional parameters (`fetchImpl`, `timeoutMs`) are not passed from higher-level functions
- Confirm that attacker-controllable values (request payloads, headers) do not flow into new sinks

**Resource-Bound Placement:**
- Clear timers after response headers arrive, before body read operations, to catch slow-write upstream issues
- Accept reliability tail cases (slow-body stalls) when the endpoint is hardcoded and attacker-controlled hosts are impossible

## Context

**Project:** vir  
**Category:** pattern  
**Date:** 2026-05-29T14:45:51.032Z  

Files examined: `src/pipeline/distiller.ts`, `src/pipeline/distiller.test.ts`  
Related files using `callKie`/`KieTimeoutError`/`withRateLimitRetry`: 9 modules across pipeline, search, lint, and dedupe packages.

## Related

- [fetch-timeout-safety](/vault/patterns/fetch-timeout-safety-2140b459/)
- [exit-code-propagation-strategy](/vault/decisions/exit-code-propagation-strategy-1d4fa0af/)
- [cost-recording-retry-safety](/vault/patterns/cost-recording-retry-safety-agent-ae/)
- [api-provider-abstraction](/vault/patterns/api-provider-abstraction-ef978932/)
- force-model override injection

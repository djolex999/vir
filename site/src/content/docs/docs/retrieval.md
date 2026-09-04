---
title: Retrieval and MCP
description: Ask the vault from the terminal, or let Claude Code consult it mid-session.
---

## `vir query`

```bash
vir query "how did we handle kie 200 errors"
```

Searches the vault, then synthesizes an answer with cited notes:

```
Kie.ai answers HTTP 200 even when generation fails; the failure only
shows as code 422 in the body. Parse the body first, throw on
code !== 200, and retry only on 5xx.

sources
  gotchas/kie-ai-returns-200-with-an-error-body-4f2a9c31.md
  patterns/retry-with-backoff-on-idempotent-writes-0c91be7a.md
```

`--limit <n>` controls how many notes are retrieved (default 8). `--json` returns the machine-readable form the Obsidian plugin consumes.

Verified notes (approved in `vir review`) get a flat ranking boost. Results are reranked for diversity (MMR, `retrievalDiversity`, default 0.3) so you get five different angles instead of five near-duplicates.

## Search providers

vir works with keyword search (TF-IDF) out of the box — no setup, ever. For semantic search, pick one embedding provider; vir auto-detects whichever is present.

**Local, one command, no Ollama:**

```bash
vir embed --setup   # fastembed + bge-small-en-v1.5 into ~/.vir/embedder
                    # ~360 MB total; states the size and asks first
```

**Or Ollama** (nomic-embed-text, 768 dimensions):

```bash
brew install ollama
ollama pull nomic-embed-text
ollama serve
```

Then `vir embed` once. New notes embed as they're written; a note distilled while the provider was down heals on the next run.

Every stored vector records which model produced it. Vectors from different models are never compared. Switching providers means `vir embed --force`, which tells you the count and estimated time before it starts.

When no provider is available, results say so: `via tfidf (no provider)`.

## MCP: Claude Code asks the vault itself

```bash
vir mcp install
```

Restart Claude Code. The vault is now available mid-session through six read-only tools:

| Tool | What it does |
| --- | --- |
| `vir_query` | Search + synthesize. `type` filter: `session` \| `article` \| `topic` \| `pdf` \| `all`. `verified_only: true` restricts to reviewed notes. |
| `vir_status` | Note counts, categories, daemon state |
| `vir_recent_notes` | Latest session notes |
| `vir_recent_articles` | Latest article notes |
| `vir_project_summary` | The cached `projects/<slug>.md`, or a pointer to `vir summarize` |
| `vir_compose` | The cached `topics/<slug>.md`, or a pointer to `vir compose` |

The server is strictly read-only: it never spends tokens and never writes files. Synthesis that costs money stays behind the CLI.

`vir mcp status` checks registration; `vir mcp uninstall` removes it.

## Retrieval logging

Every query appends one line to `~/.vir/queries.jsonl`: the query text, which notes surfaced at what rank, the search method, and latency. Never the answer. It stays on your machine and exists so `vir queries` can report which notes earn their place and which never surface. Disable with `"logQueries": false`.

---
title: Retrieval and MCP
description: Ask the vault from the terminal, or let Claude Code or Codex consult it mid-session.
---

## `vir query`

```bash
vir query "how did we handle kie 200 errors"
```

Searches the vault, then synthesizes an answer with cited notes:

```
Kie.ai answers HTTP 200 even when generation fails; the
failure only shows as code 422 in the body. Parse the body
first, throw on code !== 200, and retry only on 5xx.

────────────────────────────────────────────────
  · gotchas/kie-200-error-body-4f2a9c31  0.81
  · patterns/retry-with-backoff-0c91be7a  0.64
────────────────────────────────────────────────
sources 2  ·  via embedding  ·  searched 460
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

## MCP: your agent asks the vault itself

```bash
vir mcp install                  # Claude Code: registers via `claude mcp add`
vir mcp install --target codex   # Codex: prints the config block to add
```

For Codex, vir never edits `~/.codex/config.toml`; it prints the `[mcp_servers.vir]` block, or run `codex mcp add vir -- vir mcp`. Codex asks before each tool call ("Always allow" stops the prompts), and headless `codex exec` never approves them. See [Codex](/docs/codex/#let-codex-query-your-notes-mcp).

Restart the agent. The vault is now available mid-session through six read-only tools:

| Tool | What it does |
| --- | --- |
| `vir_query` | Search + synthesize. `type` filter: `session` \| `article` \| `topic` \| `pdf` \| `insight` \| `all`; `category`, `project`, `top_k` (default 5, max 10). `verified_only: true` restricts to reviewed notes. `synthesize: false` returns the matching notes without the LLM call. |
| `vir_status` | Note counts, confidence, categories, per-project breakdown, date range, gaps |
| `vir_recent_notes` | Latest session notes (`limit`, default 10, max 20) |
| `vir_recent_articles` | Latest article notes |
| `vir_project_summary` | The cached `projects/<slug>.md`, or a pointer to `vir summarize` |
| `vir_compose` | The cached `topics/<slug>.md`, or a pointer to `vir compose` |

The server never changes the vault. `vir_query` is the one tool that spends tokens: it synthesizes its answer with `models.distill`, the same small call as `vir query`, and appends to the query log. Its tool description tells the agent the call is billed, and `synthesize: false` skips it. Everything else reads files or caches; the expensive syntheses (`vir compose`, `vir summarize`) stay behind the CLI.

`vir mcp status` checks registration; `vir mcp uninstall` removes it.

`type: insight` returns only [recurring rules](/docs/recurring-rules/) you accepted; proposed and rejected ones are never served, here or in `vir query`. For agents without MCP setup, see [Any agent](/docs/any-agent/).

## Retrieval logging

Every query appends one line to `~/.vir/queries.jsonl`: the query text, which notes surfaced at what rank, the search method, and latency. Never the answer. It stays on your machine and exists so `vir queries` can report which notes earn their place and which never surface. Disable with `"logQueries": false`.

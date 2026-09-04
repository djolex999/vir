---
title: Configuration
description: Every key in ~/.vir/config.json.
---

`vir init` writes `~/.vir/config.json`. Edit it directly for anything the wizard doesn't ask about. Paths accept `~`.

| Key | Default | What it does |
| --- | --- | --- |
| `vaultPath` | *(required)* | Absolute path to the Obsidian vault |
| `outputDir` | `vir` | Folder inside the vault that vir owns |
| `topicsDir` | `topics` | Subfolder for `vir compose` pages |
| `claudeProjectsDir` | `~/.claude/projects` | Where Claude Code keeps transcripts |
| `cadenceHours` | `3` | Daemon interval |
| `provider` | `anthropic` | `anthropic` \| `claude-cli` \| `kie` |
| `anthropicApiKey` | — | Required for `anthropic` |
| `kieApiKey` | — | Required for `kie` |
| `kieTopUpTier` | `standard` | `high` applies Kie's 10% bonus-credit discount to cost records |
| `models.classify` | `claude-haiku-4-5-20251001` | Classify model |
| `models.distill` | `claude-sonnet-5` | Distill model for decisions and large sessions |
| `models.distillFast` | — | Cheaper distill model for routine sessions; set → hybrid routing on |
| `models.distillThreshold` | `100000` | Input tokens above which `distill` is forced |
| `filterThreshold` | `0.4` | Heuristic pre-filter floor, 0–1 |
| `filterToolCalls` | `moderate` | Tool-output trimming before distill: `aggressive` \| `moderate` \| `off` |
| `workflowTranscripts` | `exclude` | Workflow and sidechain transcripts: `exclude` \| `include` |
| `agentTranscripts` | `exclude` | Headless SDK agent transcripts: `exclude` \| `include` |
| `projects` | — | `{ "<name>": "include" \| "exclude" }`. Absent = undecided, a visible state |
| `articlesDir` | — | Folder of clipped articles. Unset = off |
| `distillArticles` | `true` | Gate for the article phase when `articlesDir` is set |
| `pdfsDir` | — | Folder of PDFs. Unset = off (recommended; see Inputs) |
| `distillPdfs` | `true` | Gate for the PDF phase when `pdfsDir` is set |
| `embeddingProvider` | — | `ollama` \| `local` \| `none`. Unset = auto-detect |
| `retrievalDiversity` | `0.3` | MMR diversity weight, 0–1 |
| `logQueries` | `true` | Append retrievals to `~/.vir/queries.jsonl` |
| `notifications` | `true` | Desktop notifications from the daemon |
| `pricing` | built-in | Per-provider `{ "<model>": { "inputPer1M", "outputPer1M" } }` overrides |

Secrets never print in full; `vir doctor` and `vir status` mask them.

## Files vir keeps

```
~/.vir/config.json        configuration
~/.vir/vir.db             SQLite: hashes, content, embeddings, skip reasons
~/.vir/cost.log           one JSONL line per model call
~/.vir/daemon.log         plain-text run log
~/.vir/queries.jsonl      retrieval log, rotates at 5 MB
~/.vir/vir.lock           run lock (pidfile)
~/.vir/embedder/          local embedding provider, if installed
```

---
title: The vault vir wrote about vir
description: Every note vir distilled from the sessions that built it. Not a curated sample — the whole set, including the thin ones.
tableOfContents: false
editUrl: false
---

Every tool in this category asks you to trust that its output is worth reading. Most can't show you, because their memory is a vector store or a YAML file written for a machine.

vir's output is markdown, so here it is: **43 notes vir wrote about vir**, distilled from the Claude Code sessions that built this project. Nothing was written by hand and nothing was picked to flatter the tool. Some of these are sharp. Some are thin, or say the same thing twice because two sessions covered the same ground. That ratio is the honest answer to "is this worth it".

Each page shows the session it came from, the date, and the classifier's confidence — the same frontmatter that sits in the vault, in Obsidian, on my disk.

:::caution[Scope]
Only the `vir` project is public. Notes from client and product work stay private, as do anything the classifier titled as a security finding. This is a subset by design, not a full vault dump.
:::

## What's here

| | |
| --- | --- |
| **Patterns** (17) | Approaches worth repeating — TDD seams, the audit-first workflow, provider abstraction |
| **Decisions** (18) | Architecture calls with the reasoning intact — embedding model trade-offs, cost logging, hybrid routing |
| **Gotchas** (8) | Things that cost time once — silent failures, parsing traps, path handling |

Browse them in the sidebar, or read [how they get written](/docs/how-it-works/) first.

## What to look for

Read three or four and you'll see the shape of the thing:

- **The title is the lesson**, not the topic. That's the classifier picking the most durable takeaway from a session, and it's what makes retrieval land on the right note.
- **`## Related` links are real.** They come from embedding neighbors, not from a model guessing at names it can't see. Follow one and it goes somewhere.
- **Confidence varies, and low-confidence notes are still here.** vir drops everything at or below 0.6 before distilling; what survives still ranges. Nothing has been hidden because it scored badly.
- **Duplicates exist.** Two sessions on the same subject produce two notes until `vir dedupe` merges them. You're seeing a vault that hasn't been groomed.

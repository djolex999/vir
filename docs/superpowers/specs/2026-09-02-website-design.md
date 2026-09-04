# vir — marketing site design

Date: 2026-09-02
Status: approved design, v2 (revised after competitive research), ready for
implementation plan

## 1. Goal

A single marketing page for `@djolex999/vir-cli` that makes a Claude Code user
understand what vir is in under ten seconds and install it in under sixty.

## 2. Non-goals

- No blog, no changelog page, no docs site. Documentation stays in the repo
  README and `docs/`; the site links to it.
- No pricing tiers, no cloud tier, no seat-based plans. vir is an MIT CLI with
  no hosted component; inventing a business model on the page would poison the
  honesty the rest of the copy depends on.
- No enterprise / SOC 2 / governance section. Nothing true to say.
- No benchmark claims. See §5, block 9 — the absence is stated as a position.
- No testimonial wall until real quotes exist. A defined slot, shipped empty.
- No accounts, no email capture, no newsletter.
- No dark mode in v1. Light only.

## 3. Landscape

Eight sites surveyed on 2026-09-02: plur.ai, mem0.ai, letta.com,
basicmemory.com, supermemory.ai, getzep.com, cognee.ai, byterover.dev.

Three camps. **Enterprise infrastructure** (Mem0, Zep, Supermemory) — SOC 2,
governance, p95 latency charts, benchmark leadership. **Company brain**
(Cognee, ByteRover) — Slack/GitHub/Linear connectors, team plans, pilots.
**Research manifesto** (Letta) — no product marketing at all, a dated index of
papers; the lightest site of the eight, but it sells a lab, not a tool.

**The real competitor is Basic Memory, not PLUR.** Markdown knowledge graph,
Obsidian, MCP, open source, 3K stars, 57K downloads/month. It overlaps vir on
almost everything — file format, graph, local-first, MCP — and beats vir on
polish and on team sync. The one axis it does not cover:

> Basic Memory requires the agent to write notes **going forward**. vir reads
> transcripts you **already have**, retroactively, with no change in behavior.

Wider than that: none of the eight touches the transcript archive. Every one of
them starts learning the day you install it. Transcript archaeology is an
uncontested position and the page must lead with it, not with the generic
"agents forget" claim that all eight could write.

### What we take

| Pattern | Source | Where it lands |
|---|---|---|
| Three-way category comparison | Basic Memory | New block 5 |
| Benchmark framing, inverted into honesty | Supermemory | Block 9 |
| Provenance as a headline feature | ByteRover, Zep | Callout in block 6 |
| Proof strip + "works with" row under hero | Basic Memory, Cognee | Block 2 |
| Time and money cost stated up front | Cognee | New block 10 |

### What we reject, and why

Pricing tables and cloud upsell — no business model to sell. Enterprise
governance blocks — nothing true to say, and they would undercut the
solo-built credibility that is vir's actual asset. Cognee's tweet wall — no
quotes yet; faking or curating weak ones costs more trust than it buys.
Letta's pure-manifesto approach — tempting for "lighter", but vir needs
installs, not a research agenda.

## 4. Positioning

Three claims, in this order of prominence:

1. **Retroactive.** Claude Code prunes transcripts after roughly 30 days. vir
   turns months of existing history into a vault in one run. Nobody else in the
   category does this.
2. **The output is for the human.** Typed markdown notes in an Obsidian vault,
   in the graph, next to your own notes. An agent memory store is machine feed;
   vir's notes are something you would read on purpose — and the agent reads
   them too.
3. **It filters noise.** On the author's machine, 243 transcripts contained
   about 20 human-driven sessions; the rest were subagent runs, workflow
   phases, and headless SDK agents. vir detects all three and skips them.

One clarifying line appears early, because every reader arrives with the wrong
mental model: **"vir is not a memory layer your agent writes to. It reads what
already happened."**

Tone: honest over enterprise. The page states what leaves the machine rather
than stamping a "100% local" badge it cannot support. It names peers, including
the ones it competes with, accurately and without teardown. This is the
substance of "lighter" — not just less visual weight.

## 5. Information architecture

Twelve blocks. `⚡` marks a React island; everything else is static HTML with
zero client JS.

The order answers, in sequence: what is it → why should I care → how does it
work → why not the alternatives → what does it actually produce → is it
credible → what does it cost me → how do I start → who made it.

### 1. Nav
Sticky, 56px, hairline bottom border, translucent backdrop. Whirlpool mark +
`vir` wordmark left. Right: How it works · Install · GitHub · npm. No CTA
button — the hero has it.

### 2. Hero
- H1: **Months of Claude Code sessions you thought were gone.**
- Sub: "Claude Code prunes transcripts after about 30 days. vir reads what's
  still on disk, filters out the noise, and writes typed markdown notes into
  your Obsidian vault — retroactively, in one run."
- Primary: copyable `npm install -g @djolex999/vir-cli` in a mono pill with a
  copy button (inline JS, not an island).
- Secondary text link: "See what it writes ↓" anchoring to block 6.
- **Proof strip**, small mono caps, hairline rules between: npm downloads ·
  GitHub stars · MIT · v0.17.0. Numbers fetched at build time with a
  try/catch that omits the failing item rather than breaking the build.
- **Works-with row**: Claude Code · Obsidian · MCP · Dataview · Ollama ·
  Web Clipper. Plain text, no logos — logos would need permission and would
  read as enterprise.
- Below: `docs/graph.png` in a soft framed card, slight rotation off-axis,
  caption "This is my vault. Every node is a markdown file vir wrote."
  Click opens a full-size lightbox — it is the page's strongest asset and it
  is unreadable at card size.
- Composition strip on the card: "N notes · 4 types · N links", measured once
  from the author's vault (see §11).

H1 alternates kept for later A/B, not shipped: "Claude Code forgets. Your vault
doesn't." (now reused as the block 11 kicker), "Your Claude Code sessions, as a
wiki you'd actually read."

### 3. The problem
A specific moment, not an abstraction. Max 60ch measure, generous leading.

"Three weeks ago you and Claude spent two hours working out why the Kie.ai
endpoint returns 200 with the error in the body. Today it happens again, on a
different project. Neither of you remembers. The session that solved it was
pruned eleven days ago, and the fix exists nowhere — not in the code, not in a
commit message, not in CLAUDE.md."

Followed by the clarifying line from §4.

### 4. The loop ⚡
Interactive SVG of the cycle from the README:
`Claude Code sessions → vir → Obsidian vault → CLAUDE.md → better sessions → …`

Hover or tap a node to reveal a one-line explanation and the real command that
drives that edge (`vir run`, `vir sync-claude`, `vir schedule install`).
Keyboard accessible: nodes are buttons in a roving tabindex. Degrades to a
static labeled diagram with no JS.

### 5. Why not the alternatives — NEW
Three columns, equal weight, adapted from Basic Memory's shape.

| | |
|---|---|
| ✕ **Agent memory stores** | Mem0, PLUR, Supermemory, Zep. Written for the machine, in a format you don't read. And they start from the day you install them. |
| ✕ **The transcripts themselves** | Readable and yours — until Claude Code prunes them at ~30 days. And nobody greps 243 JSONL files. |
| ✓ **vir** | Reads what's already on disk, drops the noise, writes typed notes into a graph you already look at. |

Below the columns, a hairline footnote naming the closest neighbor honestly:

"The closest project to vir is **Basic Memory** — markdown, Obsidian, MCP,
open source, and good. The difference is direction: Basic Memory has your agent
write notes going forward. vir reads the sessions you already ran. They are
compatible; the vaults can sit side by side."

That footnote is not a concession. Naming the strongest competitor accurately
is the cheapest credibility on the page, and every visitor who has heard of
Basic Memory will otherwise leave to check.

### 6. Anatomy of a note ⚡
The highest-value block on the page. An Obsidian-styled card showing a real
note, with a four-tab switcher for the categories vir actually emits
(`src/pipeline/distiller.ts:17`): Pattern · Gotcha · Decision · Tool.

Frontmatter must match `src/pipeline/writer.ts:96-124` exactly:

```markdown
---
topic: "Kie.ai returns 200 with an error body"
aliases:
  - "kie-ai-returns-200-with-an-error-body"
category: gotcha
project: "growthq"
session_id: 4f2a9c31
date: 2026-06-01T09:14:22.000Z
confidence: 0.86
themes:
  - kie error handling
  - retry safety
---

Project: [[growthq]]
Category: [[gotcha]]

...body...

## Related
- [[retry-with-backoff-on-idempotent-writes]]
```

Four callouts around the card:
- **wikilinks** — why the graph fills in.
- **`confidence`** — why some notes are dimmer than others.
- **`## Related`** — rebuilt from embedding neighbors, not from what the LLM
  guessed it should link to.
- **`session_id` + `date` — provenance.** Every claim traces back to the exact
  session that produced it. Open the note, read the id, and you know where the
  sentence came from. Zep and ByteRover both build a third of their pitch on
  this; vir has had it since v0.1 and has never said so.

Copy above the card: "Every memory an agent-memory store keeps is for the
agent. This is for you — and the agent reads it too."

### 7. Three inputs, one vault
Three cards: **Claude Code sessions** (retroactive) · **Web articles** (clipped
to a folder, e.g. Obsidian Web Clipper) · **PDFs and papers**. One line below:
everything embeds into one vector space (Ollama optional, TF-IDF fallback), so
`vir query` searches across all three.

### 8. Query and MCP
Two columns.
- Left: a typeset fake terminal running
  `vir query "how did we handle kie 200 errors"` with a synthesized answer and
  cited note links. Static in v1, built so it can be swapped for a live demo
  without touching the layout.
- Right: `vir mcp` exposes the vault to Claude Code mid-session, so the agent
  consults past decisions instead of rediscovering them. Plus `vir sync-claude`,
  which feeds the best notes back into CLAUDE.md with a diff and confirmation.

### 9. There is no benchmark here — REVISED
Merges the old "two numbers" block with an explicit stance. This is the most
important paragraph on the page.

Heading: **There is no benchmark here.**

Body: "Every tool in this category leads with a score — LongMemEval, LoCoMo,
recall@5. None of those measure the thing that matters: whether the notes
turned out to be worth reading. So here are the only numbers I have, from one
machine."

Then the two figures, big serif numerals:
- **354** sessions — "Claude Code would have pruned these. They now exist
  nowhere else."
- **243 → ~20** transcripts — "Only about 20 were sessions I actually drove.
  vir skips subagents, workflow phases, and headless runs by default."

Small-caps footnote, required: "Author's machine, September 2026. Yours will
differ."

Placement matters: this lands *after* the reader has seen a note, where the
numbers read as evidence. In v1 of this spec it sat third, where they read as
a boast from a stranger.

### 10. What it costs you — NEW
Three steps with real time and money attached, adapted from Cognee's staged
timeline but with the price stated, which nobody in the category does.

- **60 seconds** — `npm install -g`, then `vir init` (a wizard: provider,
  models, vault path).
- **One run** — months of history become a vault. Actual wall-clock and actual
  dollar cost for a reference history size, measured, not estimated (§11).
  Note the `claude-cli` provider path: on a Claude subscription this run costs
  no API spend at all.
- **Ongoing** — `vir schedule install` registers a daemon. Marginal cost per
  new session, measured.

Under it: "`vir cost` prints this for your own history before you commit to a
full run."

### 11. Install, and what actually leaves your machine
Kicker line above the heading, reusing the retired H1: **"Claude Code forgets.
Your vault doesn't."**

```bash
npm install -g @djolex999/vir-cli
vir init
vir run
```
Copy button on each. Requirements: macOS or Linux, Node 20+, Claude Code.
Obsidian optional — the output is plain markdown either way.

Honesty box below, hairline border, not a badge: "Transcripts are classified
and distilled by an LLM, so their content goes to whichever provider you
configure — including your Claude subscription via the claude-cli provider.
Nothing else leaves the machine: no server, no account, no telemetry.
Embeddings are local (Ollama) or TF-IDF."

### 12. Credit, status, footer
- Karpathy's LLM Wiki pattern, links to the
  [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) and
  the post. One neutral line on peer implementations (llmwiki, llm-wiki,
  llm_wiki): "Several implementations of this pattern exist. vir is the
  Obsidian-native, retroactive one."
- Status strip: version, test count, platforms, MIT, solo-built.
- **Empty testimonial slot**, commented out in the markup with a note: ship
  only real, attributed quotes. Do not curate weak ones.
- Footer: GitHub · npm · vir-obsidian plugin · LICENSE · GrowthQ Lab DOO.

### Scroll budget
Twelve blocks is two more than v1, and the failure mode of competitive research
is a page that absorbs everyone's ideas and reads like a brochure. Hard limits:
**2,600 words of body copy, 6 screens at 1440x900.** If a block cannot earn its
scroll at review, it is cut — candidates for cutting, in order: block 7, then
block 10, then the block 5 footnote.

## 6. Visual system

Paper-light, one accent, editorial typography. Explicitly not the dark techno
surface every site in §3 shares: no glow, no animated orbs, no full-bleed
gradients.

Tokens (`site/src/styles/tokens.css`, consumed by the Tailwind theme):

| Token | Value | Use |
|---|---|---|
| `--paper` | `#FAF9F7` | page background |
| `--paper-2` | `#F2F0EC` | alternating band (blocks 5, 7, 9) |
| `--ink` | `#141317` | body text, headlines |
| `--ink-muted` | `#5C5A63` | secondary copy, captions, footnotes |
| `--rule` | `#E3E0DA` | hairlines, card borders |
| `--accent` | `#7C6AF7` | links, the one CTA, active tab, ✓ column |
| `--accent-wash` | `#7C6AF7` at 8% | code blocks, callouts |
| `--code-bg` | `#16161F` | the fake terminal only |

`--accent` carries over from the existing brand (logo, README badges,
`vir-flow.html`) and is the only chromatic color on the page. The ✕ columns in
block 5 use `--ink-muted` only — no red. Red would make it a teardown.

Type:
- Display / H1–H2: **Instrument Serif**, 400. H1 clamp `2.75rem → 4.5rem`.
- Body / UI: **Inter**, 400/500. Body 17px, measure capped at 62ch.
- Code / labels / eyebrows / stat captions: **JetBrains Mono**, 400/500.

Self-hosted via `@fontsource` — no runtime Google Fonts request.

Motion: scroll-reveal (opacity + 8px translate, 400ms, once) on section entry,
plus the block 4 loop. Both disabled under `prefers-reduced-motion: reduce`.

Spacing: 8px base, section rhythm 96px mobile / 160px desktop. Content column
1120px max, prose column 62ch.

## 7. Technical architecture

**Stack:** Astro 5 (static output) + React 19 islands + Tailwind 4, on Vercel.

The page is roughly 90% static text, and Astro ships zero JS for it. The two
interactive blocks mount as `client:visible` islands, so "more interactive
later" costs nothing now and needs no rewrite. Next.js would ship a React
runtime for the whole document to get the same two islands.

**Location:** `site/` in this repo. `package.json#files` already whitelists only
`dist`, so the site never reaches the npm tarball. `site/` gets its own
`package.json` and lockfile; the root build is untouched.

```
site/
  package.json
  astro.config.mjs
  tailwind.config.ts
  public/
    graph.png            # copied from docs/graph.png at build
    og.png               # 1200x630
    favicon.svg          # whirlpool mark
  src/
    consts.ts            # SITE_URL, all URLs, all measured numbers
    layouts/Base.astro   # head, fonts, OG, JSON-LD, skip link
    pages/index.astro
    components/
      Nav.astro
      Hero.astro              # incl. proof strip + works-with row
      Problem.astro
      LoopDiagram.astro       # island wrapper + noscript fallback
      Alternatives.astro      # block 5
      NoteAnatomy.astro       # island wrapper
      ThreeInputs.astro
      QueryAndMcp.astro
      NoBenchmark.astro       # block 9
      Cost.astro              # block 10
      Install.astro
      CreditFooter.astro
    islands/
      Loop.tsx
      NoteTabs.tsx
    data/
      notes.ts           # the four sample notes, verbatim
    styles/tokens.css
```

**Build-time data.** `site/src/consts.ts` is the single source for every number
and URL: version from the root `package.json`, test count, session figures,
cost figures, `SITE_URL`. npm downloads and GitHub stars are fetched at build
with try/catch — a failed API call omits that item, never breaks the build. The
domain is undecided; `SITE_URL` ships as `https://vir.sh` and changing it is a
one-line edit that propagates to canonical, OG, and sitemap.

**Deploy.** Vercel project rooted at `site/`, `astro build`, static output,
preview deploys per branch.

**Analytics.** Vercel Web Analytics only — no cookie banner, no third-party
script.

## 8. Islands

### `Loop.tsx`
Props: nodes from `consts.ts`. State: `activeNode: string | null`. Inline SVG;
nodes are `<button>`s in a roving-tabindex group; hover and focus both set
`activeNode`; Escape clears. The detail panel is a fixed-height region below the
diagram so activation never shifts layout. CSS transitions only, no animation
library. Budget: under 6KB gzipped.

### `NoteTabs.tsx`
Props: the four notes from `data/notes.ts`. WAI-ARIA tabs pattern: `role="tablist"`,
arrow-key navigation, `aria-selected`, one focusable tab. Frontmatter keys and
wikilinks highlighted by hand-rolled span wrapping, not Shiki — the content is
four fixed strings. Budget: under 8KB gzipped.

Both render meaningful static HTML from their Astro wrapper before hydration,
so the page is complete with JS disabled.

## 9. Content sourcing

| Site element | Source |
|---|---|
| Hero graph image, OG image | `docs/graph.png` |
| Logo, favicon | `assets/vir_whirlpool_logo.svg` |
| Loop diagram nodes | README flow |
| Note frontmatter shape | `src/pipeline/writer.ts:96-124` |
| Note categories | `src/pipeline/distiller.ts:17` |
| Command list | `src/cli.ts` (`init`, `run`, `query`, `mcp`, `sync-claude`, `schedule`, `cost`, `status`, `doctor`) |
| Version, package name | root `package.json` |
| Karpathy links, peer projects | README "The pattern" |
| Competitor claims in block 5 | §3, captured 2026-09-02 |

The four sample notes in `data/notes.ts` are hand-written for the site in the
exact format the writer emits, and must be re-checked if `writer.ts` frontmatter
changes — noted in `site/README.md`.

`assets/demo.gif` stays unused in v1: the graph screenshot shows the result,
which sells harder, and the GIF is heavy.

## 10. Quality bar

- Lighthouse 100/100/100/100 on mobile. Acceptance gate.
- Total JS under 20KB gzipped.
- LCP is the H1, not the graph. Graph is `loading="lazy"` with explicit
  dimensions and an AVIF/WebP source set.
- Every interactive element keyboard-operable, visible focus ring in `--accent`.
  The lightbox traps focus and closes on Escape.
- `--ink` on `--paper` is 15:1; `--ink-muted` on `--paper` verified at 4.5:1+
  before ship.
- Works with JS disabled: all content readable, both islands degraded.
- Responsive from 320px. The graph card and block 5's three columns each scroll
  inside their own container rather than shrinking to illegibility.
- `<head>`: canonical, OG image, Twitter large card, `SoftwareApplication`
  JSON-LD, sitemap, robots.txt.

## 11. Must measure before launch

These ship as real figures or the blocks that contain them are cut. No guesses,
no rounded-up estimates.

Measured 2026-09-04; derivations are documented next to the values in
`site/src/consts.ts`. Two changes from the draft copy: block 9's second
figure became "1,386 transcripts → 410 notes" (DB-derived) instead of the
README's "243 → ~20", and block 10 states money only — wall-clock per run
was never logged, so it is not claimed.

1. **Vault composition** (block 2 strip): note count, link count, from the
   author's vault.
2. **Session figures** (block 9): re-run, do not copy from the README.
3. **Test count** (block 12): from an actual `npm test` run.
4. **Cost and time** (block 10): one full pass on a stated reference history
   size, wall-clock and dollars, for both the API and `claude-cli` paths.
   `vir cost` output captured verbatim.

## 12. Open items

- **Domain.** Undecided pending availability: `vir.sh`, `getvir.dev`,
  `virwiki.dev`. Blocks nothing until deploy; `SITE_URL` is the single edit.
- **OG image.** Should be the graph, not the wordmark — the graph is what makes
  people click. Needs one 1200x630 crop with the wordmark overlaid.

## 13. Deferred, by design

Each drops into an existing block without a redesign:

1. Live `vir query` demo against a fixed demo vault, via a Vercel edge function
   with rate limiting — replaces the static terminal in block 8.
2. Mini graph explorer over a sample vault JSON — a playable hero image.
3. "Paste a transcript, see what vir would write" — the strongest possible demo
   and the most expensive; needs abuse protection and a spend cap.
4. Real testimonials into the block 12 slot, once they exist.
5. Docs section, if the README outgrows itself.

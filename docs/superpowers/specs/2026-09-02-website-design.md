# vir — marketing site design

Date: 2026-09-02
Status: approved design, ready for implementation plan

## 1. Goal

A single marketing page for `@djolex999/vir-cli` that makes a Claude Code user
understand what vir is in under ten seconds and install it in under sixty.

Reference point: [plur.ai](https://plur.ai) — same product category (memory for
AI coding agents), deliberately opposite execution. PLUR sells an open standard
with benchmark tables, an Enterprise page, and a Compare page attacking Mem0,
Letta, and Zep. Vir has no benchmark, no team, and no enterprise story; copying
that shape would be a weaker version of someone else's pitch.

## 2. Non-goals

- No blog, no changelog page, no docs site. Documentation stays in the repo
  README and `docs/`; the site links to it.
- No Compare page, no competitor teardown.
- No benchmark claims. Real numbers from one machine, labeled as such.
- No accounts, no email capture, no newsletter.
- No dark mode in v1. Light only.

## 3. Positioning

Three claims carry the whole page, in this order of prominence:

1. **Retroactive.** Claude Code prunes transcripts after roughly 30 days. Vir
   turns months of existing history into a vault in one run. PLUR and every
   other agent-memory tool start learning the day you install them; vir
   recovers what is already gone.
2. **The output is for the human.** Typed markdown notes in an Obsidian vault,
   in the graph, next to your own notes. PLUR's YAML engrams are machine feed.
   Vir's notes are something you would read on purpose.
3. **It filters noise.** On the author's machine, 243 transcripts contained
   about 20 human-driven sessions; the rest were subagent runs, workflow
   phases, and headless SDK agents. Vir detects all three and skips them.

Tone: honest over enterprise. The page states what leaves the machine (LLM API
calls for classification and distillation) rather than stamping a
"100% local" badge it cannot support. It credits Karpathy and peer
implementations instead of attacking competitors. This is the substance of
"lighter" — not just less visual weight.

## 4. Information architecture

Ten blocks, top to bottom. `⚡` marks a React island; everything else is static
HTML with zero client JS.

### 1. Nav
Sticky, 56px, hairline bottom border, translucent backdrop. Whirlpool mark +
`vir` wordmark on the left. Right: How it works · Install · GitHub (with live
star count, fetched at build time) · npm. No CTA button — the hero has it.

### 2. Hero
- H1: **Claude Code forgets. Your vault doesn't.**
- Sub: "vir reads your Claude Code transcripts, filters out the noise, and
  writes typed markdown notes into your Obsidian vault. Plain files, on your
  disk, yours if you uninstall tomorrow."
- Primary: copyable `npm install -g @djolex999/vir-cli` in a mono pill with a
  copy button (static HTML + 12 lines of inline JS, not an island).
- Secondary text link: "See what it writes ↓" anchoring to block 6.
- Below the fold line: `docs/graph.png` in a soft framed card, slight rotation
  off-axis, caption "This is my vault. Every node is a markdown file vir wrote."

Alternate H1s kept for A/B later, not shipped in v1:
"Your Claude Code sessions, as a wiki you'd actually read."
"Months of sessions you thought were gone."

### 3. Two numbers
Full-width band, off-white paper on paper (one shade darker), big serif
numerals.
- **354** sessions — "Claude Code would have pruned these. They now exist
  nowhere else."
- **243 → ~20** transcripts — "Only about 20 were sessions I actually drove.
  Vir skips subagents, workflow phases, and headless runs by default."

Footnote in small caps: "Numbers from the author's machine, September 2026.
Yours will differ." This footnote is required — it is the honesty the page
trades on.

### 4. The problem
Three sentences, no illustration, generous leading, max 60ch measure. Transcript
pruning; knowledge evaporating between sessions; CLAUDE.md going stale because
nobody updates it by hand.

### 5. The loop ⚡
Interactive SVG of the cycle already in the README:
`Claude Code sessions → vir → Obsidian vault → CLAUDE.md → better sessions → …`

Hover or tap a node to reveal a one-line explanation and the real command that
drives that edge (`vir run`, `vir sync-claude`, `vir schedule install`).
Keyboard accessible: nodes are buttons in a roving tabindex. Falls back to a
static labeled diagram with no JS.

### 6. Anatomy of a note ⚡
The direct answer to PLUR's YAML engram card, and the highest-value block on
the page. An Obsidian-styled card showing a real note, with a four-tab switcher
for the four categories vir actually emits (`src/pipeline/distiller.ts:17`):
Pattern · Gotcha · Decision · Tool.

Frontmatter shown must match `src/pipeline/writer.ts:96-124` exactly:

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

Callouts around the card, pointing at: the wikilinks (why the graph fills in),
`confidence` (why some notes are dimmer), and the `## Related` section
(rebuilt from embedding neighbors, not from what the LLM guessed).

Copy note above the card: "Every memory PLUR stores is for the agent. This is
for you — and the agent reads it too."

### 7. Three inputs, one vault
Three cards, equal weight: **Claude Code sessions** (retroactive) · **Web
articles** (clipped to a folder, e.g. Obsidian Web Clipper) · **PDFs and
papers**. One line below: everything embeds into one vector space (Ollama
optional, TF-IDF fallback), so `vir query` searches across all three.

### 8. Query and MCP
Two columns.
- Left: a fake terminal running `vir query "how did we handle kie 200 errors"`
  with a synthesized answer and cited note links. Static, typeset — no
  animation in v1, and built so the block can be swapped for a live demo later
  without touching the layout.
- Right: the MCP angle. `vir mcp` exposes the vault to Claude Code mid-session,
  so the agent consults past decisions instead of rediscovering them. Plus
  `vir sync-claude`, which feeds the best notes back into CLAUDE.md with a diff
  and confirmation.

### 9. Install, and what actually leaves your machine
Three commands with copy buttons:
```bash
npm install -g @djolex999/vir-cli
vir init
vir run
```
One line each: `vir init` is a wizard (provider, models, vault path); `vir run`
does one pass; `vir schedule install` registers a daemon that keeps the vault
current.

Requirements line: macOS or Linux, Node 20+, Claude Code. Obsidian optional —
the output is plain markdown either way.

Directly below, an honesty box with a hairline border, not a badge:
"Transcripts are classified and distilled by an LLM, so their content goes to
whichever provider you configure — including your Claude subscription via the
claude-cli provider. Nothing else leaves the machine: no server, no account,
no telemetry. Embeddings are local (Ollama) or TF-IDF."

### 10. Credit, status, footer
- Karpathy's LLM Wiki pattern with links to the
  [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) and
  the post. One line naming peer implementations (llmwiki, llm-wiki, llm_wiki)
  with a neutral framing: "Several implementations of this pattern exist. Vir
  is the Obsidian-native, retroactive one."
- Status strip: version (from `package.json` at build time), test count,
  platforms, MIT, solo-built.
- Footer: GitHub · npm · vir-obsidian plugin · LICENSE · GrowthQ Lab DOO.

## 5. Visual system

Paper-light, one accent, editorial typography. Explicitly not plur.ai's dark
techno surface: no glow, no animated orbs, no full-bleed gradients.

Tokens (`site/src/styles/tokens.css`, consumed by Tailwind theme):

| Token | Value | Use |
|---|---|---|
| `--paper` | `#FAF9F7` | page background |
| `--paper-2` | `#F2F0EC` | alternating band background (blocks 3, 7) |
| `--ink` | `#141317` | body text, headlines |
| `--ink-muted` | `#5C5A63` | secondary copy, captions |
| `--rule` | `#E3E0DA` | hairlines, card borders |
| `--accent` | `#7C6AF7` | links, the one CTA, active tab, graph node highlight |
| `--accent-wash` | `#7C6AF7` at 8% | code-block and callout backgrounds |
| `--code-bg` | `#16161F` | the fake terminal only |

`--accent` is carried over from the existing brand (logo, README badges,
`vir-flow.html`). It is the only chromatic color on the page.

Type:
- Display / H1–H2: **Instrument Serif**, 400. H1 clamp `2.75rem → 4.5rem`.
- Body / UI: **Inter**, 400/500. Body 17px, measure capped at 62ch.
- Code / labels / stat captions: **JetBrains Mono**, 400/500, small caps for
  section eyebrows.

Self-hosted via `@fontsource` — no Google Fonts request at runtime.

Motion: scroll-reveal (opacity + 8px translate, 400ms, once) on section entry,
and the block 5 loop. Everything respects `prefers-reduced-motion: reduce`,
which disables both.

Spacing: 8px base, section rhythm 96px mobile / 160px desktop. Content column
1120px max, prose column 62ch.

## 6. Technical architecture

**Stack:** Astro 5 (static output) + React 19 islands + Tailwind 4, deployed to
Vercel.

Rationale: the page is roughly 90% static text, and Astro ships zero JS for it.
The two interactive blocks mount as `client:visible` React islands, so the
"more interactive later" requirement costs nothing now and needs no rewrite
later. Next.js would ship a React runtime for the whole document to get the
same two islands.

**Location:** `site/` inside this repo. `package.json#files` already whitelists
only `dist`, so the site never reaches the npm tarball. `site/` gets its own
`package.json` and lockfile; the root build is untouched.

```
site/
  package.json
  astro.config.mjs
  tailwind.config.ts
  public/
    graph.png            # copied from docs/graph.png at build
    og.png               # 1200x630, generated once
    favicon.svg          # whirlpool mark
  src/
    consts.ts            # SITE_URL, npm/GitHub/plugin URLs, all numbers
    layouts/Base.astro   # <head>, fonts, OG, JSON-LD, skip link
    pages/index.astro    # composes the ten blocks
    components/          # one .astro file per block
      Nav.astro
      Hero.astro
      TwoNumbers.astro
      Problem.astro
      LoopDiagram.astro       # wrapper, renders island + noscript fallback
      NoteAnatomy.astro       # wrapper
      ThreeInputs.astro
      QueryAndMcp.astro
      Install.astro
      CreditFooter.astro
    islands/
      Loop.tsx
      NoteTabs.tsx
    data/
      notes.ts           # the four sample notes, verbatim strings
    styles/tokens.css
```

**Build-time data.** `site/src/consts.ts` holds every number and URL in one
place: version read from the root `package.json`, test count, session numbers,
and `SITE_URL`. The GitHub star count is fetched at build time with a
try/catch that falls back to omitting the badge — a failed API call must not
break the build. The domain is undecided; `SITE_URL` ships as
`https://vir.sh` as a placeholder and changing it is a one-line edit that
propagates to canonical, OG, and sitemap.

**Deploy.** Vercel project rooted at `site/`, `astro build`, static output.
Preview deployments on every branch.

**Analytics.** Vercel Web Analytics — no cookie banner needed, no third-party
script. Nothing else.

## 7. Islands

### `Loop.tsx`
Props: nodes array from `consts.ts`. State: `activeNode: string | null`.
Renders an inline SVG; nodes are `<button>` elements inside a roving-tabindex
group, hover and focus both set `activeNode`, Escape clears it. The detail
panel is a fixed-height region below the diagram so activating a node does not
shift layout. No animation library — CSS transitions only. Budget: under 6KB
gzipped.

### `NoteTabs.tsx`
Props: the four notes from `data/notes.ts`. Standard WAI-ARIA tabs pattern:
`role="tablist"`, arrow-key navigation, `aria-selected`, one focusable tab. The
note body renders as pre-formatted text with a small syntax highlighter for
frontmatter keys and wikilinks — hand-rolled span wrapping, not Shiki, since
the content is four fixed strings. Budget: under 8KB gzipped.

Both islands render meaningful static HTML from the Astro wrapper before
hydration, so the page is complete with JS disabled.

## 8. Content sourcing

Every asset already exists in the repo:

| Site element | Source |
|---|---|
| Hero graph image | `docs/graph.png` |
| Logo, favicon | `assets/vir_whirlpool_logo.svg` |
| Loop diagram nodes | README "what it does" flow |
| Note frontmatter shape | `src/pipeline/writer.ts:96-124` |
| Note categories | `src/pipeline/distiller.ts:17` |
| Command list | `src/cli.ts` (`init`, `run`, `query`, `mcp`, `sync-claude`, `schedule`, `status`, `doctor`) |
| Version, package name | root `package.json` |
| Karpathy links, peer projects | README "The pattern" |

The four sample notes in `data/notes.ts` are written by hand for the site, in
the exact format the writer emits. They must be re-checked against
`writer.ts` if the frontmatter changes — noted in `site/README.md`.

`assets/demo.gif` is deliberately unused in v1: the graph screenshot shows the
result, which is the stronger sell, and the GIF is heavy.

## 9. Quality bar

- Lighthouse: 100 performance, 100 accessibility, 100 best practices, 100 SEO
  on mobile. This is achievable for a static page and is the acceptance gate.
- Total JS shipped under 20KB gzipped.
- LCP element is the H1, not the graph image; graph is `loading="lazy"` with
  explicit width/height and an AVIF/WebP source set.
- Every interactive element reachable and operable by keyboard; visible focus
  ring in `--accent`.
- Contrast: `--ink` on `--paper` is 15:1; `--ink-muted` on `--paper` verified
  at 4.5:1 or better before ship.
- Works with JS disabled: all content readable, both islands degraded to static.
- Responsive from 320px; the graph card scrolls horizontally inside its own
  container rather than shrinking to illegibility on mobile.
- `<head>`: canonical, OG image, Twitter large card, `SoftwareApplication`
  JSON-LD, sitemap, robots.txt.

## 10. Open items

- **Domain.** Undecided pending availability. Candidates: `vir.sh`, `getvir.dev`,
  `virwiki.dev`. Blocks nothing until deploy; `SITE_URL` is the single edit.
- **OG image.** Needs one designed 1200x630 asset — likely the wordmark over a
  cropped, desaturated corner of `graph.png`.
- **Verify before launch:** the test count and session numbers quoted in
  blocks 3 and 10 must be re-run and updated, not copied from the README.

## 11. Later, explicitly deferred

Each of these drops into an existing block without a redesign:

1. Live `vir query` demo against a fixed demo vault, via a Vercel edge function
   with rate limiting — replaces the static terminal in block 8.
2. Mini graph explorer over a sample vault JSON — a second, playable version of
   the hero image.
3. "Paste a transcript, see what vir would write" — the strongest possible demo,
   and the most expensive; needs abuse protection and a spend cap.
4. Docs section, if the README outgrows itself.

# vir marketing site

virwiki.dev — the landing page plus `/docs`. Spec: `../docs/superpowers/specs/2026-09-02-website-design.md`.
Conventions that matter live in `../CLAUDE.md` under **Website (`site/`)**.

## Run

Astro 7 needs Node ≥ 22.12 — nvm's default here is 20, so either `nvm use 22` or
prefix with Homebrew's node:

```bash
PATH=/opt/homebrew/bin:$PATH npm run dev
```

`npm run build` · `npm run preview` · `npm test` · `npm run check`

## Where things live

- `src/consts.ts` — every URL and number on the site, each with its derivation in a
  comment. `SITE_URL` is the only place the domain is set. A `null` in `NUMBERS`
  means unmeasured: the block that needs it is omitted and the build prints the key.
- `src/data/notes.ts` — the four sample notes in the Anatomy block, in the exact
  shape `../src/pipeline/writer.ts` emits. **Change both together.**
- `src/lib/stats.ts` — build-time npm downloads and GitHub stars. Any failure omits
  the figure; it never fails the build.
- `src/islands/` — the two hydrated components (`Loop`, `NoteTabs`). Preact, not
  React. Everything else is static HTML.
- `src/content/docs/docs/` — the Starlight pages. `changelog.md` is **generated** by
  `scripts/sync-changelog.mjs` on every build; edit `../CHANGELOG.md` instead.
- `src/pages/changelog.xml.ts` — the release RSS feed, parsed from the same file.

## Keeping the numbers honest

```bash
npm run refresh
```

Regenerates the hero graph and prints every value in `NUMBERS` next to what's
committed, so a stale figure is visible instead of silent. It writes nothing to
`consts.ts` — those values are claims on a public page and deserve a human
deciding to change them. Cost figures come from `vir cost --since 180d` by hand.

Note it counts the CLI suite with whatever node is on PATH. The CLI targets node
20 and the site needs 22+, and the suite reports different numbers on each — the
script warns when it ran on the wrong one.

## Regenerating artifacts

**The hero graph** is laid out at build time and committed, because Vercel has no
vault:

```bash
node scripts/build-graph.mjs          # reads the vault from ~/.vir/config.json
```

Topics matching `leak|bypass|attack|inject|exploit|vuln|self-grant|secur` are
excluded from the public sample.

**The OG card** is `scripts/og.html`, screenshotted at 1200×630:

```bash
npm i -D playwright && npx playwright install chromium
node scripts/build-og.mjs
npm un playwright
```

Playwright is deliberately not a dependency — it downloads a browser on postinstall
and Vercel installs devDependencies on every build.

## Deploy

Vercel project, root directory `site/`, framework preset Astro, static output. No
adapter. Analytics is Vercel Web Analytics via the inline script in `Base.astro`
(404s locally — that's expected).

# Contributing to vir

PRs welcome. Open an issue first for large changes.

## Development setup

```bash
git clone https://github.com/djolex999/vir
cd vir
npm install
npm run build
npm test
```

Built with TypeScript strict mode (`noImplicitAny`, `noUncheckedIndexedAccess`).
Run `npm run build` (or `npm run typecheck`) before submitting — it must pass
clean. Tests use Vitest; run `npm test` or `npm test -- --watch` for watch mode.

## Conventions

See [CLAUDE.md](CLAUDE.md) for the architectural conventions this codebase
follows — path expansion, per-session error isolation, provider routing,
the sacred `VIR:START`/`VIR:END` markers, and the rule that all user-facing
output goes through `src/ui/display.ts`.

## Regenerating the demo GIF

The demo GIF in the README is generated with
[vhs](https://github.com/charmbracelet/vhs) from `demo.tape`:

```bash
brew install vhs
vhs demo.tape
git add assets/demo.gif
git commit -m "docs: regenerate demo GIF"
```

Edit `demo.tape` to change the recorded commands or timing, then regenerate.
Don't hand-edit the GIF — overwrite it cleanly each time so it doesn't
accumulate binary diff cruft.

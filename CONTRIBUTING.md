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
Run `npm run build` and `npm run typecheck:all` before submitting — both must
pass clean (`typecheck:all` also checks the tests and `eval/`, and CI runs it). Tests use Vitest; run `npm test` or `npm test -- --watch` for watch mode.

## Conventions

The architectural conventions this codebase follows:

- Expand every configured path with `expandHome()` before using it.
- One bad session must never stop a run: each one is isolated and its error
  is recorded.
- Provider routing goes through `callLLM`, the one place LLM calls and their
  costs are recorded.
- `sync-claude` only ever changes bytes between the `VIR:START`/`VIR:END`
  markers.
- New user-facing output goes through `src/ui/display.ts` (some older command
  code still calls `console.log` directly; don't add more).

[docs/architecture/architecture.md](docs/architecture/architecture.md) maps
how the pieces fit together.

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

`demo-connect.tape` (the `vir connect` → review → sync-claude GIF) runs against a
sandbox, never your real setup: it expects `/tmp/virdemo/home` holding copies of
`~/.vir` (config with `vaultPath` pointed into the sandbox) and the vault, a
stand-in `projects/<name>/CLAUDE.md`, and two DB snapshots, `db-none.db` (the
rule removed, for the dry run) and `db-proposed.db` (the rule reset to
`proposed`). It replays an existing proposal instead of calling `vir connect`,
so recording costs nothing.

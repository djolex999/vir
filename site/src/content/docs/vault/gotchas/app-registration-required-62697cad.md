---
title: "app-registration-required"
description: "Gotcha distilled by vir from a Claude Code session on 2026-09-25. This session built and released a bundled macOS notification helper to replace Script Editor banners with branded \"vir\""
editUrl: false
---

:::note[Written by vir, not by a human]
**Gotcha** · session `62697cad` · 2026-09-25 · classifier confidence 0.9
:::

## Summary

This session built and released a bundled macOS notification helper to replace Script Editor banners with branded "vir" notifications. The critical finding: a macOS app must be registered with LaunchServices before the system allows it to send notifications—unregistered bundles fail silently or with "not allowed" errors, with no user-visible prompt. The helper is prebuilt (universal, ad-hoc-signed, shipped in npm), installed to `~/.vir/Vir.app` on first use, and `notify()` falls back to osascript if the user hasn't allowed it yet.

## What Was Learned

- **App registration is mandatory for macOS notifications.** `usernoted` logs "Failed to find or validate client" until you run `lsregister -f <app>`. Without it, UNUserNotificationCenter and AppleScript applets both fail silently. Prototype, test, and iterate on a scratch bundle id; the one users see should ship with the icon already in place from the first build, since Notification Center caches icons by bundle id.

- **A permission prompt that nobody answers is recorded as a denial, permanently.** An unattended request times out without triggering the prompt a second time. Only prompt from interactive commands (`vir init`, `vir notifications`) that have a human at the keyboard, and wait minutes, not seconds. The daemon never asks—it would silently fail and leave no trace.

- **Icon caching by bundle id means the shipped app needs the logo from day one.** Switching bundle ids resets it; editing an already-seen id leaves the old blank icon until logout. Since registration happens on every notification (fast, ~30ms), the app itself never changes post-install, only gets re-registered.

- **Prebuilt binaries in npm packages stay executable and signed when unpacked.** `npm pack` preserves the executable bit and ad-hoc code signatures (checked with `codesign --verify --strict`); the publish/install/verify flow works end-to-end.

- **Prepare releases fully, then hand publish/merge to the user.** The auto-mode classifier blocks `gh pr merge` ("Merge Without Review") and `npm publish` ("Create Public Surface") even after explicit approval. Set up the commit, tag, push, and fresh build; give the exact command. Expect npm's browser auth step and a 1–2 minute registry delay before `npm i -g` resolves the new version.

- **`npm version` rewrites formatting in `package.json`.** It turned `Djordje Markovi\u0107` into `Djordje Marković`; restore escape sequences after bumping so the release diff is clean.

## Context

This was a full-cycle feature from prototype to shipped: testing a JXA applet, a Swift helper with UNUserNotificationCenter, discovering the registration requirement through system logs, building a production-ready universal binary with an icon, integrating it into the TypeScript codebase, adding a CLI command and doctor check, and releasing 0.19.0. The work included 10 new tests and live verification on macOS 26.6.2 (Sequoia). Two constraints emerged: Claude sessions can't merge or publish, and bundle ids matter more for notifications than expected.

## Related

- marketing-site-auth-boundary
- debug-builds-invalidate-trial
- prompt-injection-via-unvalidated-references
- prompt-injection-via-user-input
- auth-redirect-breaks-no-auth-demo

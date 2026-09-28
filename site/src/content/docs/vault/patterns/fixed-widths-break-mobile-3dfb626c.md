---
title: "fixed-widths-break-mobile"
description: "Pattern distilled by vir from a Claude Code session on 2026-09-26. Debugged horizontal scroll issues on the vir site (Astro documentation + vault) by testing at multiple mobile widths, id"
editUrl: false
---

:::note[Written by vir, not by a human]
**Pattern** · session `3dfb626c` · 2026-09-26 · classifier confidence 0.85
:::

## Summary

Debugged horizontal scroll issues on the vir site (Astro documentation + vault) by testing at multiple mobile widths, identified three problematic fixed-width layouts, and fixed them with responsive design. The main offender was the landing page's comparison card grid forced to `min-w-[42rem]` inside an auto-scrolling container.

## What Was Learned

- **Fixed minimum widths in flex/grid containers cause mobile overflow.** The alternatives card grid had `min-w-[42rem]` forcing a 670px block into a 375px viewport with `overflow-x-auto`. Solution: remove the min-width, use `grid-cols-1` on mobile and `md:grid-cols-3` above 768px.
- **Systematic cross-page sweep beats ad-hoc spot-checking.** Tested all 56 built pages at 375px, then 20 pages at 320/360/390px widths (landing, all docs, sample vault notes, 404) to catch issues across viewports. Found that fixes to landing, nav, and note tabs were sufficient; other pages had no horizontal overflow.
- **Small screens need tighter spacing.** The nav header's `gap-5` between links pushed the theme toggle off-screen at 320px. Reduced to `gap-3` below `sm:` breakpoint, kept `sm:gap-5` above.
- **Flex wrapping must be explicit for tabs and buttons.** The note type tabs row overflowed because `.note-tabs` used `display: flex` without `flex-wrap`. Added `flex-wrap: wrap` so tabs drop to a second line when they don't fit.
- **Testing in Chromium is not enough for ship confidence.** All fixes verified in the app's built-in browser at phone widths, but the note notes: "Tested in Chromium only, not Safari on a real iPhone." (Safari on iOS can have different rendering or overflow behavior.)

## Context

Mobile responsiveness issue reported on the landing page. Work involved both finding the root causes (rigid layouts, missing wrapping) and validating fixes across a 56-page static site at multiple viewport widths to avoid shipping new regressions. The PR was merged after all 4 CI checks passed.

## Related

- [parametric-marks-need-render-testing](/vault/patterns/parametric-marks-need-render-testing-f5969d58/)
- [measurement-overturns-retrieval-defaults](/vault/patterns/measurement-overturns-retrieval-defaults-3d16861d/)
- test-isolation-leak
- [test-setup-file-isolation](/vault/patterns/test-setup-file-isolation-6aeafebe/)
- form-tests-click-paste

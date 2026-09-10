// Renders scripts/og.html to public/og.png at 1200x630 using the real
// webfonts. Run manually when the headline or the mark changes:
//   cd site && node scripts/build-og.mjs
// playwright is deliberately NOT a dependency — it has a browser-downloading
// postinstall, and Vercel installs devDependencies on every build. Install it
// only when you need to regenerate the card:
//   npm i -D playwright && npx playwright install chromium
//   node scripts/build-og.mjs
//   npm un playwright
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright not installed. Run:\n  npm i -D playwright && npx playwright install chromium\nthen re-run, then `npm un playwright`.");
  process.exit(1);
}
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("./og.html", import.meta.url));
const out = fileURLToPath(new URL("../public/og.jpg", import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(`file://${src}`);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
// JPEG, not PNG: the card is a smooth gradient behind large type, which a
// palette quantizes badly and JPEG handles well — 65 KB vs 481 KB, no visible
// loss. Every share-card render on X, LinkedIn and Slack fetches this.
await page.screenshot({ path: out, type: "jpeg", quality: 92 });
await browser.close();
console.log("public/og.jpg written (1200x630)");

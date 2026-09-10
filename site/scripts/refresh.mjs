// One command to end number drift. Regenerates the hero graph and prints the
// current measured values for NUMBERS in src/consts.ts, each next to what's
// committed, so a stale figure is visible instead of silent.
//   cd site && node scripts/refresh.mjs
// Nothing is written to consts.ts — the values are a claim on the page and
// deserve a human deciding to change them.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd(), "..");
const home = process.env.HOME ?? "";
console.log("→ regenerating the hero graph");
execFileSync(process.execPath, ["scripts/build-graph.mjs"], { stdio: "inherit" });

const db = join(home, ".vir/vir.db");
const q = (sql) => execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
const seen = Number(q("select count(*) from sessions"));
const withNote = Number(q("select count(*) from sessions where skipped=0 and note_paths!='[]'"));
const noise = Number(
  q("select count(*) from sessions where skipped=1 and skip_reason in ('workflow-transcript','agent-transcript','sidechain-transcript')"),
);
let rescued = 0;
for (const p of q("select path from sessions where skipped=0 and note_paths!='[]'").split("\n")) {
  if (!p) continue;
  try {
    statSync(p);
  } catch {
    rescued += 1;
  }
}

// The CLI targets Node 20 and pins a native better-sqlite3 build to it; the
// site needs Node 22+ for Astro 7. Running the CLI suite under the site's
// runtime fails every DB test with a NODE_MODULE_VERSION mismatch, which is
// an environment fault, not a result. Refuse to report a number rather than
// print a wrong one.
const nodeMajor = Number(process.versions.node.split(".")[0]);
const canCountTests = nodeMajor === 20;
if (canCountTests) console.log(`→ counting CLI tests (node ${process.versions.node})`);
else console.log(`→ skipping CLI tests — node ${nodeMajor}, the CLI needs node 20`);
// vitest prints its summary on stderr, and on a failure the line reads
// "Tests  1 failed | 533 passed (534)" — matching only /(\d+) passed/ would
// silently report a green count for a red suite, which is exactly the kind of
// number this script exists to prevent.
const readTests = (text) => {
  // Anchor on vitest's summary line only — per-file lines like
  // "(2 tests | 1 failed)" appear earlier and would win a loose match.
  const line = text.match(/^\s*Tests\s{2,}(.+)$/m)?.[1] ?? "";
  const failed = Number(line.match(/(\d+) failed/)?.[1] ?? 0);
  const passed = Number(line.match(/(\d+) passed/)?.[1] ?? 0);
  return { passed: passed || null, failed };
};
let tests = null;
let testsFailed = 0;
if (canCountTests) try {
  const r = readTests(execFileSync("npm", ["test", "--silent"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  tests = r.passed;
  testsFailed = r.failed;
} catch (e) {
  const r = readTests(`${e.stdout ?? ""}${e.stderr ?? ""}`);
  tests = r.passed;
  testsFailed = r.failed;
}

// Cost is the one set of figures a skeptic checks, and it drifts every run.
// Parsed rather than left to a "re-read by hand" note that nobody re-reads.
let cost = null;
try {
  const out = execFileSync("vir", ["cost", "--since", "180d"], { encoding: "utf8" });
  const grab = (label) => out.match(new RegExp(`${label}:\\s+\\$?([\\d.]+)`))?.[1];
  cost = {
    costSessions: Number(grab("sessions")),
    costTotal: Number(grab("total")),
    costMedian: Number(grab("median/session")),
    costP90: Number(grab("p90/session")),
  };
} catch {
  console.log("→ `vir cost` unavailable; skipping cost figures");
}

const committed = readFileSync("src/consts.ts", "utf8");
const current = (key) => Number(committed.match(new RegExp(`${key}: (\\d+)`))?.[1] ?? NaN);
// cost values are quoted strings like "$20.38" / "$0.004"
const currentCost = (key) =>
  Number(committed.match(new RegExp(`${key}: "\\$?([\\d.]+)"`))?.[1] ?? committed.match(new RegExp(`${key}: (\\d+)`))?.[1] ?? NaN);

const rows = [
  ["sessionsRescued", rescued],
  ["transcriptsSeen", seen],
  ["transcriptsNoise", noise],
  ["transcriptsNotes", withNote],
  ...(canCountTests ? [["tests", tests]] : []),
];

console.log("\nsrc/consts.ts — NUMBERS\n");
console.log("  key                 committed     measured");
let drift = 0;
for (const [k, v] of rows) {
  const was = current(k);
  const same = was === v;
  if (!same) drift += 1;
  console.log(
    `  ${k.padEnd(20)}${String(Number.isNaN(was) ? "—" : was).padStart(9)}${String(v ?? "—").padStart(13)}${same ? "" : "   ← update"}`,
  );
}
if (cost) {
  for (const [k, v] of Object.entries(cost)) {
    const was = currentCost(k);
    const shown = committed.match(new RegExp(`${k}: "\\$?([\\d.]+)"`))?.[1] ?? "";
    const dp = shown.includes(".") ? shown.split(".")[1].length : 0;
    // Compare at the precision the page actually prints: "$0.004" is a correct
    // rendering of 0.0041, but "$0.13" is not a correct rendering of 0.139.
    const same =
      k === "costSessions" ? was === v : Number(v.toFixed(dp)) === Number(was.toFixed(dp));
    if (!same) drift += 1;
    const fmt = (n) => (k === "costSessions" ? String(n) : `$${n}`);
    console.log(
      `  ${k.padEnd(20)}${(Number.isNaN(was) ? "—" : fmt(was)).padStart(9)}${fmt(v).padStart(13)}${same ? "" : "   ← update"}`,
    );
  }
}
if (!canCountTests) {
  console.log(
    `\n  ⚠ tests not counted: node ${nodeMajor} can't load this better-sqlite3 build.\n    Run \`nvm use 20 && npm test\` at the repo root and read the number there.`,
  );
}
if (testsFailed > 0) {
  console.log(
    `\n  ⚠ ${testsFailed} CLI test(s) FAILING. "${tests} passing" is only honest once\n    the suite is green — fix it or stop quoting the number.`,
  );
}
console.log(
  "\n  vault size and link count come from graph.json itself — the hero reads them\n  from there, so they cannot drift from the sample.",
);
console.log(
  drift === 0
    ? "\nEverything matches. Commit the regenerated graph.json if it changed.\n"
    : `\n${drift} value(s) drifted. Edit src/consts.ts, then commit it with graph.json.\n`,
);

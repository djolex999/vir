import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGolden } from "./golden.js";

// The Python port (eval/analysis/tests/test_parity.py) asserts it reproduces
// this fixture exactly. This side asserts the fixture still matches the TS
// code, so a change to rng.ts or bootstrap.ts fails here until the fixture is
// regenerated (VIR_UPDATE_GOLDEN=1 npx vitest run eval/analysis) and the
// Python port is brought back in line.
const FIXTURE = join(import.meta.dirname, "tests", "fixtures", "bootstrap_golden.json");

describe("bootstrap golden fixture", () => {
  it("matches the current TS rng and pairedBootstrapCI", () => {
    // JSON round trip: NaN becomes null exactly as it does in a run record.
    const current = `${JSON.stringify(buildGolden(), null, 2)}\n`;
    if (process.env["VIR_UPDATE_GOLDEN"] === "1") writeFileSync(FIXTURE, current, "utf8");
    expect(readFileSync(FIXTURE, "utf8")).toBe(current);
  });
});

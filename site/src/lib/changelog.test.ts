import { describe, expect, it } from "vitest";
import { parseReleases } from "../pages/changelog.xml";

const SAMPLE = `# Changelog

## 0.17.1 — 2026-09-04

Website and brand. No CLI changes.

- One thing
- Another

## 0.17.0 — 2026-08-13

Subscription provider.

- Detail
`;

describe("parseReleases", () => {
  it("finds every release, newest first, in file order", () => {
    const r = parseReleases(SAMPLE);
    expect(r.map((x) => x.version)).toEqual(["0.17.1", "0.17.0"]);
  });
  it("parses the date as UTC midday so timezones can't shift the day", () => {
    expect(parseReleases(SAMPLE)[0]!.date.toISOString()).toBe("2026-09-04T12:00:00.000Z");
  });
  it("stops a release body at the next heading", () => {
    const [first] = parseReleases(SAMPLE);
    expect(first!.body).toContain("- Another");
    expect(first!.body).not.toContain("Subscription provider");
  });
  it("returns nothing when there are no release headings", () => {
    expect(parseReleases("# Changelog\n\nnothing here\n")).toEqual([]);
  });
});

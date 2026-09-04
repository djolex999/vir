import { describe, expect, it } from "vitest";
import { fetchStats, formatCount } from "./stats";

describe("formatCount", () => {
  it("leaves small numbers alone", () => {
    expect(formatCount(999)).toBe("999");
  });
  it("abbreviates thousands with one decimal", () => {
    expect(formatCount(1234)).toBe("1.2k");
    expect(formatCount(62590)).toBe("62.6k");
  });
  it("drops a trailing .0", () => {
    expect(formatCount(3000)).toBe("3k");
  });
});

describe("fetchStats", () => {
  it("returns nulls when every request fails", async () => {
    const failing: typeof fetch = async () => {
      throw new Error("offline");
    };
    await expect(fetchStats(failing)).resolves.toEqual({
      downloadsWeek: null,
      stars: null,
    });
  });

  it("returns nulls on non-ok responses", async () => {
    const notOk: typeof fetch = async () =>
      new Response("{}", { status: 500 });
    await expect(fetchStats(notOk)).resolves.toEqual({
      downloadsWeek: null,
      stars: null,
    });
  });

  it("parses both sources independently", async () => {
    const ok: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("npmjs")) return Response.json({ downloads: 4321 });
      if (url.includes("github")) throw new Error("rate limited");
      throw new Error("unexpected " + url);
    };
    await expect(fetchStats(ok)).resolves.toEqual({
      downloadsWeek: 4321,
      stars: null,
    });
  });
});

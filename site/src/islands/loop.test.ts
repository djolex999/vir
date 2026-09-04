import { describe, expect, it } from "vitest";
import { nextIndex } from "./Loop";

describe("nextIndex", () => {
  it("moves right and wraps", () => {
    expect(nextIndex(0, "ArrowRight", 5)).toBe(1);
    expect(nextIndex(4, "ArrowRight", 5)).toBe(0);
  });
  it("moves left and wraps", () => {
    expect(nextIndex(2, "ArrowLeft", 5)).toBe(1);
    expect(nextIndex(0, "ArrowLeft", 5)).toBe(4);
  });
  it("jumps to ends", () => {
    expect(nextIndex(3, "Home", 5)).toBe(0);
    expect(nextIndex(1, "End", 5)).toBe(4);
  });
});

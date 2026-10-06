import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultNotesDir } from "./notesDir.js";

describe("defaultNotesDir", () => {
  const home = "/h";

  it("keeps an existing Obsidian vault as the default", () => {
    const vault = join(home, "Documents", "Obsidian", "MyVault");
    expect(defaultNotesDir(home, (p) => p === vault)).toBe(vault);
  });

  it("falls back to ~/notes when no vault exists", () => {
    expect(defaultNotesDir(home, () => false)).toBe(join(home, "notes"));
  });
});

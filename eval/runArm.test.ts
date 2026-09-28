import { describe, expect, it } from "vitest";
import { assertArmIsolation } from "./runArm.js";

describe("assertArmIsolation", () => {
  const ok = { home: "/h", dbPath: "/h/.vir/vir.db", configPath: "/h/.vir/config.json", embedderDir: "/h/.vir/embedder" };
  it("accepts paths inside the arm home", () => {
    expect(() => assertArmIsolation(ok, "/h", "a")).not.toThrow();
  });
  it("rejects a path outside the arm home", () => {
    expect(() => assertArmIsolation({ ...ok, dbPath: "/real/.vir/vir.db" }, "/h", "a")).toThrow(/isolation violated/);
  });
});

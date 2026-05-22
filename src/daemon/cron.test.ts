import { describe, expect, it } from "vitest";
import {
  cronHourInterval,
  generateCronLine,
  parseCronCadence,
  removeVirLines,
  VIR_CRON_MARKER,
} from "./cron.js";

describe("generateCronLine", () => {
  it("produces the correct schedule for a 3h cadence", () => {
    const line = generateCronLine(3, "vir run --yes");
    expect(line).toBe("0 */3 * * * vir run --yes # vir-cli");
  });

  it("tags every line with the vir-cli marker", () => {
    expect(generateCronLine(6, "vir run --yes")).toContain(VIR_CRON_MARKER);
  });

  it("clamps fractional cadence to a valid integer hour field", () => {
    expect(generateCronLine(1.4, "cmd")).toBe("0 */1 * * * cmd # vir-cli");
    expect(generateCronLine(0.2, "cmd")).toBe("0 */1 * * * cmd # vir-cli");
  });

  it("clamps cadence above 23h to 23 so the hour field stays valid", () => {
    expect(generateCronLine(48, "cmd")).toBe("0 */23 * * * cmd # vir-cli");
  });
});

describe("cronHourInterval", () => {
  it("rounds to the nearest hour", () => {
    expect(cronHourInterval(2.6)).toBe(3);
  });

  it("never returns less than 1", () => {
    expect(cronHourInterval(0)).toBe(1);
    expect(cronHourInterval(0.4)).toBe(1);
  });

  it("never exceeds 23", () => {
    expect(cronHourInterval(100)).toBe(23);
  });
});

describe("parseCronCadence", () => {
  it("extracts the cadence from a vir cron line", () => {
    expect(parseCronCadence("0 */3 * * * vir run --yes # vir-cli")).toBe(3);
  });

  it("parses a generated line round-trip", () => {
    expect(parseCronCadence(generateCronLine(8, "vir run --yes"))).toBe(8);
  });

  it("returns null when the hour field is not an interval", () => {
    expect(parseCronCadence("0 4 * * * some-job")).toBeNull();
  });

  it("returns null for a malformed line", () => {
    expect(parseCronCadence("")).toBeNull();
  });
});

describe("removeVirLines", () => {
  it("preserves the user's other crontab entries", () => {
    const crontab = [
      "0 9 * * * /usr/bin/backup.sh",
      "0 */3 * * * vir run --yes # vir-cli",
      "30 2 * * 0 /usr/bin/cleanup.sh",
    ].join("\n");
    const result = removeVirLines(crontab);
    expect(result).toContain("/usr/bin/backup.sh");
    expect(result).toContain("/usr/bin/cleanup.sh");
    expect(result).not.toContain(VIR_CRON_MARKER);
  });

  it("removes every vir line if multiple are somehow present", () => {
    const crontab = [
      "0 */3 * * * old vir cmd # vir-cli",
      "0 */6 * * * new vir cmd # vir-cli",
      "0 9 * * * keep-me",
    ].join("\n");
    const result = removeVirLines(crontab).trim();
    expect(result).toBe("0 9 * * * keep-me");
  });

  it("returns an empty string when only vir lines existed", () => {
    expect(removeVirLines("0 */3 * * * vir run # vir-cli")).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import {
  isUserBusUnavailable,
  SystemdNotAvailableError,
  SystemdUserBusUnavailableError,
} from "./systemd.js";

describe("isUserBusUnavailable", () => {
  it("flags a probe whose stderr reports a bus connection failure", () => {
    expect(
      isUserBusUnavailable({
        code: 1,
        stdout: "",
        stderr: "Failed to connect to bus: No such file or directory",
      }),
    ).toBe(true);
  });

  it("matches systemd's newer 'user scope bus' phrasing", () => {
    expect(
      isUserBusUnavailable({
        code: 1,
        stdout: "",
        stderr:
          "Failed to connect to user scope bus via local transport: No such file or directory",
      }),
    ).toBe(true);
  });

  it("detects the marker on stdout too (some systemctl builds)", () => {
    expect(
      isUserBusUnavailable({
        code: 1,
        stdout: "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS not set",
        stderr: "",
      }),
    ).toBe(true);
  });

  it("treats a running manager as available", () => {
    expect(
      isUserBusUnavailable({ code: 0, stdout: "running\n", stderr: "" }),
    ).toBe(false);
  });

  it("treats a degraded-but-reachable manager as available", () => {
    // is-system-running exits non-zero for "degraded", but the bus is fine —
    // we must NOT fall back to cron in that case.
    expect(
      isUserBusUnavailable({ code: 1, stdout: "degraded\n", stderr: "" }),
    ).toBe(false);
  });

  it("treats an empty probe as available (no failure marker)", () => {
    expect(isUserBusUnavailable({ code: 0, stdout: "", stderr: "" })).toBe(
      false,
    );
  });
});

describe("systemd error classes", () => {
  it("SystemdUserBusUnavailableError is a distinct named Error", () => {
    const err = new SystemdUserBusUnavailableError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SystemdUserBusUnavailableError");
    // Must not collide with the "systemctl missing" case — the router treats
    // them as separate fall-back triggers.
    expect(err).not.toBeInstanceOf(SystemdNotAvailableError);
  });
});

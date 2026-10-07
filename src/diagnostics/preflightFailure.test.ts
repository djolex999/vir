import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PREFLIGHT_FAIL_MARKER_PATH,
  clearPreflightFailure,
  preflightFailureCheck,
  preflightFailureNotice,
  readPreflightFailure,
  recordPreflightFailure,
} from "./preflightFailure.js";

// A failed provider preflight used to be invisible: the daemon threw, the
// stack trace went to daemon.log, and no error rows were recorded — so neither
// failureNotice nor doctor's distill-failures row ever fired. From 2026-09-23
// every run died on an expired claude-cli OAuth session with no signal.

const AUTH_MSG =
  "claude-cli exited 1: Failed to authenticate: OAuth session expired and could not be refreshed";

describe("preflight failure marker", () => {
  let dir: string;
  let marker: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vir-preflight-"));
    marker = join(dir, "provider-preflight.failed");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to a path under ~/.vir, next to the claude-cli limit marker", () => {
    expect(PREFLIGHT_FAIL_MARKER_PATH).toMatch(/\.vir[/\\]provider-preflight\.failed$/);
  });

  it("reads back what was recorded", () => {
    recordPreflightFailure(
      { at: "2026-09-23T08:00:00.000Z", provider: "claude-cli", message: AUTH_MSG },
      marker,
    );
    expect(readPreflightFailure(marker)).toEqual({
      at: "2026-09-23T08:00:00.000Z",
      provider: "claude-cli",
      message: AUTH_MSG,
    });
  });

  it("reads null when no failure is recorded", () => {
    expect(readPreflightFailure(marker)).toBeNull();
  });

  it("reads null for a corrupt marker instead of throwing", () => {
    writeFileSync(marker, "not json", "utf8");
    expect(readPreflightFailure(marker)).toBeNull();
  });

  it("clear removes the marker and is a no-op when none exists", () => {
    recordPreflightFailure(
      { at: "2026-09-23T08:00:00.000Z", provider: "anthropic", message: "fetch failed" },
      marker,
    );
    clearPreflightFailure(marker);
    expect(existsSync(marker)).toBe(false);
    expect(() => clearPreflightFailure(marker)).not.toThrow();
  });

  it("record never throws when the directory is unwritable", () => {
    expect(() =>
      recordPreflightFailure(
        { at: "2026-09-23T08:00:00.000Z", provider: "anthropic", message: "x" },
        join(dir, "missing", "deeper", "marker"),
      ),
    ).not.toThrow();
  });
});

describe("preflightFailureNotice", () => {
  it("tells a logged-out claude-cli user to run claude and /login", () => {
    const n = preflightFailureNotice("claude-cli", AUTH_MSG);
    expect(n.title).toMatch(/claude-cli/);
    expect(n.message).toMatch(/`claude`/);
    expect(n.message).toMatch(/\/login/);
  });

  it("names the provider and the error for other failures", () => {
    const n = preflightFailureNotice("anthropic", "fetch failed");
    expect(n.title).toMatch(/anthropic/);
    expect(n.message).toContain("fetch failed");
  });

  it("keeps a long error short enough for a desktop notification", () => {
    const n = preflightFailureNotice("kie", "x".repeat(1000));
    expect(n.message.length).toBeLessThanOrEqual(200);
  });
});

describe("preflightFailureCheck", () => {
  const NOW = Date.parse("2026-09-24T12:00:00Z");

  it("emits no row when the last preflight succeeded", () => {
    expect(preflightFailureCheck(null, NOW)).toBeNull();
  });

  it("a recent failure is a fail row naming when, which provider, and why", () => {
    const r = preflightFailureCheck(
      { at: "2026-09-23T08:00:00.000Z", provider: "claude-cli", message: AUTH_MSG },
      NOW,
    );
    expect(r?.status).toBe("fail");
    expect(r?.label).toBe("provider preflight");
    expect(r?.detail).toContain("2026-09-23");
    expect(r?.detail).toContain("claude-cli");
    expect(r?.detail).toMatch(/OAuth session expired/);
    expect(r?.detail).toMatch(/\/login/);
  });

  it("a stale failure (daemon not run since) degrades to warn", () => {
    const r = preflightFailureCheck(
      { at: "2026-09-01T08:00:00.000Z", provider: "anthropic", message: "fetch failed" },
      NOW,
    );
    expect(r?.status).toBe("warn");
  });
});

describe("preflightFailureNotice — codex-cli", () => {
  it("names the codex login fix for an auth failure", () => {
    const n = preflightFailureNotice("codex-cli", "codex exec failed (exit 1): 401 Unauthorized");
    expect(n.message).toBe("Codex is logged out — run `codex login`, then `vir run`");
  });
});

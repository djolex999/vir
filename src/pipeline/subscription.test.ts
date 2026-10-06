import { describe, expect, it } from "vitest";
import { ClaudeCliLimitError } from "./claudeCli.js";
import { CodexCliError, CodexCliLimitError } from "./codexCli.js";
import { costForRecord, isRetryable } from "./distiller.js";
import { isSubscriptionProvider, resolveBin, SubscriptionLimitError } from "./subscription.js";

describe("subscription providers", () => {
  it("claude-cli and codex-cli bill quota, the API providers bill dollars", () => {
    expect(isSubscriptionProvider("claude-cli")).toBe(true);
    expect(isSubscriptionProvider("codex-cli")).toBe(true);
    expect(isSubscriptionProvider("anthropic")).toBe(false);
    expect(isSubscriptionProvider("kie")).toBe(false);
  });

  it("a codex-cli call records a null cost, never $0", () => {
    expect(costForRecord("codex-cli", "default", 1000, 100, undefined, "standard")).toBeNull();
  });

  it("ClaudeCliLimitError is a SubscriptionLimitError, so one catch halts both", () => {
    expect(new ClaudeCliLimitError("weekly", null)).toBeInstanceOf(SubscriptionLimitError);
  });

  it("resolveBin looks on PATH, then common install dirs, then falls back to the bare name", () => {
    const exists = (p: string) => p === "/opt/homebrew/bin/codex";
    expect(resolveBin("codex", { path: "/usr/bin", execDir: "/n", home: "/h", exists })).toBe("/opt/homebrew/bin/codex");
    expect(resolveBin("codex", { path: "", execDir: "/n", home: "/h", exists: () => false })).toBe("codex");
  });

  it("codex-cli failures never enter a retry chain", () => {
    expect(isRetryable(new CodexCliLimitError(null))).toBe(false);
    expect(isRetryable(new CodexCliError("boom", 1))).toBe(false);
  });
});

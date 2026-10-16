import { describe, expect, it } from "vitest";
import { ClaudeCliError, ClaudeCliLimitError } from "../src/pipeline/claudeCli.js";
import { isTransientCliError, withTransientCliRetry } from "./llm.js";

const NO_MESSAGES = new ClaudeCliError(
  "claude -p produced no parseable JSON envelope (exit 1): Error: No messages returned from query",
  1,
);

describe("isTransientCliError", () => {
  it("matches only the empty-envelope 'No messages returned' failure", () => {
    expect(isTransientCliError(NO_MESSAGES)).toBe(true);
    expect(isTransientCliError(new ClaudeCliError("claude -p failed (exit 1): invalid model", 1))).toBe(false);
    expect(isTransientCliError(new ClaudeCliError("claude -p produced no parseable JSON envelope (exit 1): Error: something else", 1))).toBe(false);
    expect(isTransientCliError(new ClaudeCliLimitError("session", null))).toBe(false);
    expect(isTransientCliError(new Error("No messages returned from query"))).toBe(false);
  });
});

describe("withTransientCliRetry", () => {
  const noSleep = async (): Promise<void> => {};

  it("retries the transient failure and returns the eventual result", async () => {
    let calls = 0;
    const out = await withTransientCliRetry(async () => {
      calls += 1;
      if (calls < 3) throw NO_MESSAGES;
      return "ok";
    }, noSleep);
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after the last delay and rethrows the transient error", async () => {
    let calls = 0;
    await expect(
      withTransientCliRetry(async () => {
        calls += 1;
        throw NO_MESSAGES;
      }, noSleep),
    ).rejects.toBe(NO_MESSAGES);
    expect(calls).toBe(4);
  });

  it("never retries a limit or an ordinary failure", async () => {
    for (const err of [new ClaudeCliLimitError("weekly", null), new ClaudeCliError("claude -p failed (exit 1): nope", 1)]) {
      let calls = 0;
      await expect(
        withTransientCliRetry(async () => {
          calls += 1;
          throw err;
        }, noSleep),
      ).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });
});

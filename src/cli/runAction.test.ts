import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAction } from "./runAction.js";

describe("runAction", () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it("awaits a successful handler and leaves exitCode at 0", async () => {
    let called = false;
    const wrapped = runAction(async () => {
      called = true;
    });
    await wrapped();
    expect(called).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("forwards arguments through to the wrapped handler", async () => {
    const received: unknown[] = [];
    const wrapped = runAction(async (a: string, b: number) => {
      received.push(a, b);
    });
    await wrapped("hello", 42);
    expect(received).toEqual(["hello", 42]);
  });

  it("sets exitCode = 1 and logs the error message when the handler throws", async () => {
    const logged: string[] = [];
    const wrapped = runAction(
      async () => {
        throw new Error("boom");
      },
      { logError: (m) => logged.push(m) },
    );
    await wrapped();
    expect(process.exitCode).toBe(1);
    expect(logged).toEqual(["boom"]);
  });

  it("handles non-Error throws without crashing", async () => {
    const logged: string[] = [];
    const wrapped = runAction(
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "plain string failure";
      },
      { logError: (m) => logged.push(m) },
    );
    await wrapped();
    expect(process.exitCode).toBe(1);
    expect(logged).toEqual(["plain string failure"]);
  });

  it("never calls process.exit — only sets process.exitCode", async () => {
    // process.exit being called would terminate the test process; reaching
    // the assertion after the wrapped call proves we did not call exit.
    const wrapped = runAction(async () => {
      throw new Error("would-have-exited");
    });
    await wrapped();
    expect(process.exitCode).toBe(1);
  });
});

import { describe, expect, it, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ClaudeCliError,
  ClaudeCliLimitError,
  buildClaudeCliArgs,
  callClaudeCli,
  parseCliEnvelope,
  parseLimitMessage,
  resetRawEnvelopeLogGate,
} from "./claudeCli.js";

describe("buildClaudeCliArgs — correctness flags cannot be omitted", () => {
  it("always includes -p, --output-format json, and --no-session-persistence", () => {
    const args = buildClaudeCliArgs("claude-sonnet-5");
    expect(args).toContain("-p");
    expect(args).toContain("--no-session-persistence");
    const fmt = args.indexOf("--output-format");
    expect(fmt).toBeGreaterThanOrEqual(0);
    expect(args[fmt + 1]).toBe("json");
  });

  it("pins the model per invocation", () => {
    const args = buildClaudeCliArgs("claude-haiku-4-5-20251001");
    const m = args.indexOf("--model");
    expect(args[m + 1]).toBe("claude-haiku-4-5-20251001");
  });

  it("takes only a model — there is no parameter that could drop the safety flags", () => {
    // The signature itself is the guarantee: no options object exists whose
    // omission or misuse could remove --no-session-persistence.
    expect(buildClaudeCliArgs.length).toBe(1);
  });
});

describe("parseLimitMessage — docs-sourced pattern, treated as unverified", () => {
  it("matches the documented session-limit shape and extracts the reset time", () => {
    const m = parseLimitMessage("You've hit your session limit · resets 3:45pm");
    expect(m).toEqual({ kind: "session", resetsAt: "3:45pm" });
  });

  it("matches weekly and Opus variants", () => {
    expect(
      parseLimitMessage("You've hit your weekly limit · resets Mon 12:00am"),
    ).toEqual({ kind: "weekly", resetsAt: "Mon 12:00am" });
    expect(
      parseLimitMessage("You've hit your Opus limit · resets 3:45pm")?.kind,
    ).toBe("opus");
  });

  it("returns null for every other error text — misclassification must fail toward ordinary handling", () => {
    expect(parseLimitMessage("Invalid API key")).toBeNull();
    expect(parseLimitMessage("There's an issue with the selected model")).toBeNull();
    expect(parseLimitMessage("")).toBeNull();
  });
});

describe("parseCliEnvelope", () => {
  it("parses a success envelope", () => {
    const env = parseCliEnvelope(
      JSON.stringify({
        is_error: false,
        result: "## Summary\nnote body",
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    );
    expect(env?.is_error).toBe(false);
    expect(env?.result).toBe("## Summary\nnote body");
    expect(env?.usage?.output_tokens).toBe(50);
  });

  it("returns null on non-JSON stdout", () => {
    expect(parseCliEnvelope("claude: command crashed")).toBeNull();
  });
});

// ── callClaudeCli via injected spawn ────────────────────────────────────────

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: { cwd?: string };
}

function fakeChild(stdout: string, stderr: string, code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { written: string; write: (s: string) => void; end: () => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  child.stdin = {
    written: "",
    write(s: string) {
      child.stdin.written += s;
    },
    end() {
      queueMicrotask(() => {
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", code);
      });
    },
  };
  return child;
}

function spawnRecorder(stdout: string, stderr = "", code = 0) {
  const calls: SpawnCall[] = [];
  const impl = (cmd: string, args: string[], opts: { cwd?: string }) => {
    calls.push({ cmd, args, opts });
    return fakeChild(stdout, stderr, code);
  };
  return { calls, impl };
}

const OK_ENVELOPE = JSON.stringify({
  is_error: false,
  result: "distilled text",
  usage: { input_tokens: 1000, output_tokens: 200 },
});

beforeEach(() => resetRawEnvelopeLogGate());

describe("callClaudeCli", () => {
  it("spawns `claude` with arg array, prompt on stdin, cwd pinned to ~/.vir", async () => {
    const { calls, impl } = spawnRecorder(OK_ENVELOPE);
    const res = await callClaudeCli(
      { prompt: "the prompt", model: "claude-sonnet-5" },
      { spawnImpl: impl },
    );
    expect(res.text).toBe("distilled text");
    expect(res.usage).toEqual({ input_tokens: 1000, output_tokens: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("claude");
    expect(calls[0]!.args).toContain("--no-session-persistence");
    // Neutral cwd is a correctness requirement (a project cwd would load that
    // project's CLAUDE.md into the distill context) and is NOT injectable.
    expect(calls[0]!.opts.cwd).toBe(join(homedir(), ".vir"));
  });

  it("throws ClaudeCliLimitError (with reset time) on the documented limit message and stamps the marker", async () => {
    const marker: string[] = [];
    const { impl } = spawnRecorder(
      JSON.stringify({
        is_error: true,
        result: "You've hit your weekly limit · resets Mon 12:00am",
      }),
      "",
      1,
    );
    await expect(
      callClaudeCli(
        { prompt: "p", model: "claude-sonnet-5" },
        { spawnImpl: impl, writeMarker: (s) => marker.push(s) },
      ),
    ).rejects.toThrow(ClaudeCliLimitError);
    expect(marker).toHaveLength(1);
    expect(marker[0]).toContain("weekly");
  });

  it("logs the raw envelope ONCE per run for unrecognized errors, then falls through to ordinary failure", async () => {
    const logged: string[] = [];
    const bad = JSON.stringify({ is_error: true, result: "Something else broke", api_error_status: 500 });
    const { impl } = spawnRecorder(bad, "", 1);
    const opts = { spawnImpl: impl, logRaw: (s: string) => logged.push(s) };

    await expect(
      callClaudeCli({ prompt: "p", model: "claude-sonnet-5" }, opts),
    ).rejects.toThrow(ClaudeCliError);
    await expect(
      callClaudeCli({ prompt: "p", model: "claude-sonnet-5" }, opts),
    ).rejects.toThrow(ClaudeCliError);

    // First real limit hit must leave evidence — but only one line per run.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("Something else broke");
  });

  it("non-JSON stdout becomes a ClaudeCliError carrying exit code and stderr", async () => {
    const { impl } = spawnRecorder("", "claude: boom", 2);
    await expect(
      callClaudeCli(
        { prompt: "p", model: "claude-sonnet-5" },
        { spawnImpl: impl },
      ),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("kills a hung process at the timeout", async () => {
    const child = fakeChild("", "", 0);
    // stdin.end never emits close — simulate a hang by overriding it.
    child.stdin.end = () => {};
    await expect(
      callClaudeCli(
        { prompt: "p", model: "claude-sonnet-5" },
        { spawnImpl: () => child, timeoutMs: 20 },
      ),
    ).rejects.toThrow(/timed out/i);
    expect(child.killed).toBe(true);
  });
});

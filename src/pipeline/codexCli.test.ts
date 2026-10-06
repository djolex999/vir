import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCodexCliArgs,
  callCodexCli,
  CodexCliError,
  CodexCliLimitError,
  parseCodexJsonl,
  resetCodexRawLogGate,
  type CallCodexCliTestOpts,
} from "./codexCli.js";
import { SubscriptionLimitError } from "./subscription.js";

type SpawnImpl = NonNullable<CallCodexCliTestOpts["spawnImpl"]>;

function fakeChild(stdout: string, code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { written: string; write: (s: string) => void; end: () => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.stdin = {
    written: "",
    write(s: string) {
      child.stdin.written += s;
    },
    end() {
      queueMicrotask(() => {
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        child.emit("close", code);
      });
    },
  };
  return child;
}

function spawnRecorder(stdout: string, code = 0) {
  const calls: Array<{ cmd: string; args: string[]; cwd: string; stdin: () => string }> = [];
  const impl = (cmd: string, args: string[], opts: { cwd: string }) => {
    const child = fakeChild(stdout, code);
    calls.push({ cmd, args, cwd: opts.cwd, stdin: () => child.stdin.written });
    return child;
  };
  return { calls, impl: impl as unknown as SpawnImpl };
}

// Real shapes, codex-cli 0.160.1 (2026-10-07).
const OK = [
  { type: "thread.started", thread_id: "t" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "draft" } },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: '{"ok":true}' } },
  { type: "turn.completed", usage: { input_tokens: 19004, cached_input_tokens: 12288, output_tokens: 9, reasoning_output_tokens: 3 } },
].map((e) => JSON.stringify(e)).join("\n");

const BAD_MODEL = [
  { type: "thread.started", thread_id: "t" },
  { type: "turn.started" },
  { type: "error", message: '{"type":"error","status":400,"error":{"message":"The \'x\' model is not supported when using Codex with a ChatGPT account."}}' },
  { type: "turn.failed", error: { message: '{"type":"error","status":400,"error":{"message":"The \'x\' model is not supported when using Codex with a ChatGPT account."}}' } },
].map((e) => JSON.stringify(e)).join("\n");

beforeEach(() => resetCodexRawLogGate());

describe("buildCodexCliArgs", () => {
  it("always runs ephemeral, read-only, JSON, prompt on stdin", () => {
    const args = buildCodexCliArgs("default");
    expect(args).toEqual([
      "exec", "--ephemeral", "--json", "--skip-git-repo-check",
      "-s", "read-only", "--ignore-user-config", "-",
    ]);
  });

  it("pins a model unless it is 'default'", () => {
    const args = buildCodexCliArgs("gpt-5.5");
    expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", "gpt-5.5"]);
    expect(args).toContain("--ephemeral");
    expect(args.at(-1)).toBe("-");
  });
});

describe("parseCodexJsonl", () => {
  it("returns the last agent message and real usage", () => {
    expect(parseCodexJsonl(OK)).toEqual({
      text: '{"ok":true}',
      usage: { input_tokens: 19004, output_tokens: 12 },
      error: null,
    });
  });

  it("surfaces the turn.failed message and skips garbage lines", () => {
    const r = parseCodexJsonl("not json\n" + BAD_MODEL + "\n{\"type\":\"trunc");
    expect(r.text).toBe("");
    expect(r.error).toContain("not supported when using Codex with a ChatGPT account");
  });
});

describe("callCodexCli", () => {
  it("spawns codex with the prompt on stdin and cwd pinned to ~/.vir", async () => {
    const rec = spawnRecorder(OK);
    const r = await callCodexCli({ prompt: "PROMPT", model: "default" }, { spawnImpl: rec.impl, codexBin: "/bin/codex" });
    expect(r).toEqual({ text: '{"ok":true}', usage: { input_tokens: 19004, output_tokens: 12 } });
    expect(rec.calls[0]?.cmd).toBe("/bin/codex");
    expect(rec.calls[0]?.cwd).toBe(join(homedir(), ".vir"));
    expect(rec.calls[0]?.stdin()).toBe("PROMPT");
  });

  it("throws CodexCliError on a failed turn, logging the raw output once", async () => {
    const logged: string[] = [];
    const rec = spawnRecorder(BAD_MODEL, 1);
    const call = () => callCodexCli({ prompt: "p", model: "x" }, { spawnImpl: rec.impl, codexBin: "c", logRaw: (l) => logged.push(l) });
    await expect(call()).rejects.toBeInstanceOf(CodexCliError);
    await expect(call()).rejects.toThrow(/not supported when using Codex/);
    expect(logged).toHaveLength(1);
  });

  it("throws CodexCliError when the turn completes with no agent message", async () => {
    const rec = spawnRecorder(JSON.stringify({ type: "turn.completed", usage: {} }));
    await expect(callCodexCli({ prompt: "p", model: "default" }, { spawnImpl: rec.impl, codexBin: "c" })).rejects.toBeInstanceOf(CodexCliError);
  });

  it("treats a usage-limit failure as a SubscriptionLimitError", async () => {
    const out = JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again in 3 hours." } });
    const rec = spawnRecorder(out, 1);
    const err = await callCodexCli({ prompt: "p", model: "default" }, { spawnImpl: rec.impl, codexBin: "c", logRaw: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexCliLimitError);
    expect(err).toBeInstanceOf(SubscriptionLimitError);
    expect((err as CodexCliLimitError).resetsAt).toBe("in 3 hours");
  });
});

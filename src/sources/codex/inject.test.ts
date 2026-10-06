import { describe, expect, it } from "vitest";
import { stripCodexInjected } from "./inject.js";

describe("stripCodexInjected", () => {
  it.each([
    "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>",
    "# AGENTS.md instructions for /Users/me/p\n\n<INSTRUCTIONS>…",
    " # In app browser:\n- The user has the in-app browser open",
    "<recommended_plugins> Here is a list…",
    "<external_codex_apps_open_page>{\"page_id\":1}",
    "<in-app-browser-context>…",
    "<turn_aborted>\nThe user interrupted the previous turn on purpose.",
    "<skill>\nname: foo",
    "<image name=[Image #1]> </image>",
    "## Referenced ChatGPT conversation\n…",
    "The following is the Codex agent history whose request…",
  ])("drops harness context %#", (t) => expect(stripCodexInjected(t)).toBeNull());

  it("keeps only the request when a wrapper carries the marker", () => {
    expect(stripCodexInjected(
      "# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n\n## My request for Codex:\nmove auth to middleware\n",
    )).toBe("move auth to middleware");
  });

  // Local data: 32 of 141 markers are the short form. Read as a file section,
  // it would swallow the request.
  it("accepts the short '## My request:' marker", () => {
    expect(stripCodexInjected(
      "\n# Files mentioned by the user:\n\n## a.docx: /tmp/a.docx\n\n## My request:\nsummarize this doc\n",
    )).toBe("summarize this doc");
  });

  // In-app browser and referenced-chat context wrap a real request (21/21 locally).
  it.each([
    "\n# In app browser:\n- The user has the in-app browser open.\n- Current URL: file:///x.html\n\n## My request for Codex:\nmake the header sticky",
    "\n<in-app-browser-context source=\"ambient-ui-state\">\nThis context is UI state.\n</in-app-browser-context>\n\n## My request for Codex:\nmake the header sticky",
    "\n## Referenced ChatGPT conversation:\nThis is a referenced chat.\n{\"id\":\"x\"}\n\n## My request for Codex:\nmake the header sticky",
  ])("keeps the request a context wrapper carries %#", (t) =>
    expect(stripCodexInjected(t)).toBe("make the header sticky"));

  it("drops image tag lines but keeps the placeholder", () => {
    expect(stripCodexInjected(
      "# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\n\n## My request for Codex:\nwhy is this red\n<image name=[Image #1]>\n[input_image]\n</image>",
    )).toBe("why is this red\n[input_image]");
  });

  it("drops every image tag variant from an ordinary prompt", () => {
    expect(stripCodexInjected(
      "fix the layout\n<image>\n[input_image]\n</image>\n<image name=[Image #2] path=\"/var/x.png\">\n[input_image]\n</image>",
    )).toBe("fix the layout\n[input_image]\n[input_image]");
  });

  it("ignores a marker inside an ordinary prompt", () => {
    const t = "explain this template:\n## My request:\nfill me in";
    expect(stripCodexInjected(t)).toBe(t);
  });

  it("strips file sections and keeps trailing prose when a wrapper has no marker", () => {
    expect(stripCodexInjected(
      " # Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\n\n[input_image]\nwhy is this red",
    )).toBe("why is this red");
  });

  it("drops a marker-less wrapper that is nothing but file sections", () => {
    expect(stripCodexInjected("# Files pasted by the user:\n\n## a.ts\nconst x = 1;\n")).toBeNull();
  });

  it("passes ordinary prompts and markdown-heading prompts through", () => {
    expect(stripCodexInjected("commit i push")).toBe("commit i push");
    expect(stripCodexInjected("# Build: portfolio site\nStack: Next.js")).toBe("# Build: portfolio site\nStack: Next.js");
  });
});

// Codex stores harness context as role:"user" messages. Drop it, or keep only
// the request it wraps. Prefixes verified on 551 unique local user messages
// (cli 0.130–0.160). Users also write "# Heading" prompts, so only these
// exact prefixes are harness; anything else passes through.

// Pure context: never carries a user request. The agent-history dumps do
// contain request markers, but they replay earlier turns — keeping them would
// double-count.
export const DROP_PREFIXES = [
  "<environment_context>",
  "# AGENTS.md instructions",
  "<recommended_plugins>",
  "<external_codex_apps_",
  "<turn_aborted>",
  "<skill>",
  "<image name=",
  "The following is the Codex agent history",
] as const;

// Context that wraps a real request. Locally every one of them (92 file/IDE,
// 21 browser/referenced-chat) carries a request marker.
export const WRAPPER_PREFIXES = [
  "# Context from my IDE setup:",
  "# Files mentioned by the user:",
  "# Files pasted by the user:",
  "# In app browser:",
  "<in-app-browser-context",
  "## Referenced ChatGPT conversation",
] as const;

// Without a marker, only the file wrappers can still hold trailing prose; the
// browser/referenced-chat context is dropped.
const FILE_WRAPPERS: readonly string[] = WRAPPER_PREFIXES.slice(0, 3);

// Both forms occur: "## My request for Codex:" (109) and "## My request:" (32).
const REQUEST_MARKER = /^## My request(?: for Codex)?:[^\n]*$/gm;

// <image>, </image>, <image name=[Image #1]>, <image name=[Image #1] path="…">
const IMAGE_TAG = /^<\/?image\b[^>]*>$/;
const PLACEHOLDER = /^\[[a-z_]+\]$/;

function withoutImageTags(text: string): string {
  return text
    .split("\n")
    .filter((l) => !IMAGE_TAG.test(l.trim()))
    .join("\n")
    .trim();
}

// Without the marker: drop every "## <section>" block and bare [type]
// placeholders; whatever prose follows the last section is the request.
function trailingProse(body: string): string {
  const lines = body.split("\n");
  let lastHeader = -1;
  lines.forEach((l, i) => {
    if (/^##\s/.test(l)) lastHeader = i;
  });
  // The last section's own content runs to the first blank line after its header.
  let start = lastHeader + 1;
  if (lastHeader !== -1) {
    while (start < lines.length && lines[start]?.trim() !== "") start += 1;
  }
  return lines
    .slice(start)
    .filter((l) => !PLACEHOLDER.test(l.trim()))
    .join("\n")
    .trim();
}

export function stripCodexInjected(text: string): string | null {
  const t = text.trimStart();
  if (DROP_PREFIXES.some((p) => t.startsWith(p))) return null;
  const wrapper = WRAPPER_PREFIXES.find((p) => t.startsWith(p));
  if (wrapper === undefined) return withoutImageTags(text) || null;
  const markers = [...t.matchAll(REQUEST_MARKER)];
  const last = markers.at(-1);
  if (last !== undefined) {
    return withoutImageTags(t.slice(last.index + last[0].length)) || null;
  }
  if (!FILE_WRAPPERS.includes(wrapper)) return null;
  return withoutImageTags(trailingProse(t.slice(wrapper.length))) || null;
}

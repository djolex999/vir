// Bounded tool context for the distill stage.
//
// The parser emits tool calls into the transcript using the block grammar
// defined here (renderToolUse / renderToolResult). This module is the single
// owner of that grammar: it both renders the blocks and parses them back out,
// so the two can never drift. The distiller historically saw zero tool output
// (the parser dropped it); now it sees commands, errors, and short results,
// while large outputs (file reads, long bash logs, big grep dumps) are stripped
// to keep token cost bounded.

export type FilterMode = "aggressive" | "moderate" | "off";

// Tools whose results are routinely huge and rarely worth keeping in full.
const LARGE_OUTPUT_TOOLS = new Set(["Bash", "Read", "Grep", "Glob"]);

const AGGRESSIVE_LINE_THRESHOLD = 20;
const MODERATE_LINE_THRESHOLD = 50;

// tool_use inputs carry whole file bodies (Write content, Edit strings). We keep
// the *intent* (file_path, command, description, pattern, query, …) untouched
// and only truncate these large embedded-content fields past a char limit.
// Char limits per mode: "content" fields (whole-file writes) vs "edit" strings.
const CONTENT_LIMIT = { moderate: 2000, aggressive: 1000 } as const;
const EDIT_LIMIT = { moderate: 1000, aggressive: 500 } as const;

const RESULT_CLOSE = "[/tool_result]";

export interface FilterResult {
  filtered: string;
  originalTokens: number;
  filteredTokens: number;
  tokensSaved: number;
  toolCallsStripped: number;
  skillResultsStripped: number;
}

// Reporting heuristic only — never used for billing. ~4 chars per token.
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// Skill tool results are boilerplate skill-loading content — never durable
// knowledge — so we strip them regardless of filter mode.
const SKILL_RESULT_CHAR_LIMIT = 1000;

// Matches a Skill tool_use immediately followed by its (non-error) tool_result.
// The " ERROR" variant won't match because the pattern omits it — error results
// are left alone intentionally.
const SKILL_PAIR_RE =
  /\[tool_use: Skill\] (.+)\n\n\[tool_result: Skill\]\n([\s\S]*?)\n\[\/tool_result\]/g;

function stripSkillResults(text: string): {
  text: string;
  skillResultsStripped: number;
} {
  let skillResultsStripped = 0;
  const result = text.replace(
    SKILL_PAIR_RE,
    (match, useJson: string, body: string) => {
      if (body.length <= SKILL_RESULT_CHAR_LIMIT) return match;

      let name = "skill";
      try {
        const parsed: unknown = JSON.parse(useJson);
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          const candidate =
            typeof obj["skill"] === "string"
              ? obj["skill"]
              : typeof obj["command"] === "string"
                ? obj["command"]
                : typeof obj["name"] === "string"
                  ? obj["name"]
                  : null;
          if (candidate !== null) name = candidate;
        }
      } catch {
        // unparseable JSON — keep fallback "skill"
      }

      skillResultsStripped += 1;
      const useLine = `[tool_use: Skill] ${useJson}`;
      return `${useLine}\n\n[tool_result: Skill] [Skill ${name} loaded]`;
    },
  );
  return { text: result, skillResultsStripped };
}

export function renderToolUse(name: string, inputJson: string): string {
  return `[tool_use: ${name}] ${inputJson}`;
}

export function renderToolResult(
  name: string,
  content: string,
  isError: boolean,
): string {
  // Defang any literal close marker inside real output so it can't truncate
  // the block when we parse it back out.
  const safe = content.split(RESULT_CLOSE).join("[ /tool_result]");
  const header = `[tool_result: ${name}${isError ? " ERROR" : ""}]`;
  return `${header}\n${safe}\n${RESULT_CLOSE}`;
}

// Matches a rendered tool_result block: header, content (non-greedy), close.
// Tool names are word chars plus . and - (covers Bash, Read, mcp__srv__tool).
const TOOL_RESULT_RE =
  /\[tool_result: ([\w.-]+)( ERROR)?\]\n([\s\S]*?)\n\[\/tool_result\]/g;

// tool_use is rendered on a single line ([tool_use: Name] <single-line JSON>),
// so a non-newline-crossing capture grabs the whole input object.
const TOOL_USE_RE = /\[tool_use: ([\w.-]+)\] (.+)/g;

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split("\n").length;
}

function maybeTruncate(
  obj: Record<string, unknown>,
  field: string,
  limit: number,
  tool: string,
): void {
  const v = obj[field];
  if (typeof v === "string" && v.length > limit) {
    obj[field] = `[truncated ${v.length} chars of ${field} for ${tool}]`;
  }
}

// Trim large embedded-content fields out of a tool_use input, preserving every
// other field (paths, commands, descriptions) verbatim. Returns the original
// JSON untouched if it doesn't parse to an object.
function boundToolUseInput(
  name: string,
  json: string,
  mode: "moderate" | "aggressive",
): string {
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    return json;
  }
  if (!input || typeof input !== "object") return json;
  const obj = input as Record<string, unknown>;
  const content = CONTENT_LIMIT[mode];
  const edit = EDIT_LIMIT[mode];

  switch (name) {
    case "Write":
      maybeTruncate(obj, "content", content, name);
      break;
    case "Edit":
      maybeTruncate(obj, "old_string", edit, name);
      maybeTruncate(obj, "new_string", edit, name);
      break;
    case "MultiEdit":
      if (Array.isArray(obj.edits)) {
        for (const e of obj.edits) {
          if (e && typeof e === "object") {
            const ed = e as Record<string, unknown>;
            maybeTruncate(ed, "old_string", edit, name);
            maybeTruncate(ed, "new_string", edit, name);
          }
        }
      }
      break;
    case "NotebookEdit":
      maybeTruncate(obj, "new_source", content, name);
      break;
    default:
      return json;
  }
  return JSON.stringify(obj);
}

export function filterToolCalls(
  sessionText: string,
  mode: FilterMode,
): FilterResult {
  const originalTokens = estimateTokens(sessionText);

  // Skill strip always runs — Skill loads are boilerplate regardless of mode.
  const { text: afterSkills, skillResultsStripped } =
    stripSkillResults(sessionText);

  if (mode === "off") {
    const filteredTokens = estimateTokens(afterSkills);
    return {
      filtered: afterSkills,
      originalTokens,
      filteredTokens,
      tokensSaved: Math.max(0, originalTokens - filteredTokens),
      toolCallsStripped: 0,
      skillResultsStripped,
    };
  }

  const threshold =
    mode === "aggressive"
      ? AGGRESSIVE_LINE_THRESHOLD
      : MODERATE_LINE_THRESHOLD;

  // First bound oversized tool_use payloads (Write/Edit file bodies), keeping
  // intent fields intact. Done before the tool_result pass so the two regexes
  // never compete over the same span.
  const usesBounded = afterSkills.replace(
    TOOL_USE_RE,
    (_match, name: string, json: string) =>
      renderToolUse(name, boundToolUseInput(name, json, mode)),
  );

  let toolCallsStripped = 0;
  const filtered = usesBounded.replace(
    TOOL_RESULT_RE,
    (_match, name: string, errorFlag: string | undefined, content: string) => {
      const isError = Boolean(errorFlag);
      const lines = lineCount(content);
      const isLarge = LARGE_OUTPUT_TOOLS.has(name);

      // Keep errors always (the failure is the signal), keep anything that
      // isn't a known big-output tool, and keep small results regardless.
      // Only large-output tools over the threshold get stripped. Kept blocks
      // drop the closing fence — it's parser plumbing, not signal for the LLM.
      if (isError || !isLarge || lines <= threshold) {
        const header = `[tool_result: ${name}${isError ? " ERROR" : ""}]`;
        return `${header}\n${content}`;
      }

      toolCallsStripped += 1;
      return `[tool_result: ${name} output, ${lines} lines, stripped]`;
    },
  );

  const filteredTokens = estimateTokens(filtered);
  return {
    filtered,
    originalTokens,
    filteredTokens,
    tokensSaved: Math.max(0, originalTokens - filteredTokens),
    toolCallsStripped,
    skillResultsStripped,
  };
}

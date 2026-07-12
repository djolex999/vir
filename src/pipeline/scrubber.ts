import { homedir } from "node:os";
import { basename } from "node:path";

const HOME = homedir();

const PATTERNS: Array<{ re: RegExp; replace: string | ((m: string) => string) }> = [
  // Anthropic API keys. The lookbehind blocks mid-word matches inside
  // kebab-case identifiers ("risk-ant-…" must not redact); a real key is
  // preceded by whitespace/quote/=/start, never by [A-Za-z0-9-].
  {
    re: /(?<![A-Za-z0-9-])sk-ant-[A-Za-z0-9_-]{20,}/g,
    replace: "[REDACTED_ANTHROPIC_KEY]",
  },
  // OpenAI API keys — same boundary ("risk-management-strategy-2026-plan"
  // must survive).
  {
    re: /(?<![A-Za-z0-9-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    replace: "[REDACTED_OPENAI_KEY]",
  },
  // Generic bearer tokens. Case-sensitive (prose "the bearer of bad news"
  // must survive; real headers use capital B) and same-line only (\s+ would
  // eat the first word of the line after a trailing "Bearer").
  {
    re: /\bBearer[ \t]+[A-Za-z0-9_\-.=]+/g,
    replace: "Bearer [REDACTED_TOKEN]",
  },
  // GitHub PATs
  { re: /\bghp_[A-Za-z0-9]{30,}\b/g, replace: "[REDACTED_GH_TOKEN]" },
  { re: /\bgho_[A-Za-z0-9]{30,}\b/g, replace: "[REDACTED_GH_TOKEN]" },
  // AWS access keys
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED_AWS_KEY]" },
  // Email addresses
  {
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: "[REDACTED_EMAIL]",
  },
];

export function scrub(input: string): string {
  let out = input;
  for (const { re, replace } of PATTERNS) {
    if (typeof replace === "string") {
      out = out.replace(re, replace);
    } else {
      out = out.replace(re, replace);
    }
  }
  out = normalizePaths(out);
  return out;
}

function normalizePaths(input: string): string {
  // Replace user home prefix
  const homeRe = new RegExp(escapeRegex(HOME), "g");
  let out = input.replace(homeRe, "~");

  // Replace remaining absolute paths with ~/<basename>
  // Match paths like /Users/.../file, /var/..., /tmp/..., /etc/...
  // Conservative: only collapse deeply-nested user-ish paths to avoid mangling /usr/bin/node etc.
  out = out.replace(/\/Users\/[^\s"'`)\]]+/g, (m) => `~/${basename(m)}`);
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

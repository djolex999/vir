// Which lines of a markdown file sit in a fenced code block (fences included),
// following CommonMark: a fence is 3+ backticks or tildes indented at most
// three spaces; a backtick fence's info string has no backticks; a fence
// closes only on a bare run of the same character at least as long; an
// unclosed fence runs to the end. Toggling on any line that merely starts with
// ``` reads inline code (```` ```json ````) as a fence and flips the rest of
// the file.
const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

export function codeLines(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    if (fence === null) {
      const m = line.match(OPEN);
      const run = m?.[1];
      if (run !== undefined && !(run.startsWith("`") && (m?.[2] ?? "").includes("`"))) fence = run;
      out.push(fence !== null);
      continue;
    }
    out.push(true);
    const run = line.match(CLOSE)?.[1];
    if (run !== undefined && run[0] === fence[0] && run.length >= fence.length) fence = null;
  }
  return out;
}

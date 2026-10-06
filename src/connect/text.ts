// Rule and why text is model-written and owner-editable, then shown in the
// terminal for approval and written into CLAUDE.md, which agents read as
// instructions. One normalization, applied at every boundary, so what the
// owner judges is byte-for-byte what gets stored and written:
//  - no C0/C1 control characters (ANSI escapes could hide or recolor text)
//  - no bidi overrides/isolates (could reorder what the owner reads)
//  - no HTML-comment syntax (no fake VIR markers or rule ids)
//  - one line (no injected headings)
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

export function ruleText(text: string): string {
  return text
    .replace(/\r\n|\r|\n|\t/g, " ")
    .replace(CONTROL, "")
    .replace(BIDI, "")
    .replace(/<!--|-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

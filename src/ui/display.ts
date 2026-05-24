import chalk, { type ChalkInstance } from "chalk";
import ora, { type Ora } from "ora";

// ─── palette ────────────────────────────────────────────────────────────────

export const dim = chalk.hex("#4a4a6a");
export const muted = chalk.hex("#6b6b8a");
export const text = chalk.hex("#e8e8f0");
export const accent = chalk.hex("#7c6af7");
export const success = chalk.hex("#4fd1a0");
export const warn = chalk.hex("#f7a26a");
export const errorColor = chalk.hex("#f76a7c");
export const info = chalk.hex("#6ab4f7");

export const colorForCategory: Record<string, ChalkInstance> = {
  pattern: accent,
  gotcha: errorColor,
  decision: info,
  tool: warn,
  // article taxonomy
  concept: info,
  technique: success,
  reference: muted,
  opinion: accent,
};

// ─── glyphs ─────────────────────────────────────────────────────────────────

export const BULLET = "·";
export const ARROW = "→";
export const CHECK = "✓";
export const CROSS = "✗";
export const DASH = "─";
export const SPINNER = "↻";
export const DIAMOND = "⟡";
export const WARN_GLYPH = "⚠";
export const UP_ARROW = "↑";

const DEFAULT_WIDTH = 48;
const BOX_INNER_WIDTH = 42;
const ANSI_RE = /\[[0-9;]*m/g;

// Strips ANSI so width math is correct against displayed characters.
function visible(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function visibleLength(s: string): number {
  return visible(s).length;
}

function padRightVisible(s: string, width: number): string {
  const pad = width - visibleLength(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

function padLeftVisible(s: string, width: number): string {
  const pad = width - visibleLength(s);
  return pad > 0 ? " ".repeat(pad) + s : s;
}

// ─── primitives ─────────────────────────────────────────────────────────────

export function blank(): void {
  console.log("");
}

export function line(s = ""): void {
  console.log(s);
}

export function header(title: string): void {
  console.log(`${accent(DIAMOND)} ${dim("vir")}  ${text(title)}`);
}

export function divider(width = DEFAULT_WIDTH): void {
  console.log(dim(DASH.repeat(width)));
}

export interface BoxOptions {
  title?: string;
  width?: number;
}

export function box(lines: string[], opts: BoxOptions = {}): void {
  const inner = opts.width ?? BOX_INNER_WIDTH;
  const titleText = opts.title ? ` ${opts.title} ` : "";
  const titlePad = inner - visibleLength(titleText);
  const top =
    dim("┌") +
    (opts.title
      ? dim(DASH) + muted(titleText) + dim(DASH.repeat(Math.max(0, titlePad)))
      : dim(DASH.repeat(inner + 2))) +
    dim("┐");
  console.log(top);
  for (const l of lines) {
    console.log(`${dim("│")} ${padRightVisible(l, inner)} ${dim("│")}`);
  }
  console.log(dim("└" + DASH.repeat(inner + 2) + "┘"));
}

export function stat(
  label: string,
  value: string | number,
  color: ChalkInstance = text,
): void {
  console.log(`  ${dim(label + ":")}  ${color(String(value))}`);
}

export function row(icon: string, label: string, detail?: string): void {
  const left = `${icon} ${label}`;
  console.log(detail ? `${left}  ${dim(detail)}` : left);
}

export function spinner(label: string): Ora {
  return ora({
    text: dim(label),
    spinner: "dots",
    color: "gray",
  });
}

export interface SummaryStat {
  value: number | string;
  color?: ChalkInstance;
}

export function summary(stats: Record<string, SummaryStat>): void {
  const parts: string[] = [];
  for (const [label, s] of Object.entries(stats)) {
    const c = s.color ?? text;
    parts.push(`${dim(label)} ${c(String(s.value))}`);
  }
  console.log(parts.join(dim(`  ${BULLET}  `)));
}

// ─── higher-level helpers ──────────────────────────────────────────────────

// Wrap plain prose at `width`, splitting only on spaces. No reflow inside
// paragraphs — newlines in the input are preserved as paragraph breaks.
export function wrap(s: string, width = 60): string {
  const out: string[] = [];
  for (const paragraph of s.split(/\n/)) {
    if (paragraph.length === 0) {
      out.push("");
      continue;
    }
    const words = paragraph.split(/\s+/);
    let line2 = "";
    for (const word of words) {
      if (line2.length === 0) {
        line2 = word;
      } else if (line2.length + 1 + word.length <= width) {
        line2 += " " + word;
      } else {
        out.push(line2);
        line2 = word;
      }
    }
    if (line2.length > 0) out.push(line2);
  }
  return out.join("\n");
}

// Compact note ref → "<dir>/<basename>" form, dropping any vault prefix the
// caller might have. Used in all command output for consistency.
export function shortNotePath(p: string): string {
  // already a category-prefixed ref like "patterns/foo"
  const parts = p.replace(/\.md$/, "").split("/");
  if (parts.length <= 2) return parts.join("/");
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

// Aligned source-list row: "  · patterns/foo            0.84"
export function sourceRow(path: string, score: number, leftWidth = 38): void {
  const left = `  ${dim(BULLET)} ${text(shortNotePath(path))}`;
  const padded = padRightVisible(left, leftWidth);
  const s = score.toFixed(2);
  console.log(`${padded}${muted(padLeftVisible(s, 6))}`);
}

export function categoryRow(category: string, topic: string): void {
  const color = colorForCategory[category] ?? text;
  // pad to 9 so 'decision' (8 chars) still has a visual gap before the topic
  const left = `${dim(BULLET)} ${color(category.padEnd(9))}`;
  console.log(`${left}${text(topic)}`);
}

export type CheckStatus = "ok" | "warn" | "fail";

// Diagnostic row for `vir doctor`: status glyph + fixed-width label + detail.
// `detail` may contain newlines; continuation lines align under the detail
// column. ok → green ✓, warn → amber ✗, fail → red ✗.
export function statusRow(
  status: CheckStatus,
  label: string,
  detail = "",
  labelWidth = 21,
): void {
  const glyph =
    status === "ok"
      ? success(CHECK)
      : status === "warn"
        ? warn(CROSS)
        : errorColor(CROSS);
  const labelColor = status === "ok" ? text : status === "warn" ? warn : errorColor;
  const head = `${glyph} ${padRightVisible(labelColor(label), labelWidth)}`;
  const lines = detail.length > 0 ? detail.split("\n") : [""];
  console.log(`${head}${dim(lines[0] ?? "")}`);
  // glyph(1) + space(1) + label column = labelWidth + 2
  const indent = " ".repeat(labelWidth + 2);
  for (let i = 1; i < lines.length; i += 1) {
    console.log(`${indent}${dim(lines[i] ?? "")}`);
  }
}

export { ora };

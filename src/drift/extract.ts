import { codeLines } from "../lint/codeFences.js";
import { VIR_END, VIR_START } from "../claude/updater.js";
import type { Claim } from "./types.js";

// Concrete, checkable claims in one doc. Deterministic and conservative: a
// claim that might be about the vault, $HOME or another tool is not a claim
// about this repo, so it is left out rather than reported as drift.

export interface ExtractContext {
  // CLI names this repo ships (package.json `bin`).
  bins: Set<string>;
}

// Vir's own managed block holds distilled rules, not the doc author's claims.
export function blankVirBlock(lines: string[]): string[] {
  let inside = false;
  return lines.map((l) => {
    if (l.includes(VIR_START)) inside = true;
    const out = inside ? "" : l;
    if (l.includes(VIR_END)) inside = false;
    return out;
  });
}

const PATH_SEGMENT = /^[\w@.+\-[\]()]+$/;
const SHELL_ENV = new Set(["HOME", "PATH", "USER", "SHELL", "PWD", "TMPDIR", "LANG", "TERM", "EDITOR", "CI", "NODE_ENV", "XDG_CONFIG_HOME"]);
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PM_BUILTINS = new Set([
  "install", "i", "add", "remove", "rm", "uninstall", "ci", "exec", "dlx", "x", "create", "init", "publish", "link", "update",
  "up", "outdated", "audit", "config", "login", "logout", "whoami", "pack", "why", "view", "info", "version", "run",
  "list", "ls", "help", "cache", "global", "workspace", "workspaces", "import", "upgrade", "set", "dedupe", "prune",
]);
const DEP_HEADING = /stack|dependenc|librar|tech|tooling|built with/i;

// A repo path the doc points at: has a slash, is relative, and isn't a
// placeholder, glob, URL or home/absolute path.
export function asRepoPath(s: string): string | null {
  const t = s.trim().replace(/[),.;:]+$/, "");
  if (!t.includes("/")) return null;
  if (/^(~|\/|\$|[a-z][\w+.-]*:)/i.test(t)) return null;
  if (/[<>*{}…|\s"'=`]|\.\.\.|^-/.test(t)) return null;
  const clean = t.replace(/^\.\//, "").replace(/(#|:\d).*$/, "");
  const segs = clean.replace(/\/$/, "").split("/");
  if (segs.some((s) => s === ".." || s === "" || !PATH_SEGMENT.test(s))) return null;
  // `owner/repo`, `foo/bar` prose fragments: require a file extension or a
  // trailing slash, so only things written as paths count.
  const last = segs[segs.length - 1] ?? "";
  if (!clean.endsWith("/") && !/\.[A-Za-z0-9]{1,8}$/.test(last)) return null;
  return clean;
}

function codeSpans(line: string): { text: string; index: number }[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => ({ text: m[1] ?? "", index: m.index ?? 0 }));
}

// Lines of a fenced block that look like a directory tree:
//   src/
//     cli.ts       # comment
//     pipeline/
//       run.ts
function treeClaims(block: { text: string; line: number }[]): Claim[] {
  const entries = block.filter((b) => /^[\s│├└─]*[\w@.+\-[\]()]+\/?(\s*,\s*[\w@.+\-[\]()]+\/?)*,?\s*(#.*)?$/.test(b.text) && b.text.trim() !== "");
  // Not a tree unless several lines look like entries and at least one is a dir.
  if (entries.length < 3 || !entries.some((e) => /[\w)\]]\/\s*(#.*)?$/.test(e.text))) return [];
  const out: Claim[] = [];
  const stack: { indent: number; name: string }[] = [];
  for (const b of block) {
    const stripped = b.text.replace(/[│├└─]/g, " ");
    const content = stripped.replace(/#.*$/, "");
    if (content.trim() === "") continue;
    if (!/^\s*[\w@.+\-[\]()]+\/?(\s*,\s*[\w@.+\-[\]()]+\/?)*,?\s*$/.test(content)) continue;
    const indent = content.length - content.trimStart().length;
    const names = content.split(",").map((n) => n.trim()).filter((n) => n.length > 0);
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
    const prefix = stack.map((s) => s.name).join("/");
    for (const name of names) {
      const isDir = name.endsWith("/");
      const bare = name.replace(/\/$/, "");
      if (bare === "." || bare === "..") continue;
      // A file needs an extension (or a dotfile name) to read as a path.
      if (!isDir && !/\.[A-Za-z0-9]{1,8}$/.test(bare) && !bare.startsWith(".")) continue;
      const rel = prefix === "" ? bare : `${prefix}/${bare}`;
      out.push({ kind: "path", text: name, value: isDir ? `${rel}/` : rel, line: b.line, via: "tree" });
    }
    if (names.length === 1 && names[0]?.endsWith("/")) stack.push({ indent, name: names[0].replace(/\/$/, "") });
  }
  return out;
}

// `npm run x`, `npm test`, `pnpm x`, `yarn x`, plus the package manager used.
function scriptClaims(fragment: string, line: number, out: Claim[]): void {
  for (const m of fragment.matchAll(/(?:^|[\s(;&|])(npm|pnpm|yarn|bun)\s+(run\s+)?([a-z][\w:.-]*)/g)) {
    const pm = m[1] ?? "";
    const run = m[2] !== undefined;
    const word = m[3] ?? "";
    out.push({ kind: "package-manager", text: `${pm} ${run ? "run " : ""}${word}`.trim(), value: pm, line });
    if (pm === "npm") {
      if (run) out.push({ kind: "npm-script", text: `npm run ${word}`, value: word, line });
      else if (["test", "start", "stop", "restart"].includes(word)) out.push({ kind: "npm-script", text: `npm ${word}`, value: word, line });
      else if (["install", "i", "add"].includes(word)) depsFromInstall(fragment.slice((m.index ?? 0) + m[0].length), line, out);
    } else if (run || !PM_BUILTINS.has(word)) {
      out.push({ kind: "npm-script", text: `${pm} ${run ? "run " : ""}${word}`, value: word, line });
    } else if (word === "add" || word === "install") {
      depsFromInstall(fragment.slice((m.index ?? 0) + m[0].length), line, out);
    }
  }
}

function depsFromInstall(rest: string, line: number, out: Claim[]): void {
  const args = rest.split(/[;&|)]/)[0]?.trim().split(/\s+/) ?? [];
  // Global installs are about the user's machine, not this repo's deps.
  if (args.some((a) => a === "-g" || a === "--global")) return;
  for (const a of args) {
    if (a.startsWith("-") || a === "") continue;
    const name = a.replace(/(?<=.)@[^/]*$/, "");
    if (NPM_NAME.test(name)) out.push({ kind: "dependency", text: `install ${a}`, value: name, line });
  }
}

// `vir run --dry-run`, `vir schedule install`.
function cliClaims(fragment: string, line: number, ctx: ExtractContext, out: Claim[]): void {
  for (const bin of ctx.bins) {
    const re = new RegExp(`(?:^|[\\s(;&|$])(?:npx\\s+)?${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}((?:\\s+[^\\s;&|)]+)*)`, "g");
    for (const m of fragment.matchAll(re)) {
      const words = (m[1] ?? "").trim().split(/\s+/).filter((w) => w.length > 0);
      const cmd: string[] = [];
      for (const w of words) {
        if (w.startsWith("-")) {
          const flag = w.match(/^--(?:no-)?[a-z][\w-]*/)?.[0];
          if (flag !== undefined) out.push({ kind: "cli-flag", text: `${bin} ${[...cmd, w].join(" ")}`, value: flag.replace(/^--no-/, "--"), line });
          continue;
        }
        if (cmd.length < 2 && /^[a-z][\w:-]*$/.test(w) && !words.slice(0, words.indexOf(w)).some((p) => p.startsWith("-"))) cmd.push(w);
        else break;
      }
      if (cmd.length > 0) out.push({ kind: "cli-command", text: `${bin} ${cmd.join(" ")}`, value: cmd.join(" "), line });
    }
  }
}

function envClaims(fragment: string, line: number, lineHasEnv: boolean, out: Claim[]): void {
  const seen = new Set<string>();
  const add = (name: string, text: string): void => {
    if (SHELL_ENV.has(name) || seen.has(name)) return;
    seen.add(name);
    out.push({ kind: "env-var", text, value: name, line });
  };
  for (const m of fragment.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) add(m[1] ?? "", m[0]);
  for (const m of fragment.matchAll(/(?:^|[^\w$])\$\{?([A-Z][A-Z0-9_]{2,})\}?/g)) add(m[1] ?? "", `$${m[1]}`);
  for (const m of fragment.matchAll(/(?:^|[\s;&])(?:export\s+)?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)=/g)) add(m[1] ?? "", `${m[1]}=`);
  if (lineHasEnv) {
    const whole = fragment.trim();
    if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(whole)) add(whole, whole);
  }
}

export function extractClaims(markdown: string, ctx: ExtractContext): Claim[] {
  const lines = blankVirBlock(markdown.split("\n"));
  const inCode = codeLines(lines);
  const out: Claim[] = [];
  let heading = "";
  let block: { text: string; line: number }[] = [];
  let blockLang = "";

  const flushBlock = (): void => {
    if (block.length === 0) return;
    if (["", "text", "txt", "tree", "plain"].includes(blockLang)) out.push(...treeClaims(block));
    block = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const n = i + 1;
    if (inCode[i] === true) {
      const opening = i === 0 || inCode[i - 1] !== true;
      if (opening) {
        flushBlock();
        blockLang = (raw.match(/^ {0,3}(?:`{3,}|~{3,})\s*([\w+-]*)/)?.[1] ?? "").toLowerCase();
        continue;
      }
      const lastCodeLine = i + 1 >= lines.length || inCode[i + 1] !== true;
      if (lastCodeLine && /^ {0,3}(`{3,}|~{3,})\s*$/.test(raw)) {
        flushBlock();
        continue;
      }
      block.push({ text: raw, line: n });
      const cmd = raw.replace(/^\s*\$\s+/, "").replace(/#.*$/, "");
      scriptClaims(cmd, n, out);
      cliClaims(cmd, n, ctx, out);
      envClaims(cmd, n, false, out);
      continue;
    }
    flushBlock();
    const h = raw.match(/^#{1,6}\s+(.*)$/);
    if (h !== null) heading = h[1] ?? "";

    const lineHasEnv = /\benv(ironment)?\b|\.env/i.test(raw);
    const spans = codeSpans(raw);
    for (const span of spans) {
      const p = asRepoPath(span.text);
      if (p !== null) out.push({ kind: "path", text: span.text, value: p, line: n, via: "span" });
      scriptClaims(span.text, n, out);
      cliClaims(span.text, n, ctx, out);
      envClaims(span.text, n, lineHasEnv, out);
      // A dependency named as the subject of a stack list item:
      //   - `commander` for CLI, `chalk` for output
      // but not "macOS `launchd`" or "native `fetch`".
      const before = raw.slice(0, span.index).replace(/^\s*([-*+]|\d+\.)\s*/, "").trim();
      const listItem = /^\s*([-*+]|\d+\.)\s/.test(raw);
      const subject = before === "" || /(,|;|\+|\band|&|\(|\/)$/.test(before);
      const name = span.text.trim();
      if (
        (listItem && DEP_HEADING.test(heading) && subject && NPM_NAME.test(name) && !name.includes("/") && name.length > 1) ||
        (/^@[a-z0-9][\w.~-]*\/[a-z0-9][\w.~-]*$/.test(name) && !/install\s+(-g|--global)/.test(raw))
      ) {
        out.push({ kind: "dependency", text: name, value: name, line: n });
      }
    }
    // Relative markdown links: [text](docs/foo.md), ![img](assets/x.png).
    for (const m of raw.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1] ?? "";
      if (/^([a-z][\w+.-]*:|#|\/|~)/i.test(target)) continue;
      const clean = target.replace(/^<|>$/g, "").replace(/[#?].*$/, "").replace(/:\d+(:\d+)?$/, "").replace(/^\.\//, "");
      if (clean === "" || clean.split("/").some((s) => s === "..")) continue;
      out.push({ kind: "path", text: target, value: decodeURIComponent(clean), line: n, via: "link" });
    }
  }
  flushBlock();
  return dedupeClaims(out);
}

function dedupeClaims(claims: Claim[]): Claim[] {
  const seen = new Set<string>();
  return claims.filter((c) => {
    const key = `${c.kind}\0${c.value}\0${c.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

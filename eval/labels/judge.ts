import { createHash } from "node:crypto";
import { shuffle, type Rng } from "../rng.js";

export type Grade = 0 | 1 | 2;

function sha12(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
}

// The rubric text is hashed into every label so a rubric edit invalidates
// labels the same way a note edit does.
export function rubricHash(rubric: string): string {
  return sha12(rubric);
}

export function contentHash(raw: string): string {
  return sha12(raw);
}

// Identifies the query a label was judged for; ids alone are positional.
export function queryHash(text: string): string {
  return sha12(text);
}

// A label is keyed by note slug AND content hash: a re-distilled or hand-edited
// note gets no credit for a grade given to its previous text.
export function labelKey(slug: string, hash: string): string {
  return `${slug}@${hash}`;
}

// Seeded shuffle first so position within a call carries no signal about
// which arm ranked the note where; then chunks of at most `size` per call.
export function chunkCandidates(slugs: readonly string[], size: number, rng: Rng): string[][] {
  const shuffled = shuffle(slugs, rng);
  const out: string[][] = [];
  for (let i = 0; i < shuffled.length; i += size) out.push(shuffled.slice(i, i + size));
  return out;
}

export function noteExcerpt(raw: string, maxChars: number): string {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  return body.length <= maxChars ? body : body.slice(0, maxChars);
}

export function buildJudgePrompt(opts: {
  rubric: string;
  query: string;
  candidates: ReadonlyArray<{ slug: string; excerpt: string }>;
}): string {
  const lines = [
    opts.rubric.trim(),
    "",
    "QUERY:",
    opts.query,
    "",
    "CANDIDATE NOTES:",
  ];
  for (const c of opts.candidates) {
    lines.push("", `=== ${c.slug} ===`, c.excerpt.trim(), `=== end ${c.slug} ===`);
  }
  lines.push(
    "",
    "Reply with ONLY a JSON object mapping every candidate slug (exactly as written between",
    "the === markers) to its grade, an integer 0, 1 or 2. Every slug must appear once.",
    "No prose, no code fence.",
  );
  return lines.join("\n");
}

export function parseJudgeResponse(
  text: string,
  expectedSlugs: readonly string[],
): Record<string, Grade> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`judge returned no JSON object: ${text.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error(`judge returned unparseable JSON: ${text.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("judge returned a non-object");
  }
  const raw = parsed as Record<string, unknown>;
  // The judge sometimes drops a slug's directory (insights/rules/x → x). Such
  // a key is mapped back only when exactly one candidate ends in "/<key>";
  // anything else stays an error, so a grade is never pinned on a guess.
  const expected = new Set(expectedSlugs);
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    let slug = k;
    if (!expected.has(k)) {
      const matches = expectedSlugs.filter((s) => s.endsWith(`/${k}`));
      if (matches.length === 0) throw new Error(`judge graded unknown slug: ${k}`);
      if (matches.length > 1) throw new Error(`judge graded ambiguous slug: ${k}`);
      slug = matches[0]!;
    }
    if (slug in obj) throw new Error(`judge graded twice: ${slug}`);
    obj[slug] = v;
  }
  const out: Record<string, Grade> = {};
  for (const slug of expectedSlugs) {
    const g = obj[slug];
    if (g === undefined) throw new Error(`judge response missing slug: ${slug}`);
    if (g !== 0 && g !== 1 && g !== 2) throw new Error(`judge gave invalid grade for ${slug}: ${String(g)}`);
    out[slug] = g;
  }
  return out;
}

// The same 4-chars-per-token estimate distiller.ts uses; only for the
// pre-run report, never for cost math (claude-cli usage comes back real).
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

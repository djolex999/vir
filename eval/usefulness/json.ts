// M2: mine.ts, grade.ts and probes.ts each grep a reply for `/\[[\s\S]*\]/`,
// which is fooled by any earlier "[" or later "]" in the model's prose (a
// preamble like "the array [1,2,3] doesn't apply here" swallows everything up
// to the real array's closing bracket). Try the strict paths first, and keep
// the greedy regex only as the last resort for a reply with no fencing at all.
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

export function extractJsonArray(reply: string): unknown {
  const direct = tryParse(reply.trim());
  if (direct !== undefined) return direct;

  const fence = reply.match(JSON_FENCE);
  if (fence?.[1] !== undefined) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== undefined) return fenced;
  }

  const bracket = reply.match(/\[[\s\S]*\]/);
  if (bracket) return tryParse(bracket[0]);

  return undefined;
}

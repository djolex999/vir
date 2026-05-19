import type { ParsedSession } from "./types.js";

const SIGNAL_REGEX = /\b(error|fixed|bug|learned|gotcha|workaround|fixed it|root cause)\b/i;

export interface FilterResult {
  score: number;
  passes: boolean;
  reasons: string[];
}

export function scoreSession(
  session: ParsedSession,
  threshold: number,
): FilterResult {
  let score = 0;
  const reasons: string[] = [];

  if (session.lineCount > 50) {
    score += 0.3;
    reasons.push(`lineCount>50 (+0.3)`);
  }
  if (session.toolCallCount > 5) {
    score += 0.3;
    reasons.push(`toolCalls>5 (+0.3)`);
  }
  if (session.filesTouched.length > 2) {
    score += 0.2;
    reasons.push(`files>2 (+0.2)`);
  }
  if (
    SIGNAL_REGEX.test(session.assistantText) ||
    SIGNAL_REGEX.test(session.userText)
  ) {
    score += 0.2;
    reasons.push(`signal-word (+0.2)`);
  }

  return {
    score: Math.round(score * 100) / 100,
    passes: score >= threshold,
    reasons,
  };
}

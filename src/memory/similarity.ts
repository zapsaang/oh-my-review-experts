export const DEFAULT_STOP_WORDS: Set<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "that",
  "the",
  "this",
  "to",
  "was",
  "will",
  "with",
]);

function isTechnicalToken(token: string): boolean {
  const hasSpecialChar = /[_\-\d]/.test(token);
  const hasUpperAfterStart = /^.+[A-Z]/.test(token);
  const isAllUppercase = /^[A-Z]+$/.test(token);

  return hasSpecialChar || hasUpperAfterStart || isAllUppercase;
}

export function tokenizeForSimilarity(input: string): string[] {
  const rawTokens = input.split(/[^a-zA-Z0-9_\-]+/);

  const tokens: string[] = [];
  for (const raw of rawTokens) {
    if (raw.length < 2) continue;

    if (isTechnicalToken(raw)) {
      tokens.push(raw);
    } else {
      const lower = raw.toLowerCase();
      if (!DEFAULT_STOP_WORDS.has(lower)) {
        tokens.push(lower);
      }
    }
  }

  return tokens;
}

export function stripMarkdownFences(input: string): string {
  return input
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("```"))
    .join("\n");
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenizeForSimilarity(a));
  const tokensB = new Set(tokenizeForSimilarity(b));

  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection++;
    }
  }

  const union = tokensA.size + tokensB.size - intersection;

  return intersection / union;
}

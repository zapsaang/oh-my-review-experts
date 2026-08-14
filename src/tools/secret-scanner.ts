/**
 * Redact potential secrets from text before sending to external LLM providers.
 * Uses regex patterns to detect common secret formats and replaces them with [REDACTED].
 */

const ALLOWLIST = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9a-f]{40}$/i, // git hash
  /^v\d+\.\d+\.\d+/, // semver
  /^[a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+$/, // filename with extension
];

function isAllowlisted(s: string): boolean {
  // Git hash: 40 hex chars, but must have some variety (not all same char)
  if (/^[0-9a-f]{40}$/i.test(s)) {
    const uniqueChars = new Set(s.toLowerCase()).size;
    return uniqueChars > 3;
  }
  return ALLOWLIST.some((pattern) => pattern.test(s));
}

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) {
    freq.set(c, (freq.get(c) || 0) + 1);
  }
  return -[...freq.values()].reduce((sum, count) => {
    const p = count / s.length;
    return sum + p * Math.log2(p);
  }, 0);
}

const ENTROPY_THRESHOLD = 3.5;

interface SecretPattern {
  pattern: RegExp;
  replacement: string;
  checkAllowlist?: boolean;
}

// Specific patterns with high confidence (processed first)
const SPECIFIC_PATTERNS: SecretPattern[] = [
  // AWS Access Key ID
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_ACCESS_KEY_ID]" },
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  // Private keys
  { pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  // AWS Secret Access Key (base64-shaped, 40 chars)
  { pattern: /[A-Za-z0-9/+=]{40}/g, replacement: "[REDACTED_SECRET]", checkAllowlist: true },
  // Bearer tokens
  { pattern: /bearer[\s]+[a-zA-Z0-9_\-\.]{20,}/gi, replacement: "[REDACTED_BEARER_TOKEN]" },
  // Generic API keys
  { pattern: /(?:api[_-]?key|apikey)[\s]*[:=][\s]*["']?[a-zA-Z0-9_\-]{16,}["']?/gi, replacement: "[REDACTED_API_KEY]" },
  // Generic tokens
  { pattern: /(?:token|auth[_-]?token|access[_-]?token)[\s]*[:=][\s]*["']?[a-zA-Z0-9_\-\.]{16,}["']?/gi, replacement: "[REDACTED_TOKEN]" },
  // Passwords
  { pattern: /(?:password|passwd|pwd)[\s]*[:=][\s]*["']?[^\s"']{8,}["']?/gi, replacement: "[REDACTED_PASSWORD]" },
];

// Requires secret-like context (prefix: start of line, whitespace, quotes, =, :)
// (suffix: end of line, whitespace, quotes, comma, &, ;)
const GENERIC_SECRET_PATTERN = /(?:^|[\s"'=:])([a-zA-Z0-9_\-]{32,})(?:$|[\s"'&,;])/g;

function applySpecificPattern(text: string, pattern: SecretPattern): string {
  if (!pattern.checkAllowlist) {
    return text.replace(pattern.pattern, pattern.replacement);
  }

  return text.replace(pattern.pattern, (match) => {
    if (isAllowlisted(match)) {
      return match;
    }
    return pattern.replacement;
  });
}

export function redactSecrets(text: string): string {
  let redacted = text;

  for (const pattern of SPECIFIC_PATTERNS) {
    redacted = applySpecificPattern(redacted, pattern);
  }

  redacted = redacted.replace(
    GENERIC_SECRET_PATTERN,
    (match, group1) => {
      const candidate = group1 || match;

      if (isAllowlisted(candidate)) {
        return match; // Keep original
      }

      if (shannonEntropy(candidate) <= ENTROPY_THRESHOLD) {
        return match; // Keep original
      }

      // All layers passed - redact
      return match.replace(candidate, "[REDACTED_POTENTIAL_SECRET]");
    }
  );

  return redacted;
}

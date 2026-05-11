/**
 * Redact potential secrets from text before sending to external LLM providers.
 * Uses regex patterns to detect common secret formats and replaces them with [REDACTED].
 */

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // AWS Access Key ID
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_ACCESS_KEY_ID]" },
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  // Private keys
  { pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  // AWS Secret Access Key
  { pattern: /[A-Za-z0-9/+=]{40}/g, replacement: "[REDACTED_SECRET]" },
  // Bearer tokens
  { pattern: /bearer[\s]+[a-zA-Z0-9_\-\.]{20,}/gi, replacement: "[REDACTED_BEARER_TOKEN]" },
  // Generic API keys
  { pattern: /(?:api[_-]?key|apikey)[\s]*[:=][\s]*["']?[a-zA-Z0-9_\-]{16,}["']?/gi, replacement: "[REDACTED_API_KEY]" },
  // Generic tokens
  { pattern: /(?:token|auth[_-]?token|access[_-]?token)[\s]*[:=][\s]*["']?[a-zA-Z0-9_\-\.]{16,}["']?/gi, replacement: "[REDACTED_TOKEN]" },
  // Passwords
  { pattern: /(?:password|passwd|pwd)[\s]*[:=][\s]*["']?[^\s"']{8,}["']?/gi, replacement: "[REDACTED_PASSWORD]" },
  // Generic high-entropy strings that look like secrets (at least 32 chars, alphanumeric + symbols)
  { pattern: /[a-zA-Z0-9_\-]{32,}/g, replacement: "[REDACTED_POTENTIAL_SECRET]" },
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

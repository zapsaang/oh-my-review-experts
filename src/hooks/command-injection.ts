import { buildReviewCodePrompt, stripMemoryFlags } from "../workflow/run-review-code.js";
import { loadConfig } from "../config/load-config.js";
import { OmreConfig } from "../config/schema.js";
import { ScopeResolutionError, AmbiguousScopeError } from "../workflow/scope-resolver.js";
import type { ReviewScope } from "../workflow/scope-resolver.js";

export interface ReviewCodeMatch {
  matched: boolean;
  args: string;
}

export function parseReviewCodeCommand(text: string, config: OmreConfig): ReviewCodeMatch {
  const names = [config.command.name, ...config.command.aliases].filter(Boolean);
  const trimmed = text.trim();
  for (const name of names) {
    const prefix = `/${name}`;
    if (trimmed === prefix) return { matched: true, args: "" };
    if (trimmed.startsWith(`${prefix} `)) return { matched: true, args: trimmed.slice(prefix.length).trim() };
  }
  return { matched: false, args: "" };
}

/**
 * Validate and sanitize user-provided review-code arguments.
 *
 * ⚠️ SECURITY NOTE: This uses a static regex blacklist, which is a defense-in-depth
 * measure but cannot be complete against all prompt-injection techniques (e.g. Unicode
 * homoglyphs, zero-width spaces, base64/rot13 encoding, etc.). The primary defense is
 * that user args are always JSON-encoded and wrapped in opaque delimiters inside the
 * final prompt (see buildReviewCodePrompt), so the model treats them as data, not
 * instructions. This layer catches obvious attempts and raises the barrier for casual
 * misuse.
 *
 * Additionally guards against scope-arg threats: shell metacharacters in path-shaped
 * args, path traversal (".."), and option injection (leading "--").
 */
export function validateAndSanitizeArgs(args: string): string {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args)) {
    throw new Error("Invalid input: control characters are not allowed in review-code arguments.");
  }

  // Detect Unicode direction-override and homoglyph characters often used to obfuscate
  // injection payloads (e.g. U+202E right-to-left-override, U+200B zero-width space).
  if (/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/.test(args)) {
    throw new Error("Invalid input: Unicode formatting characters are not allowed in review-code arguments.");
  }

  const forbiddenPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions?/i,
    /ignore\s+(the\s+)?above\s+instructions?/i,
    /forget\s+(all\s+)?previous\s+instructions?/i,
    /system\s*:\s*/i,
    /you\s+are\s+now\s+/i,
    /new\s+role\s*:/i,
    /disregard\s+(the\s+)?(above|previous)/i,
    /override\s+(all\s+)?previous\s+instructions?/i,
    /do\s+not\s+follow\s+(the\s+)?(above|previous)/i,
    /end\s+(of\s+)?(previous|above)\s+instructions?/i,
  ];
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(args)) {
      throw new Error(`Invalid input: potential prompt injection detected (matched "${pattern.source}").`);
    }
  }

  const isPathShaped = /^(path:|\.|\/|src\/|test\/)/.test(args) || args.includes("/");

  if (isPathShaped) {
    const shellMetaMatch = args.match(/[;|&`><\\]|\$\(/);
    if (shellMetaMatch) {
      throw new Error(`Invalid input: shell metacharacters not allowed in path-shaped scope args (matched: ${shellMetaMatch[0]})`);
    }
  }

  if (/\.\./.test(args)) {
    throw new Error('Invalid input: path traversal not allowed (matched: "..")');
  }

  if (args.startsWith("--")) {
    throw new Error('Invalid input: option injection not allowed (leading "--")');
  }

  return args;
}

export const MAX_ARGS_LENGTH = 4_000;

interface StrippedMemoryArgs {
  args: string;
  isWithMemory: boolean;
  isNoMemory: boolean;
}

function stripMemoryFlagsFromArgs(args: string): StrippedMemoryArgs {
  const trimmed = args.trim();
  const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  const stripped = stripMemoryFlags(tokens);
  return {
    args: stripped.cleaned.join(" "),
    isWithMemory: stripped.isWithMemory,
    isNoMemory: stripped.isNoMemory,
  };
}

export interface InjectReviewCodeInput {
  command: string;
  args: string;
  cwd?: string;
  trusted?: boolean;
}

function formatAmbiguousScopeError(args: string, candidates: ReviewScope[]): string {
  const branch = candidates.find((c): c is Extract<ReviewScope, { kind: "branch" }> => c.kind === "branch");
  const paths = candidates.find((c): c is Extract<ReviewScope, { kind: "paths" }> => c.kind === "paths");
  const lines = [
    `/review-code: input "${args}" is ambiguous (matches both a branch and a path).`,
    `Use one of:`,
  ];
  if (branch) lines.push(`  /review-code branch:${branch.name}`);
  if (paths) lines.push(`  /review-code path:${paths.paths.join(",")}`);
  lines.push(`Or if you meant guidance: /review-code "review the ${args} module"`);
  return lines.join("\n");
}

function injectReviewCodePromptForArgs(
  cwd: string,
  resolveArgs: (config: OmreConfig) => string | undefined,
): string | undefined {
  const config = loadConfig(cwd);
  if (!config.enabled || !config.command.enabled) return undefined;
  if (config.command.injection === "disabled" || config.command.injection === "tool") return undefined;
  const resolvedArgs = resolveArgs(config);
  if (resolvedArgs === undefined) return undefined;
  let args = resolvedArgs;
  if (args.length > MAX_ARGS_LENGTH) {
    args = args.slice(0, MAX_ARGS_LENGTH) + "\n[WARNING: User guidance truncated due to excessive length]";
  }
  const memoryArgs = stripMemoryFlagsFromArgs(args);
  args = validateAndSanitizeArgs(memoryArgs.args);
  try {
    return buildReviewCodePrompt({
      args,
      cwd,
      isWithMemory: memoryArgs.isWithMemory,
      isNoMemory: memoryArgs.isNoMemory,
    }).prompt;
  } catch (err) {
    if (err instanceof ScopeResolutionError) {
      return `Error: ${err.message}`;
    }
    if (err instanceof AmbiguousScopeError) {
      return formatAmbiguousScopeError(args, err.candidates);
    }
    throw err;
  }
}

export function injectReviewCodePrompt(input: InjectReviewCodeInput): string | undefined {
  const cwd = input.cwd ?? process.cwd();
  return injectReviewCodePromptForArgs(cwd, (config) => {
    const names = [config.command.name, ...config.command.aliases].filter(Boolean);
    return names.includes(input.command) ? input.args ?? "" : undefined;
  });
}

export function maybeInjectReviewCodePrompt(text: string, cwd = process.cwd()): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  return injectReviewCodePromptForArgs(cwd, (config) => {
    const match = parseReviewCodeCommand(text, config);
    return match.matched ? match.args : undefined;
  });
}

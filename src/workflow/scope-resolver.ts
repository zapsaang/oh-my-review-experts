/**
 * Discriminated union representing the resolved scope of a code review.
 *
 * Each variant describes a different way the user can narrow or guide what
 * should be reviewed, from a plain guidance string to precise git ranges or
 * file paths.
 */
export type ReviewScope =
  | { kind: "default" }
  | { kind: "guidance"; text: string }
  | { kind: "commit"; ref: string }
  | { kind: "branch"; name: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "paths"; paths: string[] }
  | { kind: "staged" }
  | { kind: "ambiguous"; candidates: ReviewScope[] };

/**
 * Error thrown when scope resolution fails because of invalid or unsafe input.
 */
export class ScopeResolutionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "PATH_TRAVERSAL"
      | "INVALID_INPUT"
      | "SHELL_METACHAR"
      | "OPTION_INJECTION",
    public readonly input: string
  ) {
    super(message);
    this.name = "ScopeResolutionError";
  }
}

/**
 * Parse a raw user argument string into a {@link ReviewScope}.
 *
 * This is currently a stub that only distinguishes between an empty argument
 * (meaning "default" review) and non-empty text (treated as guidance).
 * Future iterations will add heuristics for commits, branches, ranges, and
 * file paths.
 */
export function parseReviewScope(args: string, _cwd: string): ReviewScope {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { kind: "default" };
  }
  return { kind: "guidance", text: trimmed };
}

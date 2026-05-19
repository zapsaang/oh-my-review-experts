import fs from "node:fs";
import path from "node:path";
import { git, GitError } from "../tools/git.js";

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
 * Error thrown when a bare input could be resolved as more than one kind of scope.
 */
export class AmbiguousScopeError extends Error {
  constructor(
    message: string,
    public readonly candidates: ReviewScope[]
  ) {
    super(message);
    this.name = "AmbiguousScopeError";
  }
}

// Mirrors SAFE_DIR_PATTERN from src/config/schema.ts: no leading "/", no ".." segments.
const SAFE_PATH_PATTERN = /^(?!\/)((?!\.\.)[a-zA-Z0-9_\-\.\/])+$/;
const SHA_BARE_PATTERN = /^[A-Fa-f0-9]{7,40}$/;
const SHA_PREFIX_PATTERN = /^[A-Fa-f0-9]{4,40}$/;
const HEAD_REF_PATTERN = /^HEAD(?:~\d+|\^\d*)?$/;
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._\/\-]+$/;
const RANGE_REF_PATTERN = /^[A-Za-z0-9._\/\-~^]+$/;

const STAGED_KEYWORDS = new Set(["staged", "--staged", "--cached"]);

/**
 * Parse a raw user argument string into a {@link ReviewScope}.
 *
 * Resolution order (first match wins):
 * 1. Empty / whitespace-only             → `{ kind: "default" }`
 * 2. Staged keyword (`staged`, `--staged`, `--cached`) → `{ kind: "staged" }`
 * 3. Explicit prefix `branch:<name>`     → `{ kind: "branch", name }` (throws on invalid format)
 * 4. Explicit prefix `commit:<ref>`      → `{ kind: "commit", ref }`  (throws on invalid format)
 * 5. Explicit prefix `path:<a,b,...>`    → `{ kind: "paths", paths }` (throws on traversal / invalid format)
 * 6. Explicit prefix `range:<from>..<to>`→ `{ kind: "range", from, to }` (throws on invalid format)
 * 7. Bare-form SHA / HEAD~N / HEAD^      → `{ kind: "commit", ref }`   (only if `git cat-file -e` succeeds)
 * 8. Bare-form branch name               → `{ kind: "branch", name }`  (only if `git show-ref` succeeds, local then remote)
 *    – If the same input also resolves as bare paths, returns `{ kind: "ambiguous" }` instead.
 * 9. Bare-form comma-separated paths     → `{ kind: "paths", paths }`  (only if all parts exist on disk under cwd)
 * 10. Otherwise                          → `{ kind: "guidance", text: trimmed }`
 *
 * Bare-form path detection enforces defense-in-depth: paths must validate against
 * {@link SAFE_PATH_PATTERN} and `path.resolve(cwd, p)` must remain under `cwd`.
 *
 * Ambiguity resolution and precedence wiring (e.g. SHA-vs-branch coincidences)
 * are handled by callers; this function returns the first concrete match it finds,
 * except for the branch-vs-paths ambiguity case which is surfaced explicitly.
 *
 * @throws {ScopeResolutionError} when an explicit prefix is malformed or a
 * bare path partially exists / escapes `cwd`.
 */
export function parseReviewScope(args: string, cwd: string): ReviewScope {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { kind: "default" };
  }

  if (STAGED_KEYWORDS.has(trimmed)) {
    return { kind: "staged" };
  }

  if (trimmed.startsWith("branch:")) {
    return parseBranchPrefix(trimmed);
  }
  if (trimmed.startsWith("commit:")) {
    return parseCommitPrefix(trimmed);
  }
  if (trimmed.startsWith("path:")) {
    return parsePathPrefix(trimmed, cwd);
  }
  if (trimmed.startsWith("range:")) {
    return parseRangePrefix(trimmed);
  }

  if (SHA_BARE_PATTERN.test(trimmed) || HEAD_REF_PATTERN.test(trimmed)) {
    if (refExists(trimmed, cwd)) {
      return { kind: "commit", ref: trimmed };
    }
  }

  if (BRANCH_NAME_PATTERN.test(trimmed) && !trimmed.startsWith("-")) {
    const branchName = resolveBranch(trimmed, cwd);
    if (branchName !== null) {
      if (wouldBarePathsResolve(trimmed, cwd)) {
        const pathParts = trimmed
          .split(",")
          .map((segment) => segment.trim())
          .filter((segment) => segment.length > 0);
        return {
          kind: "ambiguous",
          candidates: [
            { kind: "branch", name: branchName },
            { kind: "paths", paths: pathParts },
          ],
        };
      }
      return { kind: "branch", name: branchName };
    }
  }

  const paths = tryBarePaths(trimmed, cwd);
  if (paths !== null) {
    return { kind: "paths", paths };
  }

  return { kind: "guidance", text: trimmed };
}

function parseBranchPrefix(arg: string): ReviewScope {
  const name = arg.slice("branch:".length);
  if (!name) {
    throw new ScopeResolutionError(
      "Invalid branch reference: empty name after `branch:`",
      "INVALID_INPUT",
      arg
    );
  }
  if (name.startsWith("-")) {
    throw new ScopeResolutionError(
      `Invalid branch reference: name must not start with "-" (got ${JSON.stringify(name)})`,
      "INVALID_INPUT",
      arg
    );
  }
  if (!BRANCH_NAME_PATTERN.test(name)) {
    throw new ScopeResolutionError(
      `Invalid branch reference: ${JSON.stringify(name)}`,
      "INVALID_INPUT",
      arg
    );
  }
  return { kind: "branch", name };
}

function parseCommitPrefix(arg: string): ReviewScope {
  const ref = arg.slice("commit:".length);
  if (!ref) {
    throw new ScopeResolutionError(
      "Invalid commit reference: empty ref after `commit:`",
      "INVALID_INPUT",
      arg
    );
  }
  if (!(SHA_PREFIX_PATTERN.test(ref) || HEAD_REF_PATTERN.test(ref))) {
    throw new ScopeResolutionError(
      `Invalid commit reference: ${JSON.stringify(ref)} (expected 4-40 hex chars or HEAD[~N|^N])`,
      "INVALID_INPUT",
      arg
    );
  }
  return { kind: "commit", ref };
}

function parsePathPrefix(arg: string, cwd: string): ReviewScope {
  const raw = arg.slice("path:".length);
  const parts = raw
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (parts.length === 0) {
    throw new ScopeResolutionError(
      "Invalid path list: empty paths after `path:`",
      "INVALID_INPUT",
      arg
    );
  }
  for (const part of parts) {
    if (part.includes("..")) {
      throw new ScopeResolutionError(
        `Path traversal not allowed: ${JSON.stringify(part)}`,
        "PATH_TRAVERSAL",
        arg
      );
    }
    if (part.startsWith("/")) {
      throw new ScopeResolutionError(
        `Absolute path not allowed: ${JSON.stringify(part)}`,
        "PATH_TRAVERSAL",
        arg
      );
    }
    if (!SAFE_PATH_PATTERN.test(part)) {
      throw new ScopeResolutionError(
        `Invalid path: ${JSON.stringify(part)}`,
        "INVALID_INPUT",
        arg
      );
    }
    assertResolvedUnderCwd(part, cwd, arg);
  }
  return { kind: "paths", paths: parts };
}

function parseRangePrefix(arg: string): ReviewScope {
  const raw = arg.slice("range:".length);
  if (!raw) {
    throw new ScopeResolutionError(
      "Invalid range: empty value after `range:`",
      "INVALID_INPUT",
      arg
    );
  }
  const doubleIdx = raw.indexOf("..");
  if (doubleIdx === -1) {
    throw new ScopeResolutionError(
      `Invalid range format: ${JSON.stringify(raw)} (expected from..to or from...to)`,
      "INVALID_INPUT",
      arg
    );
  }
  const tripleIdx = raw.indexOf("...");
  const sepLen = tripleIdx !== -1 && tripleIdx === doubleIdx ? 3 : 2;
  const from = raw.slice(0, doubleIdx);
  const to = raw.slice(doubleIdx + sepLen);
  if (!from || !to) {
    throw new ScopeResolutionError(
      `Invalid range format: ${JSON.stringify(raw)} (empty from or to)`,
      "INVALID_INPUT",
      arg
    );
  }
  if (from.startsWith("-") || to.startsWith("-")) {
    throw new ScopeResolutionError(
      `Invalid range refs: must not start with "-" (got ${JSON.stringify({ from, to })})`,
      "INVALID_INPUT",
      arg
    );
  }
  if (!RANGE_REF_PATTERN.test(from) || !RANGE_REF_PATTERN.test(to)) {
    throw new ScopeResolutionError(
      `Invalid range refs: ${JSON.stringify({ from, to })}`,
      "INVALID_INPUT",
      arg
    );
  }
  return { kind: "range", from, to };
}

function refExists(ref: string, cwd: string): boolean {
  try {
    git(["cat-file", "-e", `${ref}^{commit}`], cwd);
    return true;
  } catch (err) {
    if (err instanceof GitError) return false;
    throw err;
  }
}

function resolveBranch(name: string, cwd: string): string | null {
  if (verifyRef(`refs/heads/${name}`, cwd)) return name;
  if (verifyRef(`refs/remotes/${name}`, cwd)) return name;
  return null;
}

function verifyRef(fullRef: string, cwd: string): boolean {
  try {
    git(["show-ref", "--verify", "--quiet", fullRef], cwd);
    return true;
  } catch (err) {
    if (err instanceof GitError) return false;
    throw err;
  }
}

/**
 * Check whether `arg` would resolve as a valid bare-form path list
 * without throwing. Returns `true` only when every part passes
 * {@link SAFE_PATH_PATTERN}, resolves under `cwd`, and exists on disk.
 */
function wouldBarePathsResolve(arg: string, cwd: string): boolean {
  const parts = arg
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (!SAFE_PATH_PATTERN.test(part)) return false;
  }
  const cwdResolved = path.resolve(cwd);
  for (const part of parts) {
    const resolved = path.resolve(cwdResolved, part);
    const rel = path.relative(cwdResolved, resolved);
    if (rel === "..") return false;
    if (rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
    if (!fs.existsSync(resolved)) return false;
  }
  return true;
}

/**
 * Try to interpret `arg` as a comma-separated bare-form path list.
 * Returns the validated paths if every part exists on disk, `null` if all
 * parts fail validation or none exist (caller should fall through to
 * guidance), and throws on partial existence or path-escape.
 */
function tryBarePaths(arg: string, cwd: string): string[] | null {
  const parts = arg
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (part.includes("..")) {
      throw new ScopeResolutionError(
        `Path traversal not allowed: ${JSON.stringify(part)}`,
        "PATH_TRAVERSAL",
        arg
      );
    }
    if (!SAFE_PATH_PATTERN.test(part)) return null;
  }
  const cwdResolved = path.resolve(cwd);
  const existence = parts.map((part) => {
    const resolved = path.resolve(cwdResolved, part);
    const rel = path.relative(cwdResolved, resolved);
    if (rel === "..") {
      throw new ScopeResolutionError(
        `Path escapes cwd: ${JSON.stringify(part)}`,
        "PATH_TRAVERSAL",
        arg
      );
    }
    if (rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new ScopeResolutionError(
        `Path escapes cwd: ${JSON.stringify(part)}`,
        "PATH_TRAVERSAL",
        arg
      );
    }
    return fs.existsSync(resolved);
  });
  const allExist = existence.every(Boolean);
  if (allExist) return parts;
  const noneExist = existence.every((exists) => !exists);
  if (noneExist) return null;
  const missing = parts.filter((_, i) => !existence[i]);
  throw new ScopeResolutionError(
    `Some paths do not exist: ${missing.map((p) => JSON.stringify(p)).join(", ")}`,
    "INVALID_INPUT",
    arg
  );
}

function assertResolvedUnderCwd(part: string, cwd: string, original: string): void {
  const cwdResolved = path.resolve(cwd);
  const resolved = path.resolve(cwdResolved, part);
  const rel = path.relative(cwdResolved, resolved);
  if (rel === "..") {
    throw new ScopeResolutionError(
      `Path escapes cwd: ${JSON.stringify(part)}`,
      "PATH_TRAVERSAL",
      original
    );
  }
  if (rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ScopeResolutionError(
      `Path escapes cwd: ${JSON.stringify(part)}`,
      "PATH_TRAVERSAL",
      original
    );
  }
}

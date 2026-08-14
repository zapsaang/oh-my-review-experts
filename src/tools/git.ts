import { execFileSync } from "node:child_process";
import type { ReviewScope } from "../workflow/scope-resolver.js";

export class GitError extends Error {
  constructor(
    message: string,
    public readonly command: string[],
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "GitError";
  }
}

export function git(args: string[], cwd = process.cwd()): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err));
    const stderr = (cause as Error & { stderr?: string }).stderr;
    const message = stderr
      ? `Git command failed: git ${args.join(" ")}\n${cause.message}\nstderr: ${stderr}`
      : `Git command failed: git ${args.join(" ")}\n${cause.message}`;
    throw new GitError(message, args, cause);
  }
}

function splitLines(output: string): string[] {
  return output.trim().split(/\r?\n/).filter(Boolean);
}

function hasContent(output: string): boolean {
  return output.trim().length > 0;
}

export function getChangedFiles(cwd = process.cwd(), scope?: ReviewScope): string[] {
  if (scope && scope.kind !== "default" && scope.kind !== "guidance") {
    switch (scope.kind) {
      case "staged":
        return splitLines(git(["diff", "--cached", "--name-only"], cwd));
      case "commit":
        return splitLines(git(["show", "--name-only", "--format=", scope.ref], cwd));
      case "branch":
        return splitLines(git(["diff", "--name-only", `${scope.name}...HEAD`], cwd));
      case "range":
        return splitLines(git(["diff", "--name-only", `${scope.from}...${scope.to}`], cwd));
      case "paths": {
        const all = getDefaultChangedFiles(cwd);
        return all.filter((file) => scope.paths.some((prefix) => file.startsWith(prefix)));
      }
      case "ambiguous":
        throw new Error(
          "Cannot resolve changed files for ambiguous scope: caller must disambiguate first"
        );
    }
  }
  return getDefaultChangedFiles(cwd);
}

function getDefaultChangedFiles(cwd: string): string[] {
  try {
    // Single consistent snapshot for tracked changes (staged + unstaged)
    const tracked = git(["diff", "--name-only", "HEAD"], cwd);
    const untracked = git(["ls-files", "--others", "--exclude-standard"], cwd);
    const files = Array.from(new Set([...splitLines(tracked), ...splitLines(untracked)]));
    if (files.length) return files;
  } catch (err) {
    if (err instanceof GitError && err.message.includes("HEAD")) {
      // Fresh repository with no commits: only untracked files
      const untracked = git(["ls-files", "--others", "--exclude-standard"], cwd);
      return splitLines(untracked);
    }
    throw err;
  }

  // Fallback to HEAD diff only when HEAD exists (repo has at least one commit)
  try {
    return splitLines(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], cwd));
  } catch (err) {
    if (err instanceof GitError && err.message.includes("HEAD")) {
      return [];
    }
    throw err;
  }
}

/**
 * Produce a `--stat`-formatted summary of changes for the given scope.
 *
 * Parameter order note: this signature inserts `scope` between `cwd` and `files`.
 * Prior to scope-aware review, the signature was `getDiffSummary(cwd, files?)`.
 * Callers passing `(cwd, files)` must now pass `(cwd, undefined, files)` or, more
 * commonly, `(cwd, scope, files)`. The reorder is deliberate: `scope` is the
 * primary selector — it determines which git command runs — and `files` is a
 * secondary path filter applied to that command.
 *
 * Per-kind git command:
 * - `default` / `guidance` / `undefined`: `git diff --stat HEAD -- <files?>`
 * - `staged`:                              `git diff --stat --cached -- <files?>`
 * - `commit`:                              `git show --stat --format= <ref> -- <files?>`
 * - `branch`:                              `git diff --stat <name>...HEAD -- <files?>`
 * - `range`:                               `git diff --stat <from>...<to> -- <files?>`
 * - `paths`:                               `git diff --stat HEAD -- <scope.paths>` (overrides `files` arg)
 * - `ambiguous`:                           throws `GitError`
 *
 * Fresh-repo fallback: when the primary command targets HEAD (i.e. `default`,
 * `guidance`, `paths`, or `staged` referencing a not-yet-existing index baseline)
 * and HEAD does not exist, returns `""` instead of throwing — matching the
 * behavior of the previous HEAD-only signature.
 */
export function getDiffSummary(
  cwd = process.cwd(),
  scope?: ReviewScope,
  files?: string[]
): string {
  if (scope === undefined) {
    return runHeadDiffSummary(cwd, toFileArgs(files));
  }
  switch (scope.kind) {
    case "default":
    case "guidance":
      return runHeadDiffSummary(cwd, toFileArgs(files));
    case "paths":
      return runHeadDiffSummary(cwd, toFileArgs(scope.paths));
    case "staged":
      return runStagedDiffSummary(cwd, toFileArgs(files));
    case "commit":
      return git(["show", "--stat", "--format=", scope.ref, ...toFileArgs(files)], cwd);
    case "branch":
      return git(["diff", "--stat", `${scope.name}...HEAD`, ...toFileArgs(files)], cwd);
    case "range":
      return git(["diff", "--stat", `${scope.from}...${scope.to}`, ...toFileArgs(files)], cwd);
    case "ambiguous":
      throw new GitError(
        "Cannot produce diff summary for ambiguous scope; caller must resolve precedence first",
        ["diff", "--stat"]
      );
  }
}

function toFileArgs(files: string[] | undefined): string[] {
  return files?.length ? ["--", ...files] : [];
}

function runHeadDiffSummary(cwd: string, fileArgs: string[]): string {
  try {
    const diff = git(["diff", "--stat", "HEAD", ...fileArgs], cwd);
    if (hasContent(diff)) return diff;
  } catch (err) {
    if (err instanceof GitError && err.message.includes("HEAD")) {
      return "";
    }
    throw err;
  }
  try {
    return git(["show", "--stat", "--oneline", "--no-renames", "HEAD", ...fileArgs], cwd);
  } catch (err) {
    if (err instanceof GitError && err.message.includes("HEAD")) {
      return "";
    }
    throw err;
  }
}

function runStagedDiffSummary(cwd: string, fileArgs: string[]): string {
  try {
    return git(["diff", "--stat", "--cached", ...fileArgs], cwd);
  } catch (err) {
    if (err instanceof GitError && err.message.includes("HEAD")) {
      return "";
    }
    throw err;
  }
}

export function getUnifiedDiff(
  cwd = process.cwd(),
  scope?: ReviewScope,
  files?: string[]
): string {
  if (scope && scope.kind !== "default" && scope.kind !== "guidance") {
    const fileArgs = files?.length ? ["--", ...files] : [];
    switch (scope.kind) {
      case "staged":
        return git(["diff", "--no-ext-diff", "--cached", ...fileArgs], cwd);
      case "commit":
        return git(["show", "--no-ext-diff", "--format=", scope.ref, ...fileArgs], cwd);
      case "branch":
        return git(["diff", "--no-ext-diff", `${scope.name}...HEAD`, ...fileArgs], cwd);
      case "range":
        return git(["diff", "--no-ext-diff", `${scope.from}...${scope.to}`, ...fileArgs], cwd);
      case "paths":
        return git(["diff", "--no-ext-diff", "HEAD", "--", ...scope.paths], cwd);
      case "ambiguous":
        throw new Error(
          "Cannot resolve unified diff for ambiguous scope: caller must disambiguate first"
        );
    }
  }
  const fileArgs = files?.length ? ["--", ...files] : [];
  try {
    const diff = git(["diff", "--no-ext-diff", "HEAD", ...fileArgs], cwd);
    if (hasContent(diff)) return diff;
  } catch (err) {
    if (err instanceof GitError && err.message.includes("HEAD")) {
      return "";
    }
    throw err;
  }
  try {
    return git(["show", "--format=short", "--no-ext-diff", "HEAD", ...fileArgs], cwd);
  } catch (err) {
    if (err instanceof GitError && err.message.includes("HEAD")) {
      return "";
    }
    throw err;
  }
}

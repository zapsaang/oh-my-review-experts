import { execFileSync } from "node:child_process";

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

export function getChangedFiles(cwd = process.cwd()): string[] {
  try {
    // Single consistent snapshot for tracked changes (staged + unstaged)
    const tracked = git(["diff", "--name-only", "HEAD"], cwd);
    const untracked = git(["ls-files", "--others", "--exclude-standard"], cwd);
    const files = Array.from(new Set([...splitLines(tracked), ...splitLines(untracked)]));
    if (files.length) return files;
  } catch (err) {
    if (err instanceof GitError && err.message.includes("HEAD")) {
      // Fresh repository with no commits: only untracked files
      try {
        const untracked = git(["ls-files", "--others", "--exclude-standard"], cwd);
        return splitLines(untracked);
      } catch {
        return [];
      }
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

export function getDiffSummary(cwd = process.cwd(), files?: string[]): string {
  const fileArgs = files?.length ? ["--", ...files] : [];
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

export function getUnifiedDiff(cwd = process.cwd(), files?: string[]): string {
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

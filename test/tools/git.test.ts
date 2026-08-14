import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { GitError, getChangedFiles, getDiffSummary, getUnifiedDiff } from "../../src/tools/git.js";
import type { ReviewScope } from "../../src/workflow/scope-resolver.js";
import {
  withCleanGitRepo,
  withRepoOnBranch,
  withRepoWithBranches,
  withRepoWithStagedFile,
} from "../_helpers/fixture-repo.js";

describe("GitError", () => {
  it("has correct name and message", () => {
    const err = new GitError("Something failed", ["diff", "--stat"]);
    expect(err.name).toBe("GitError");
    expect(err.message).toBe("Something failed");
    expect(err.command).toEqual(["diff", "--stat"]);
  });

  it("preserves cause when provided", () => {
    const cause = new Error("Underlying error");
    const err = new GitError("Wrapper", ["log"], cause);
    expect(err.cause).toBe(cause);
  });
});

describe("getChangedFiles — backward compat (no scope)", () => {
  it("returns tracked + untracked files when scope is undefined", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "untracked.ts"), "// untracked\n", "utf8");
      const files = getChangedFiles(cwd);
      expect(files).toContain("src/untracked.ts");
    });
  });

  it("returns same result for scope undefined and { kind: 'default' }", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "untracked.ts"), "// untracked\n", "utf8");
      const a = getChangedFiles(cwd);
      const b = getChangedFiles(cwd, { kind: "default" });
      expect(a.sort()).toEqual(b.sort());
    });
  });

  it("returns same result for { kind: 'guidance' } as for default", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "untracked.ts"), "// untracked\n", "utf8");
      const a = getChangedFiles(cwd, { kind: "default" });
      const b = getChangedFiles(cwd, { kind: "guidance", text: "focus on auth" });
      expect(a.sort()).toEqual(b.sort());
    });
  });

  it("returns empty array in fresh repo with no commits and no files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omre-fresh-"));
    try {
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmp, stdio: "ignore" });
      const files = getChangedFiles(tmp);
      expect(files).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // slop-fix: fails until B7 fix lands
  it("surfaces an unexpected git ls-files failure in the fresh-repository fallback", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omre-git-fallback-"));
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir);
    const fakeGit = path.join(binDir, "git");
    fs.writeFileSync(
      fakeGit,
      `#!/usr/bin/env node
const command = process.argv[2];
if (command === "diff") {
  console.error("fatal: ambiguous argument 'HEAD': unknown revision");
  process.exit(128);
}
console.error("fatal: unable to read index: Input/output error");
process.exit(128);
`,
      "utf8",
    );
    fs.chmodSync(fakeGit, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      expect(() => getChangedFiles(tmp)).toThrow(GitError);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("getChangedFiles — scope: staged", () => {
  it("returns only staged files via git diff --cached --name-only", () => {
    withRepoWithStagedFile("src/staged.ts", "// staged\n", (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "untracked.ts"), "// untracked\n", "utf8");
      const files = getChangedFiles(cwd, { kind: "staged" });
      expect(files).toContain("src/staged.ts");
      expect(files).not.toContain("src/untracked.ts");
    });
  });

  it("returns empty array when nothing is staged", () => {
    withCleanGitRepo((cwd) => {
      fs.writeFileSync(path.join(cwd, "untracked.ts"), "// untracked\n", "utf8");
      const files = getChangedFiles(cwd, { kind: "staged" });
      expect(files).toEqual([]);
    });
  });
});

describe("getChangedFiles — scope: commit", () => {
  it("returns files from a specific commit via git show --name-only", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n", "src/bar.ts": "// bar\n" }, (cwd) => {
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
      const files = getChangedFiles(cwd, { kind: "commit", ref: sha });
      expect(files.sort()).toEqual(["src/bar.ts", "src/foo.ts"]);
    });
  });

  it("works with HEAD ref", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      const files = getChangedFiles(cwd, { kind: "commit", ref: "HEAD" });
      expect(files).toContain("src/foo.ts");
    });
  });

  it("throws GitError on unknown ref", () => {
    withCleanGitRepo((cwd) => {
      expect(() => getChangedFiles(cwd, { kind: "commit", ref: "deadbeef" })).toThrow(GitError);
    });
  });
});

describe("getChangedFiles — scope: branch", () => {
  it("returns files differing between branch and HEAD via three-dot diff", () => {
    withRepoWithBranches(
      {
        "feature-a": { "src/a.ts": "// a\n" },
        "feature-b": { "src/b.ts": "// b\n" },
      },
      (cwd) => {
        const files = getChangedFiles(cwd, { kind: "branch", name: "feature-a" });
        expect(files).toContain("src/b.ts");
        expect(files).not.toContain("src/a.ts");
      }
    );
  });

  it("throws GitError on unknown branch", () => {
    withCleanGitRepo((cwd) => {
      expect(() => getChangedFiles(cwd, { kind: "branch", name: "nope-no-such-branch" })).toThrow(
        GitError
      );
    });
  });
});

describe("getChangedFiles — scope: range", () => {
  it("returns files differing between two refs via three-dot diff", () => {
    withRepoWithBranches(
      {
        "feature-a": { "src/a.ts": "// a\n" },
        "feature-b": { "src/b.ts": "// b\n" },
      },
      (cwd) => {
        const files = getChangedFiles(cwd, { kind: "range", from: "feature-a", to: "feature-b" });
        expect(files).toContain("src/b.ts");
      }
    );
  });

  it("throws GitError on invalid refs", () => {
    withCleanGitRepo((cwd) => {
      expect(() =>
        getChangedFiles(cwd, { kind: "range", from: "nope-a", to: "nope-b" })
      ).toThrow(GitError);
    });
  });
});

describe("getChangedFiles — scope: paths", () => {
  it("filters default changed files by path prefix", () => {
    withRepoOnBranch("feature", { "src/keep.ts": "// keep\n" }, (cwd) => {
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "test", "drop.ts"), "// drop\n", "utf8");
      fs.writeFileSync(path.join(cwd, "src", "also-keep.ts"), "// also\n", "utf8");
      const files = getChangedFiles(cwd, { kind: "paths", paths: ["src/"] });
      expect(files).toContain("src/also-keep.ts");
      expect(files).not.toContain("test/drop.ts");
    });
  });

  it("matches multiple prefixes with OR semantics", () => {
    withCleanGitRepo((cwd) => {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "a.ts"), "// a\n", "utf8");
      fs.writeFileSync(path.join(cwd, "test", "b.ts"), "// b\n", "utf8");
      fs.writeFileSync(path.join(cwd, "docs", "c.md"), "// c\n", "utf8");
      const files = getChangedFiles(cwd, { kind: "paths", paths: ["src/", "test/"] });
      expect(files.sort()).toEqual(["src/a.ts", "test/b.ts"]);
    });
  });

  it("returns empty array when no files match prefix", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      const files = getChangedFiles(cwd, { kind: "paths", paths: ["nonexistent/"] });
      expect(files).toEqual([]);
    });
  });
});

describe("getChangedFiles — scope: ambiguous", () => {
  it("throws Error when scope is ambiguous", () => {
    withCleanGitRepo((cwd) => {
      const scope: ReviewScope = {
        kind: "ambiguous",
        candidates: [
          { kind: "branch", name: "main" },
          { kind: "commit", ref: "main" },
        ],
      };
      expect(() => getChangedFiles(cwd, scope)).toThrow(/ambiguous/i);
    });
  });
});

describe("getDiffSummary — backward compat (no scope)", () => {
  it("returns same result for scope undefined and { kind: 'default' }", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "foo.ts"), "// changed\n", "utf8");
      const a = getDiffSummary(cwd);
      const b = getDiffSummary(cwd, { kind: "default" });
      expect(a).toBe(b);
      expect(a).toContain("src/foo.ts");
    });
  });

  it("returns same result for { kind: 'guidance' } as for default", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "foo.ts"), "// changed\n", "utf8");
      const a = getDiffSummary(cwd, { kind: "default" });
      const b = getDiffSummary(cwd, { kind: "guidance", text: "focus on auth" });
      expect(a).toBe(b);
    });
  });

  it("uses --stat flag (not full diff)", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "line-a\n" }, (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "foo.ts"), "line-b\n", "utf8");
      const summary = getDiffSummary(cwd);
      expect(summary).toMatch(/\d+ file.* changed/);
      expect(summary).not.toContain("@@");
      expect(summary).not.toContain("-line-a");
    });
  });

  it("returns empty string in fresh repo with no commits", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omre-fresh-summary-"));
    try {
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmp, stdio: "ignore" });
      const summary = getDiffSummary(tmp);
      expect(summary).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("filters by files when provided", () => {
    withRepoOnBranch(
      "feature",
      { "src/keep.ts": "old\n", "src/drop.ts": "old\n" },
      (cwd) => {
        fs.writeFileSync(path.join(cwd, "src", "keep.ts"), "new\n", "utf8");
        fs.writeFileSync(path.join(cwd, "src", "drop.ts"), "new\n", "utf8");
        const summary = getDiffSummary(cwd, undefined, ["src/keep.ts"]);
        expect(summary).toContain("src/keep.ts");
        expect(summary).not.toContain("src/drop.ts");
      }
    );
  });
});

describe("getDiffSummary — scope: staged", () => {
  it("returns staged diff via git diff --stat --cached", () => {
    withRepoWithStagedFile("src/staged.ts", "staged\n", (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "untracked.ts"), "untracked\n", "utf8");
      const summary = getDiffSummary(cwd, { kind: "staged" });
      expect(summary).toContain("src/staged.ts");
      expect(summary).toMatch(/\d+ file.* changed/);
      expect(summary).not.toContain("src/untracked.ts");
    });
  });

  it("returns empty string when nothing is staged", () => {
    withCleanGitRepo((cwd) => {
      const summary = getDiffSummary(cwd, { kind: "staged" });
      expect(summary).toBe("");
    });
  });
});

describe("getDiffSummary — scope: commit", () => {
  it("returns stat for files in a specific commit via git show --stat --format=", () => {
    withRepoOnBranch(
      "feature",
      { "src/foo.ts": "// foo\n", "src/bar.ts": "// bar\n" },
      (cwd) => {
        const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
        const summary = getDiffSummary(cwd, { kind: "commit", ref: sha });
        expect(summary).toContain("src/foo.ts");
        expect(summary).toContain("src/bar.ts");
        expect(summary).toMatch(/\d+ file.* changed/);
      }
    );
  });

  it("does not include commit message when --format= is empty", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      const summary = getDiffSummary(cwd, { kind: "commit", ref: "HEAD" });
      expect(summary).not.toMatch(/add files/);
    });
  });

  it("throws GitError on unknown ref", () => {
    withCleanGitRepo((cwd) => {
      expect(() => getDiffSummary(cwd, { kind: "commit", ref: "deadbeef" })).toThrow(GitError);
    });
  });
});

describe("getDiffSummary — scope: branch", () => {
  it("returns stat for three-dot diff against a branch", () => {
    withRepoWithBranches(
      {
        "feature-a": { "src/a.ts": "// a\n" },
        "feature-b": { "src/b.ts": "// b\n" },
      },
      (cwd) => {
        const summary = getDiffSummary(cwd, { kind: "branch", name: "feature-a" });
        expect(summary).toContain("src/b.ts");
        expect(summary).toMatch(/\d+ file.* changed/);
      }
    );
  });

  it("throws GitError on unknown branch", () => {
    withCleanGitRepo((cwd) => {
      expect(() => getDiffSummary(cwd, { kind: "branch", name: "nope-no-such-branch" })).toThrow(
        GitError
      );
    });
  });
});

describe("getDiffSummary — scope: range", () => {
  it("returns stat for three-dot range diff", () => {
    withRepoWithBranches(
      {
        "feature-a": { "src/a.ts": "// a\n" },
        "feature-b": { "src/b.ts": "// b\n" },
      },
      (cwd) => {
        const summary = getDiffSummary(cwd, { kind: "range", from: "feature-a", to: "feature-b" });
        expect(summary).toContain("src/b.ts");
        expect(summary).toMatch(/\d+ file.* changed/);
      }
    );
  });

  it("throws GitError on invalid refs", () => {
    withCleanGitRepo((cwd) => {
      expect(() =>
        getDiffSummary(cwd, { kind: "range", from: "nope-a", to: "nope-b" })
      ).toThrow(GitError);
    });
  });
});

describe("getDiffSummary — scope: paths", () => {
  it("uses scope.paths to filter HEAD diff", () => {
    withRepoOnBranch(
      "feature",
      { "src/keep.ts": "old\n", "test/drop.ts": "old\n" },
      (cwd) => {
        fs.writeFileSync(path.join(cwd, "src", "keep.ts"), "new\n", "utf8");
        fs.writeFileSync(path.join(cwd, "test", "drop.ts"), "new\n", "utf8");
        const summary = getDiffSummary(cwd, { kind: "paths", paths: ["src/"] });
        expect(summary).toContain("src/keep.ts");
        expect(summary).not.toContain("test/drop.ts");
      }
    );
  });

  it("scope.paths overrides files arg", () => {
    withRepoOnBranch(
      "feature",
      { "src/from-scope.ts": "old\n", "src/from-arg.ts": "old\n" },
      (cwd) => {
        fs.writeFileSync(path.join(cwd, "src", "from-scope.ts"), "new\n", "utf8");
        fs.writeFileSync(path.join(cwd, "src", "from-arg.ts"), "new\n", "utf8");
        const summary = getDiffSummary(
          cwd,
          { kind: "paths", paths: ["src/from-scope.ts"] },
          ["src/from-arg.ts"]
        );
        expect(summary).toContain("src/from-scope.ts");
        expect(summary).not.toContain("src/from-arg.ts");
      }
    );
  });
});

describe("getDiffSummary — scope: ambiguous", () => {
  it("throws GitError when scope is ambiguous", () => {
    withCleanGitRepo((cwd) => {
      const scope: ReviewScope = {
        kind: "ambiguous",
        candidates: [
          { kind: "branch", name: "main" },
          { kind: "commit", ref: "main" },
        ],
      };
      expect(() => getDiffSummary(cwd, scope)).toThrow(GitError);
      expect(() => getDiffSummary(cwd, scope)).toThrow(/ambiguous/i);
    });
  });
});

describe("getUnifiedDiff — backward compat (no scope)", () => {
  it("returns diff against HEAD when scope is undefined", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "foo.ts"), "// foo modified\n", "utf8");
      const diff = getUnifiedDiff(cwd);
      expect(diff).toContain("foo modified");
      expect(diff).toContain("--- a/src/foo.ts");
    });
  });

  it("returns same result for scope undefined and { kind: 'default' }", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "foo.ts"), "// foo modified\n", "utf8");
      const a = getUnifiedDiff(cwd);
      const b = getUnifiedDiff(cwd, { kind: "default" });
      expect(a).toEqual(b);
    });
  });

  it("returns same result for { kind: 'guidance' } as for default", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "foo.ts"), "// foo modified\n", "utf8");
      const a = getUnifiedDiff(cwd, { kind: "default" });
      const b = getUnifiedDiff(cwd, { kind: "guidance", text: "focus on auth" });
      expect(a).toEqual(b);
    });
  });

  it("falls back to git show when working tree is clean", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      const diff = getUnifiedDiff(cwd);
      expect(diff).toContain("src/foo.ts");
    });
  });

  it("returns empty string in fresh repo with no commits", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omre-fresh-diff-"));
    try {
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmp, stdio: "ignore" });
      const diff = getUnifiedDiff(tmp);
      expect(diff).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("respects files filter when provided as third argument", () => {
    withCleanGitRepo((cwd) => {
      fs.writeFileSync(path.join(cwd, "a.ts"), "// a\n", "utf8");
      fs.writeFileSync(path.join(cwd, "b.ts"), "// b\n", "utf8");
      execFileSync("git", ["add", "a.ts", "b.ts"], { cwd, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add"],
        { cwd, stdio: "ignore" }
      );
      fs.writeFileSync(path.join(cwd, "a.ts"), "// a edited\n", "utf8");
      fs.writeFileSync(path.join(cwd, "b.ts"), "// b edited\n", "utf8");
      const diff = getUnifiedDiff(cwd, undefined, ["a.ts"]);
      expect(diff).toContain("a.ts");
      expect(diff).not.toContain("b.ts");
    });
  });
});

describe("getUnifiedDiff — scope: staged", () => {
  it("returns staged diff via git diff --cached --no-ext-diff", () => {
    withRepoWithStagedFile("src/staged.ts", "// staged content\n", (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "untracked.ts"), "// untracked\n", "utf8");
      const diff = getUnifiedDiff(cwd, { kind: "staged" });
      expect(diff).toContain("staged content");
      expect(diff).not.toContain("untracked");
    });
  });

  it("returns empty string when nothing is staged", () => {
    withCleanGitRepo((cwd) => {
      fs.writeFileSync(path.join(cwd, "untracked.ts"), "// untracked\n", "utf8");
      const diff = getUnifiedDiff(cwd, { kind: "staged" });
      expect(diff).toBe("");
    });
  });
});

describe("getUnifiedDiff — scope: commit", () => {
  it("returns diff for a specific commit via git show --format=", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo content\n" }, (cwd) => {
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
      const diff = getUnifiedDiff(cwd, { kind: "commit", ref: sha });
      expect(diff).toContain("src/foo.ts");
      expect(diff).toContain("foo content");
      // --format= suppresses the commit header
      expect(diff).not.toContain(`commit ${sha}`);
    });
  });

  it("works with HEAD ref", () => {
    withRepoOnBranch("feature", { "src/foo.ts": "// foo\n" }, (cwd) => {
      const diff = getUnifiedDiff(cwd, { kind: "commit", ref: "HEAD" });
      expect(diff).toContain("src/foo.ts");
    });
  });

  it("throws GitError on unknown ref", () => {
    withCleanGitRepo((cwd) => {
      expect(() => getUnifiedDiff(cwd, { kind: "commit", ref: "deadbeef" })).toThrow(GitError);
    });
  });

  it("filters by files when provided", () => {
    withRepoOnBranch(
      "feature",
      { "src/foo.ts": "// foo\n", "src/bar.ts": "// bar\n" },
      (cwd) => {
        const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
        const diff = getUnifiedDiff(cwd, { kind: "commit", ref: sha }, ["src/foo.ts"]);
        expect(diff).toContain("src/foo.ts");
        expect(diff).not.toContain("src/bar.ts");
      }
    );
  });
});

describe("getUnifiedDiff — scope: branch", () => {
  it("returns three-dot diff between branch and HEAD", () => {
    withRepoWithBranches(
      {
        "feature-a": { "src/a.ts": "// a content\n" },
        "feature-b": { "src/b.ts": "// b content\n" },
      },
      (cwd) => {
        const diff = getUnifiedDiff(cwd, { kind: "branch", name: "feature-a" });
        expect(diff).toContain("src/b.ts");
        expect(diff).toContain("b content");
        expect(diff).not.toContain("a content");
      }
    );
  });

  it("throws GitError on unknown branch", () => {
    withCleanGitRepo((cwd) => {
      expect(() => getUnifiedDiff(cwd, { kind: "branch", name: "nope-no-such-branch" })).toThrow(
        GitError
      );
    });
  });
});

describe("getUnifiedDiff — scope: range", () => {
  it("returns three-dot diff between two refs", () => {
    withRepoWithBranches(
      {
        "feature-a": { "src/a.ts": "// a\n" },
        "feature-b": { "src/b.ts": "// b\n" },
      },
      (cwd) => {
        const diff = getUnifiedDiff(cwd, {
          kind: "range",
          from: "feature-a",
          to: "feature-b",
        });
        expect(diff).toContain("src/b.ts");
      }
    );
  });

  it("throws GitError on invalid refs", () => {
    withCleanGitRepo((cwd) => {
      expect(() =>
        getUnifiedDiff(cwd, { kind: "range", from: "nope-a", to: "nope-b" })
      ).toThrow(GitError);
    });
  });
});

describe("getUnifiedDiff — scope: paths", () => {
  it("limits diff to scope.paths via git diff -- <paths>", () => {
    withRepoOnBranch("feature", { "src/keep.ts": "// keep\n" }, (cwd) => {
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "keep.ts"), "// keep edited\n", "utf8");
      fs.writeFileSync(path.join(cwd, "test", "drop.ts"), "// drop\n", "utf8");
      execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "edit"],
        { cwd, stdio: "ignore" }
      );
      fs.writeFileSync(path.join(cwd, "src", "keep.ts"), "// keep edited again\n", "utf8");
      fs.writeFileSync(path.join(cwd, "test", "drop.ts"), "// drop edited\n", "utf8");
      const diff = getUnifiedDiff(cwd, { kind: "paths", paths: ["src/"] });
      expect(diff).toContain("src/keep.ts");
      expect(diff).not.toContain("test/drop.ts");
    });
  });

  it("supports multiple path prefixes", () => {
    withCleanGitRepo((cwd) => {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "a.ts"), "// a\n", "utf8");
      fs.writeFileSync(path.join(cwd, "test", "b.ts"), "// b\n", "utf8");
      fs.writeFileSync(path.join(cwd, "docs", "c.md"), "// c\n", "utf8");
      execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add"],
        { cwd, stdio: "ignore" }
      );
      fs.writeFileSync(path.join(cwd, "src", "a.ts"), "// a edited\n", "utf8");
      fs.writeFileSync(path.join(cwd, "test", "b.ts"), "// b edited\n", "utf8");
      fs.writeFileSync(path.join(cwd, "docs", "c.md"), "// c edited\n", "utf8");
      const diff = getUnifiedDiff(cwd, { kind: "paths", paths: ["src/", "test/"] });
      expect(diff).toContain("src/a.ts");
      expect(diff).toContain("test/b.ts");
      expect(diff).not.toContain("docs/c.md");
    });
  });
});

describe("getUnifiedDiff — scope: ambiguous", () => {
  it("throws Error when scope is ambiguous", () => {
    withCleanGitRepo((cwd) => {
      const scope: ReviewScope = {
        kind: "ambiguous",
        candidates: [
          { kind: "branch", name: "main" },
          { kind: "commit", ref: "main" },
        ],
      };
      expect(() => getUnifiedDiff(cwd, scope)).toThrow(/ambiguous/i);
    });
  });
});

describe("getUnifiedDiff — preserves --no-ext-diff", () => {
  it("produces standard unified-diff markers (proves --no-ext-diff)", () => {
    withRepoWithStagedFile("src/x.ts", "// content\n", (cwd) => {
      const diff = getUnifiedDiff(cwd, { kind: "staged" });
      expect(diff).toMatch(/^diff --git /m);
    });
  });
});

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildReviewCodePrompt } from "../../src/workflow/run-review-code.js";
import {
  withRepoWithSecret,
  withRepoWithOversizedDiff,
  withRepoWithStagedFile,
} from "../_helpers/fixture-repo.js";

function gitCommit(cwd: string, message: string) {
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message],
    { cwd, stdio: "ignore" }
  );
}

function makeLargeContent(): string {
  // Use a pattern that breaks secret-scanner regex runs (>31 alphanumeric chars)
  // so truncation tests are not silently defeated by redaction shrinking the diff.
  const line = ("x".repeat(31) + " ").repeat(3) + "x".repeat(7) + "\n";
  const linesNeeded = Math.ceil((250 * 1024) / line.length);
  return line.repeat(linesNeeded);
}

function withManyFilesRepo<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-many-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    for (let i = 1; i <= 25; i++) {
      const dir = i === 1 ? "" : `src/module${String(i).padStart(2, "0")}`;
      const filePath = dir ? path.join(dir, "file.ts") : `root${i}.ts`;
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, `// file ${i}\n`, "utf8");
    }
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "add many files");

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function withBranchWithSecret<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-branch-secret-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "secret.txt"), "AKIAIOSFODNN7EXAMPLE is my aws key\n", "utf8");
    execFileSync("git", ["add", "secret.txt"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "add secret");

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function withBranchWithOversizedDiff<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-branch-oversized-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: tmpDir, stdio: "ignore" });
    const content = makeLargeContent();
    fs.writeFileSync(path.join(tmpDir, "large.txt"), content, "utf8");
    execFileSync("git", ["add", "large.txt"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "add oversized file");

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function withBranchWithManyFiles<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-branch-many-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: tmpDir, stdio: "ignore" });
    for (let i = 1; i <= 25; i++) {
      const dir = i === 1 ? "" : `src/module${String(i).padStart(2, "0")}`;
      const filePath = dir ? path.join(dir, "file.ts") : `root${i}.ts`;
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, `// file ${i}\n`, "utf8");
    }
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "add many files");

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function withPathsWithSecret<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-paths-secret-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "secret.txt"), "AKIAIOSFODNN7EXAMPLE is my aws key\n", "utf8");
    execFileSync("git", ["add", "src/secret.txt"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "add secret");

    fs.writeFileSync(path.join(tmpDir, "src", "secret.txt"), "AKIAIOSFODNN7EXAMPLE is my aws key\nmodified\n", "utf8");

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function withPathsWithOversizedDiff<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-paths-oversized-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "large.txt"), "initial\n", "utf8");
    execFileSync("git", ["add", "src/large.txt"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "add large placeholder");

    const largeContent = makeLargeContent();
    fs.writeFileSync(path.join(tmpDir, "src", "large.txt"), largeContent, "utf8");

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function withPathsWithManyFiles<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-paths-many-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    for (let i = 1; i <= 25; i++) {
      const dir = `src/module${String(i).padStart(2, "0")}`;
      const filePath = path.join(dir, "file.ts");
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, `// file ${i}\n`, "utf8");
    }
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "add many files");

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function withStagedWithOversizedDiff<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-staged-oversized-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    const content = makeLargeContent();
    fs.writeFileSync(path.join(tmpDir, "large.txt"), content, "utf8");
    execFileSync("git", ["add", "large.txt"], { cwd: tmpDir, stdio: "ignore" });

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function withStagedWithManyFiles<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-staged-many-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    for (let i = 1; i <= 25; i++) {
      const dir = i === 1 ? "" : `src/module${String(i).padStart(2, "0")}`;
      const filePath = dir ? path.join(dir, "file.ts") : `root${i}.ts`;
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, `// file ${i}\n`, "utf8");
    }
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("scope safety contracts", () => {
  describe("default scope", () => {
    it("redacts secrets", () => {
      withRepoWithSecret((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
        expect(bundle.prompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(bundle.prompt).toContain("[REDACTED_AWS_ACCESS_KEY_ID]");
      });
    });

    it("truncates diff above 180KB", () => {
      withRepoWithOversizedDiff((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
        expect(bundle.prompt).toContain("[WARNING: Diff truncated");
      });
    });

    it("enables compactMode for >20 files", () => {
      withManyFilesRepo((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
        expect(bundle.prompt).toContain("compactMode: true");
      });
    });
  });

  describe("staged scope", () => {
    it("redacts secrets", () => {
      withRepoWithStagedFile("secret.txt", "AKIAIOSFODNN7EXAMPLE is my aws key\n", (cwd) => {
        const bundle = buildReviewCodePrompt({ args: "staged", cwd }, true);
        expect(bundle.prompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(bundle.prompt).toContain("[REDACTED_AWS_ACCESS_KEY_ID]");
      });
    });

    it("truncates diff above 180KB", () => {
      withStagedWithOversizedDiff((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "staged", cwd }, true);
        expect(bundle.prompt).toContain("[WARNING: Diff truncated");
      });
    });

    it("enables compactMode for >20 staged files", () => {
      withStagedWithManyFiles((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "staged", cwd }, true);
        expect(bundle.prompt).toContain("compactMode: true");
      });
    });
  });

  describe("commit scope", () => {
    it("redacts secrets", () => {
      withRepoWithSecret((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "commit:HEAD", cwd }, true);
        expect(bundle.prompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(bundle.prompt).toContain("[REDACTED_AWS_ACCESS_KEY_ID]");
      });
    });

    it("truncates diff above 180KB", () => {
      withRepoWithOversizedDiff((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "commit:HEAD", cwd }, true);
        expect(bundle.prompt).toContain("[WARNING: Diff truncated");
      });
    });

    it("enables compactMode for >20 files", () => {
      withManyFilesRepo((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "commit:HEAD", cwd }, true);
        expect(bundle.prompt).toContain("compactMode: true");
      });
    });
  });

  describe("branch scope", () => {
    it("redacts secrets", () => {
      withBranchWithSecret((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "branch:main", cwd }, true);
        expect(bundle.prompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(bundle.prompt).toContain("[REDACTED_AWS_ACCESS_KEY_ID]");
      });
    });

    it("truncates diff above 180KB", () => {
      withBranchWithOversizedDiff((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "branch:main", cwd }, true);
        expect(bundle.prompt).toContain("[WARNING: Diff truncated");
      });
    });

    it("enables compactMode for >20 files", () => {
      withBranchWithManyFiles((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "branch:main", cwd }, true);
        expect(bundle.prompt).toContain("compactMode: true");
      });
    });
  });

  describe("range scope", () => {
    it("redacts secrets", () => {
      withRepoWithSecret((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "range:HEAD~1..HEAD", cwd }, true);
        expect(bundle.prompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(bundle.prompt).toContain("[REDACTED_AWS_ACCESS_KEY_ID]");
      });
    });

    it("truncates diff above 180KB", () => {
      withRepoWithOversizedDiff((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "range:HEAD~1..HEAD", cwd }, true);
        expect(bundle.prompt).toContain("[WARNING: Diff truncated");
      });
    });

    it("enables compactMode for >20 files", () => {
      withManyFilesRepo((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "range:HEAD~1..HEAD", cwd }, true);
        expect(bundle.prompt).toContain("compactMode: true");
      });
    });
  });

  describe("paths scope", () => {
    it("redacts secrets", () => {
      withPathsWithSecret((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "path:src", cwd }, true);
        expect(bundle.prompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(bundle.prompt).toContain("[REDACTED_AWS_ACCESS_KEY_ID]");
      });
    });

    it("truncates diff above 180KB", () => {
      withPathsWithOversizedDiff((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "path:src", cwd }, true);
        expect(bundle.prompt).toContain("[WARNING: Diff truncated");
      });
    });

    it("enables compactMode for >20 files", () => {
      withPathsWithManyFiles((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "path:src", cwd }, true);
        expect(bundle.prompt).toContain("compactMode: true");
      });
    });
  });

  describe("guidance scope", () => {
    it("redacts secrets", () => {
      withRepoWithSecret((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "focus on security", cwd }, true);
        expect(bundle.prompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(bundle.prompt).toContain("[REDACTED_AWS_ACCESS_KEY_ID]");
      });
    });

    it("truncates diff above 180KB", () => {
      withRepoWithOversizedDiff((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "focus on security", cwd }, true);
        expect(bundle.prompt).toContain("[WARNING: Diff truncated");
      });
    });

    it("enables compactMode for >20 files", () => {
      withManyFilesRepo((cwd) => {
        const bundle = buildReviewCodePrompt({ args: "focus on security", cwd }, true);
        expect(bundle.prompt).toContain("compactMode: true");
      });
    });
  });
});

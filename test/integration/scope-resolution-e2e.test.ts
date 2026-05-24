import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReviewCodePrompt } from "../../src/workflow/run-review-code.js";
import { AmbiguousScopeError } from "../../src/workflow/scope-resolver.js";

function gitCommit(cwd: string, message: string) {
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message],
    { cwd, stdio: "ignore" }
  );
}

describe("scope resolution e2e", () => {
  let cwd: string;
  let sha: string;

  beforeAll(() => {
    const absoluteTmpDir = fs.mkdtempSync(path.join(process.cwd(), "omre-scope-e2e-"));
    cwd = path.relative(process.cwd(), absoluteTmpDir);

    execFileSync("git", ["init", "--initial-branch=main"], { cwd: absoluteTmpDir, stdio: "ignore" });

    fs.writeFileSync(path.join(absoluteTmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: absoluteTmpDir, stdio: "ignore" });
    gitCommit(absoluteTmpDir, "init");

    fs.mkdirSync(path.join(absoluteTmpDir, "src", "auth"), { recursive: true });
    fs.mkdirSync(path.join(absoluteTmpDir, "src", "payment"), { recursive: true });
    fs.mkdirSync(path.join(absoluteTmpDir, "docs"), { recursive: true });
    fs.mkdirSync(path.join(absoluteTmpDir, "auth"), { recursive: true });
    fs.writeFileSync(path.join(absoluteTmpDir, "src", "auth", "login.ts"), "// auth login\n", "utf8");
    fs.writeFileSync(path.join(absoluteTmpDir, "src", "payment", "process.ts"), "// payment process\n", "utf8");
    fs.writeFileSync(path.join(absoluteTmpDir, "docs", "readme.md"), "# docs\n", "utf8");
    fs.writeFileSync(path.join(absoluteTmpDir, "auth", "index.ts"), "// auth index\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: absoluteTmpDir, stdio: "ignore" });
    gitCommit(absoluteTmpDir, "add base files");

    fs.writeFileSync(path.join(absoluteTmpDir, "src", "utils.ts"), "// utils\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: absoluteTmpDir, stdio: "ignore" });
    gitCommit(absoluteTmpDir, "add utils");

    sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: absoluteTmpDir, encoding: "utf8" }).trim();

    const baseCommit = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: absoluteTmpDir, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-b", "feature/auth-fix", baseCommit], { cwd: absoluteTmpDir, stdio: "ignore" });

    fs.writeFileSync(path.join(absoluteTmpDir, "src", "auth", "fix.ts"), "// auth fix\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: absoluteTmpDir, stdio: "ignore" });
    gitCommit(absoluteTmpDir, "auth fix");

    execFileSync("git", ["checkout", "main"], { cwd: absoluteTmpDir, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "auth"], { cwd: absoluteTmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(absoluteTmpDir, "auth", "branch.ts"), "// branch file\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: absoluteTmpDir, stdio: "ignore" });
    gitCommit(absoluteTmpDir, "auth branch commit");

    execFileSync("git", ["checkout", "feature/auth-fix"], { cwd: absoluteTmpDir, stdio: "ignore" });

    fs.writeFileSync(path.join(absoluteTmpDir, "src", "auth", "login.ts"), "// auth login modified\n", "utf8");

    fs.writeFileSync(path.join(absoluteTmpDir, "src", "staged.ts"), "// staged\n", "utf8");
    execFileSync("git", ["add", "src/staged.ts"], { cwd: absoluteTmpDir, stdio: "ignore" });
  });

  afterAll(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('args="" resolves to default scope and includes changed files', () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd });
    expect(bundle.prompt).toContain("Changed files:");
    expect(bundle.files).toContain("src/auth/login.ts");
    expect(bundle.files).toContain("src/staged.ts");
    expect(bundle.estimatedTasks).toBeGreaterThan(0);
  });

  it('args="focus on security" resolves to guidance scope with same files', () => {
    const bundle = buildReviewCodePrompt({ args: "focus on security", cwd });
    expect(bundle.prompt).toContain("Changed files:");
    expect(bundle.prompt).toContain("focus on security");
    expect(bundle.files).toContain("src/auth/login.ts");
    expect(bundle.files).toContain("src/staged.ts");
    expect(bundle.estimatedTasks).toBeGreaterThan(0);
  });

  it("bare SHA resolves to commit scope and includes commit files", () => {
    const bundle = buildReviewCodePrompt({ args: sha, cwd });
    expect(bundle.prompt).toContain(`commit (${sha})`);
    expect(bundle.files).toContain("src/utils.ts");
    expect(bundle.estimatedTasks).toBeGreaterThan(0);
  });

  it('args="branch:main" resolves to branch scope and shows feature-branch-only files', () => {
    const bundle = buildReviewCodePrompt({ args: "branch:main", cwd });
    expect(bundle.prompt).toContain("branch (main)");
    expect(bundle.files).toContain("src/auth/fix.ts");
    expect(bundle.files).not.toContain("src/utils.ts");
    expect(bundle.estimatedTasks).toBeGreaterThan(0);
  });

  it('args="path:src/auth" resolves to paths scope and shows only src/auth files', () => {
    const bundle = buildReviewCodePrompt({ args: "path:src/auth", cwd });
    expect(bundle.prompt).toContain("paths (src/auth)");
    expect(bundle.files).toContain("src/auth/login.ts");
    expect(bundle.files).not.toContain("src/staged.ts");
    expect(bundle.estimatedTasks).toBeGreaterThan(0);
  });

  it('args="auth" throws AmbiguousScopeError when input matches both branch and path', () => {
    expect(() => buildReviewCodePrompt({ args: "auth", cwd })).toThrow(AmbiguousScopeError);
  });
});

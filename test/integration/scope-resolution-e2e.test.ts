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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-scope-e2e-"));
    cwd = tmpDir;

    execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir, stdio: "ignore" });

    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    fs.mkdirSync(path.join(tmpDir, "src", "auth"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "src", "payment"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "auth"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "auth", "login.ts"), "// auth login\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "src", "payment", "process.ts"), "// payment process\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "docs", "readme.md"), "# docs\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "auth", "index.ts"), "// auth index\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "add base files");

    fs.writeFileSync(path.join(tmpDir, "src", "utils.ts"), "// utils\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "add utils");

    sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf8" }).trim();

    const baseCommit = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: tmpDir, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-b", "feature/auth-fix", baseCommit], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "src", "auth", "fix.ts"), "// auth fix\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "auth fix");

    execFileSync("git", ["checkout", "main"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "auth"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "auth", "branch.ts"), "// branch file\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "auth branch commit");

    execFileSync("git", ["checkout", "feature/auth-fix"], { cwd: tmpDir, stdio: "ignore" });

    fs.writeFileSync(path.join(tmpDir, "src", "auth", "login.ts"), "// auth login modified\n", "utf8");

    fs.writeFileSync(path.join(tmpDir, "src", "staged.ts"), "// staged\n", "utf8");
    execFileSync("git", ["add", "src/staged.ts"], { cwd: tmpDir, stdio: "ignore" });
  });

  afterAll(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('args="" resolves to default scope and includes changed files', () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
    expect(bundle.prompt).toContain("Changed files:");
    expect(bundle.files).toContain("src/auth/login.ts");
    expect(bundle.files).toContain("src/staged.ts");
    expect(bundle.estimatedTasks).toBeGreaterThan(0);
  });

  it('args="focus on security" resolves to guidance scope with same files', () => {
    const bundle = buildReviewCodePrompt({ args: "focus on security", cwd }, true);
    expect(bundle.prompt).toContain("Changed files:");
    expect(bundle.prompt).toContain("focus on security");
    expect(bundle.files).toContain("src/auth/login.ts");
    expect(bundle.files).toContain("src/staged.ts");
    expect(bundle.estimatedTasks).toBeGreaterThan(0);
  });

  it("bare SHA resolves to commit scope and includes commit files", () => {
    const bundle = buildReviewCodePrompt({ args: sha, cwd }, true);
    expect(bundle.prompt).toContain(`commit (${sha})`);
    expect(bundle.files).toContain("src/utils.ts");
    expect(bundle.estimatedTasks).toBeGreaterThan(0);
  });

  it('args="branch:main" resolves to branch scope and shows feature-branch-only files', () => {
    const bundle = buildReviewCodePrompt({ args: "branch:main", cwd }, true);
    expect(bundle.prompt).toContain("branch (main)");
    expect(bundle.files).toContain("src/auth/fix.ts");
    expect(bundle.files).not.toContain("src/utils.ts");
    expect(bundle.estimatedTasks).toBeGreaterThan(0);
  });

  it('args="path:src/auth" resolves to paths scope and shows only src/auth files', () => {
    const bundle = buildReviewCodePrompt({ args: "path:src/auth", cwd }, true);
    expect(bundle.prompt).toContain("paths (src/auth)");
    expect(bundle.files).toContain("src/auth/login.ts");
    expect(bundle.files).not.toContain("src/staged.ts");
    expect(bundle.estimatedTasks).toBeGreaterThan(0);
  });

  it('args="auth" throws AmbiguousScopeError when input matches both branch and path', () => {
    expect(() => buildReviewCodePrompt({ args: "auth", cwd }, true)).toThrow(AmbiguousScopeError);
  });
});

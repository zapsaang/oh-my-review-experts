import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildReviewCodePrompt } from "../../src/workflow/run-review-code.js";
import { AmbiguousScopeError } from "../../src/workflow/scope-resolver.js";
import { withCleanGitRepo, withRepoOnBranch, withHierarchicalRepo } from "../_helpers/fixture-repo.js";

describe("scope resolution e2e", () => {
  it("args=\"\" → default scope", () => {
    withCleanGitRepo((cwd) => {
      const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
      expect(bundle.prompt).toContain("Changed files:");
      expect(bundle.estimatedTasks).toBeGreaterThanOrEqual(0);
    });
  });

  it('args="focus on security" → guidance', () => {
    withCleanGitRepo((cwd) => {
      const bundle = buildReviewCodePrompt({ args: "focus on security", cwd }, true);
      expect(bundle.prompt).toContain("focus on security");
      expect(bundle.prompt).toContain("Changed files:");
    });
  });

  it("bare SHA → commit scope", () => {
    withCleanGitRepo((cwd) => {
      const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim();
      const bundle = buildReviewCodePrompt({ args: sha, cwd }, true);
      expect(bundle.prompt).toContain("Changed files:");
    });
  });

  it("branch:feature-x → branch scope", () => {
    withRepoOnBranch("feature-x", { "src/new.ts": "// new" }, (cwd) => {
      const bundle = buildReviewCodePrompt({ args: "branch:feature-x", cwd }, true);
      expect(bundle.prompt).toContain("feature-x");
    });
  });

  it("path:src/auth → paths scope", () => {
    withHierarchicalRepo((cwd) => {
      execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
        { cwd, stdio: "ignore" }
      );
      const bundle = buildReviewCodePrompt({ args: "path:src/auth", cwd }, true);
      expect(bundle.prompt).toContain("src/auth/login.ts");
      expect(bundle.prompt).not.toContain("src/payment/process.ts");
    });
  });

  it("ambiguous input throws", () => {
    withCleanGitRepo((cwd) => {
      execFileSync("git", ["checkout", "-b", "auth"], { cwd, stdio: "ignore" });
      fs.mkdirSync(path.join(cwd, "auth"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "auth", "file.ts"), "// auth\n", "utf8");
      execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "auth"],
        { cwd, stdio: "ignore" }
      );
      expect(() => buildReviewCodePrompt({ args: "auth", cwd }, true)).toThrow(AmbiguousScopeError);
    });
  });
});

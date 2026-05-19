import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReviewCodePrompt, renderLocalDryRun } from "../../src/workflow/run-review-code.js";
import { clearLoadConfigCache } from "../../src/config/load-config.js";

function withCleanGitRepo<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-review-prompt-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
      { cwd: tmpDir, stdio: "ignore" }
    );
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function withHierarchicalRepo<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-hier-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".omre/\nnode_modules/\n", "utf8");
    fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".omre", "config.json"),
      JSON.stringify({
        costGuardrail: { compactModeThreshold: 100 },
        arbitration: { hierarchicalThreshold: 3 },
      }),
      "utf8"
    );
    fs.mkdirSync(path.join(tmpDir, "src", "auth"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "src", "payment"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "src", "user"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "auth", "login.ts"), "// auth\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "src", "payment", "process.ts"), "// payment\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "src", "user", "profile.ts"), "// user\n", "utf8");
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function getExecutionRequirements(prompt: string): string {
  const afterExecution = prompt.split("Execution requirements:")[1] ?? "";
  return afterExecution.split("Unified diff follows")[0] ?? "";
}

describe("buildReviewCodePrompt", () => {
  it("returns a prompt bundle with runId", () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd: process.cwd() });
    expect(bundle.prompt).toContain("Oh My Review Experts");
    expect(bundle.runId).toBeDefined();
    expect(bundle.runId.length).toBeGreaterThan(0);
    expect(bundle.estimatedTasks).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(bundle.files)).toBe(true);
  });

  it("includes handoff runtime stanza (per-run path) in orchestrator prompt", () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd: process.cwd() });
    expect(bundle.prompt).toContain("Review Code Handoff Runtime");
    expect(bundle.prompt).toContain(bundle.runId);
    expect(bundle.prompt).toContain("handoffEnabled");
  });

  it("[L2 fix] orchestrator prompt does NOT duplicate the file-protocol embedded in reviewer staticPrompt", () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd: process.cwd() });
    const beforeDiff = bundle.prompt.split("Unified diff follows")[0] ?? "";
    expect(beforeDiff).not.toContain("Subagent Final Reply Format");
    expect(beforeDiff).not.toContain("Prohibited Behaviors");
    expect(beforeDiff).not.toContain("### Subagent Requirements");
  });

  it("[L4 fix] orchestrator prompt describes file-first recovery via omre_validate_handoff", () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd: process.cwd() });
    expect(bundle.prompt).toMatch(/omre_validate_handoff/);
  });

  it("[C1] orchestrator prompt uses camelCase isValid from omre_validate_handoff", () => {
    withCleanGitRepo((cwd) => {
      const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
      expect(bundle.prompt).not.toContain("is_valid");
      expect(bundle.prompt).toMatch(/isValid/);
    });
  });

  it("[L4 fix] orchestrator prompt describes the {ok, errors} contract for omre_write_handoff", () => {
    withCleanGitRepo((cwd) => {
      const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
      expect(bundle.prompt).toMatch(/omre_write_handoff/);
      expect(bundle.prompt).toMatch(/ok.*?(true|false)/);
      expect(bundle.prompt).toContain("taskId");
    });
  });

  it("includes report writer input rule", () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd: process.cwd() });
    expect(bundle.prompt).toContain("Report Writer Input Rule");
    expect(bundle.prompt).toContain("source of truth");
  });

  it("includes subagent catalog instead of inline reviewer prompts", () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd: process.cwd() });
    expect(bundle.prompt).toContain("Available Subagents");
    expect(bundle.prompt).toContain("reviewer-spec");
    expect(bundle.prompt).toContain("reviewer-quality");
    expect(bundle.prompt).toContain("reviewer-security");
    expect(bundle.prompt).toContain("reviewer-performance");
    expect(bundle.prompt).toContain("reviewer-concurrency");
    expect(bundle.prompt).toContain("slice-planner");
    expect(bundle.prompt).toContain("slice-arbiter");
    expect(bundle.prompt).toContain("global-arbiter");
    expect(bundle.prompt).toContain("report-writer");
  });

  it("describes orchestrator role", () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd: process.cwd() });
    expect(bundle.prompt).toContain("orchestrator");
  });

  it("includes useHierarchicalArbitration in configuration summary", () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd: process.cwd() });
    expect(bundle.prompt).toContain("useHierarchicalArbitration:");
    expect(bundle.prompt).toContain("hierarchicalThreshold:");
  });

  it("includes exactly one arbitration instruction path", () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd: process.cwd() });
    const afterExecution = bundle.prompt.split("Execution requirements:")[1] ?? "";
    const beforeDiff = afterExecution.split("Unified diff follows")[0] ?? "";
    const hasDirectGlobal = beforeDiff.includes("Run slice-level arbitration, then global arbitration.");
    const hasPerSlice = beforeDiff.includes("For each slice, invoke a slice-arbiter");
    expect(hasDirectGlobal || hasPerSlice).toBe(true);
    expect(hasDirectGlobal && hasPerSlice).toBe(false);
  });

  it("[Fix 2-A] orchestrator prompt does NOT instruct calling omre_write_report directly", () => {
    withCleanGitRepo((cwd) => {
      clearLoadConfigCache();
      const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
      const executionBlock = getExecutionRequirements(bundle.prompt);
      expect(executionBlock).not.toMatch(/Call\s+[`']?omre_write_report[`']?\s+tool/i);
    });
  });

  it("[Fix 2-A] orchestrator prompt instructs delegating to report-writer with runId only", () => {
    withCleanGitRepo((cwd) => {
      clearLoadConfigCache();
      const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
      expect(bundle.prompt).toMatch(/(Delegate|Invoke|Hand off)[^\n]*report-writer[^\n]*runId/i);
    });
  });

  it("[Fix 2-A] orchestrator prompt forbids using write tool for .omre/reports/", () => {
    withCleanGitRepo((cwd) => {
      clearLoadConfigCache();
      const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
      expect(bundle.prompt).toMatch(/DO NOT use[^.]*write[^.]*\.omre\/reports/i);
    });
  });

  it("[Fix 2-A] orchestrator prompt forbids passing a file-path reference as content", () => {
    withCleanGitRepo((cwd) => {
      clearLoadConfigCache();
      const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
      expect(bundle.prompt).toMatch(/(do not|never)[^.]*(reference|file.path)[^.]*report/i);
    });
  });

  it("[Fix 2-A] orchestrator prompt requires surfacing report-writer errors instead of falling back to write", () => {
    withCleanGitRepo((cwd) => {
      clearLoadConfigCache();
      const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
      const executionBlock = getExecutionRequirements(bundle.prompt);
      expect(executionBlock).toMatch(/surface.*error|report-writer.*error|do not retry|do not write.*directly/i);
    });
  });

  it("[Fix 2-A] both arbitration branches end at report-writer delegation", () => {
    withCleanGitRepo((cwd) => {
      clearLoadConfigCache();
      const flatBundle = buildReviewCodePrompt({ args: "", cwd }, true);
      expect(flatBundle.prompt).toContain("useHierarchicalArbitration: false");
      const flatExecution = getExecutionRequirements(flatBundle.prompt);
      expect(flatExecution).not.toMatch(/Call\s+[`']?omre_write_report[`']?\s+tool/i);
      expect(flatExecution).toMatch(/(Delegate|Invoke|Hand off)[^\n]*report-writer[^\n]*runId/i);
    });

    withHierarchicalRepo((cwd) => {
      clearLoadConfigCache();
      const hierBundle = buildReviewCodePrompt({ args: "", cwd }, true);
      expect(hierBundle.prompt).toContain("useHierarchicalArbitration: true");
      const hierExecution = getExecutionRequirements(hierBundle.prompt);
      expect(hierExecution).not.toMatch(/Call\s+[`']?omre_write_report[`']?\s+tool/i);
      expect(hierExecution).toMatch(/(Delegate|Invoke|Hand off)[^\n]*report-writer[^\n]*runId/i);
    });
  });
});

describe("renderLocalDryRun", () => {
  it("returns markdown with estimated tasks", () => {
    const markdown = renderLocalDryRun({ args: "", cwd: process.cwd() });
    expect(markdown).toContain("Review Code Dry Run");
    expect(markdown).toContain("Estimated tasks");
  });

  it("includes args guidance when provided", () => {
    const markdown = renderLocalDryRun({ args: "focus on security", cwd: process.cwd() });
    expect(markdown).toContain("Estimated tasks");
  });
});

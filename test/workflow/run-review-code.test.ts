import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildReviewCodePrompt, renderLocalDryRun } from "../../src/workflow/run-review-code.js";
import { clearLoadConfigCache } from "../../src/config/load-config.js";
import {
  withCleanGitRepo,
  withHierarchicalRepo,
  withRepoWithBranches,
} from "../_helpers/fixture-repo.js";

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
    expect(bundle.prompt).toContain("omre-reviewer-spec");
    expect(bundle.prompt).toContain("omre-reviewer-quality");
    expect(bundle.prompt).toContain("omre-reviewer-security");
    expect(bundle.prompt).toContain("omre-reviewer-performance");
    expect(bundle.prompt).toContain("omre-reviewer-concurrency");
    expect(bundle.prompt).toContain("omre-slice-planner");
    expect(bundle.prompt).toContain("omre-slice-arbiter");
    expect(bundle.prompt).toContain("omre-global-arbiter");
    expect(bundle.prompt).toContain("omre-report-writer");
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
    const hasPerSlice = beforeDiff.includes("For each slice, invoke an omre-slice-arbiter");
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

  it("[Fix 2-A] orchestrator prompt instructs delegating to omre-report-writer with runId only", () => {
    withCleanGitRepo((cwd) => {
      clearLoadConfigCache();
      const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
      expect(bundle.prompt).toMatch(/(Delegate|Invoke|Hand off)[^\n]*omre-report-writer[^\n]*runId/i);
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

  it("[Fix 2-A] orchestrator prompt requires surfacing omre-report-writer errors instead of falling back to write", () => {
    withCleanGitRepo((cwd) => {
      clearLoadConfigCache();
      const bundle = buildReviewCodePrompt({ args: "", cwd }, true);
      const executionBlock = getExecutionRequirements(bundle.prompt);
      expect(executionBlock).toMatch(/surface.*error|omre-report-writer.*error|do not retry|do not write.*directly/i);
    });
  });

  it("[Fix 2-A] both arbitration branches end at report-writer delegation", () => {
    withCleanGitRepo((cwd) => {
      clearLoadConfigCache();
      const flatBundle = buildReviewCodePrompt({ args: "", cwd }, true);
      expect(flatBundle.prompt).toContain("useHierarchicalArbitration: false");
      const flatExecution = getExecutionRequirements(flatBundle.prompt);
      expect(flatExecution).not.toMatch(/Call\s+[`']?omre_write_report[`']?\s+tool/i);
      expect(flatExecution).toMatch(/(Delegate|Invoke|Hand off)[^\n]*omre-report-writer[^\n]*runId/i);
    });

    withHierarchicalRepo((cwd) => {
      clearLoadConfigCache();
      const hierBundle = buildReviewCodePrompt({ args: "", cwd }, true);
      expect(hierBundle.prompt).toContain("useHierarchicalArbitration: true");
      const hierExecution = getExecutionRequirements(hierBundle.prompt);
      expect(hierExecution).not.toMatch(/Call\s+[`']?omre_write_report[`']?\s+tool/i);
      expect(hierExecution).toMatch(/(Delegate|Invoke|Hand off)[^\n]*omre-report-writer[^\n]*runId/i);
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

  it("with empty args, output is unchanged from today (no scope line)", () => {
    withCleanGitRepo((cwd) => {
      const markdown = renderLocalDryRun({ args: "", cwd }, true);
      expect(markdown).toContain("Review Code Dry Run");
      expect(markdown).toContain("Estimated tasks");
      expect(markdown).not.toContain("Resolved scope");
    });
  });

  it("with branch:main args, shows resolved branch scope", () => {
    withCleanGitRepo((cwd) => {
      const markdown = renderLocalDryRun({ args: "branch:main", cwd }, true);
      expect(markdown).toContain("Resolved scope: branch (main)");
      expect(markdown).toContain("Estimated tasks");
    });
  });

  it("with ../etc args, shows path traversal error inline", () => {
    withCleanGitRepo((cwd) => {
      const markdown = renderLocalDryRun({ args: "../etc", cwd }, true);
      expect(markdown).toContain("Resolved scope: error (PATH_TRAVERSAL)");
      expect(markdown).toContain("Path traversal");
    });
  });

  it("with ambiguous branch/path input, shows ambiguous scope with hints", () => {
    withRepoWithBranches(
      { auth: { "auth/index.ts": "// auth\n" } },
      (cwd) => {
        const markdown = renderLocalDryRun({ args: "auth", cwd }, true);
        expect(markdown).toContain("Resolved scope: ambiguous");
        expect(markdown).toContain("branch:auth");
        expect(markdown).toContain("path:auth");
      }
    );
  });
});

describe("[P2] formatScopeDetail — prompt scope readability", () => {
  it("branch scope shows name in parentheses", () => {
    withCleanGitRepo((cwd) => {
      const bundle = buildReviewCodePrompt({ args: "branch:main", cwd }, true);
      expect(bundle.prompt).toContain("Resolved review scope: branch (main)");
    });
  });

  it("commit scope shows ref in parentheses", () => {
    withCleanGitRepo((cwd) => {
      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
      }).trim();
      const bundle = buildReviewCodePrompt({ args: `commit:${sha}`, cwd }, true);
      expect(bundle.prompt).toContain(`Resolved review scope: commit (${sha})`);
    });
  });

  it("range scope shows from..to in parentheses", () => {
    withCleanGitRepo((cwd) => {
      fs.writeFileSync(path.join(cwd, "second.txt"), "second\n", "utf8");
      execFileSync("git", ["add", "second.txt"], { cwd, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "second"], { cwd, stdio: "ignore" });
      const bundle = buildReviewCodePrompt({ args: "range:HEAD~1..HEAD", cwd }, true);
      expect(bundle.prompt).toContain("Resolved review scope: range (HEAD~1..HEAD)");
    });
  });

  it("paths scope shows comma-separated paths in parentheses", () => {
    withCleanGitRepo((cwd) => {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "a.ts"), "// a\n", "utf8");
      fs.writeFileSync(path.join(cwd, "src", "b.ts"), "// b\n", "utf8");
      const bundle = buildReviewCodePrompt({ args: "src/a.ts,src/b.ts", cwd }, true);
      expect(bundle.prompt).toContain("Resolved review scope: paths (src/a.ts, src/b.ts)");
    });
  });
});

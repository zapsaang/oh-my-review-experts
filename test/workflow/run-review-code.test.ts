import { describe, it, expect } from "vitest";
import { buildReviewCodePrompt, renderLocalDryRun } from "../../src/workflow/run-review-code.js";

describe("buildReviewCodePrompt", () => {
  it("returns a prompt bundle with runId", () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd: process.cwd() });
    expect(bundle.prompt).toContain("Oh My Review Experts");
    expect(bundle.runId).toBeDefined();
    expect(bundle.runId.length).toBeGreaterThan(0);
    expect(bundle.estimatedTasks).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(bundle.files)).toBe(true);
  });

  it("includes handoff protocol in prompt when enabled", () => {
    const bundle = buildReviewCodePrompt({ args: "", cwd: process.cwd() });
    expect(bundle.prompt).toContain("Review Code Handoff Protocol");
    expect(bundle.prompt).toContain(bundle.runId);
    expect(bundle.prompt).toContain("handoffEnabled");
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

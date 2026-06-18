import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createTempProject,
  writeProjectConfig,
  writeRunMetaFile,
  writeHandoffFile,
  buildRegressionFinding,
} from "../helpers/finalize-fixtures.js";

interface FinalizeReviewInput {
  runId: string;
  cwd: string;
  withMemory?: boolean;
}

interface FinalizeReviewResult {
  written: string[];
  handoffsConsumed: number;
  degradedSlices: Array<{ slice_id: string; missing_dimensions: string[] }>;
  missingDimensionsGlobal: string[];
  memoryIndexResult?: { success: boolean; error?: string };
}

async function loadFinalizeReview(): Promise<{
  finalizeReview(input: FinalizeReviewInput): FinalizeReviewResult;
}> {
  const modUrl = new URL("../../src/workflow/finalize-review.js", import.meta.url);
  const mod = await import(modUrl.href);
  return mod as unknown as {
    finalizeReview(input: FinalizeReviewInput): FinalizeReviewResult;
  };
}

describe("e2e regression detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders regression section when reviewer reports regression (state 3)", async () => {
    const runId = "run-e2e-regression-state3";
    writeHandoffFile(tmpDir, runId, "handoff-1.md", {
      findings: [buildRegressionFinding()],
    });

    const { finalizeReview } = await loadFinalizeReview();
    finalizeReview({ runId, cwd: tmpDir, withMemory: true });

    const latestMd = fs.readFileSync(
      path.join(tmpDir, ".omre", "reports", "latest.md"),
      "utf8"
    );
    const latestJson = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".omre", "reports", "latest.json"),
        "utf8"
      )
    );

    expect(latestMd).toContain("## Historical Regressions");
    expect(latestMd).toContain("**1** finding(s) recur from previously-fixed issues in Review Memory");
    expect(latestMd).toContain("Hardcoded secret");
    expect(latestMd).toContain("🔴 **Historical Regression**");
    expect(latestMd).toContain("- 🔴 **Hardcoded secret**");
    expect(latestMd).toContain("mem_abc123");
    expect(latestMd).toContain(
      "Re-introduces the SQL injection previously fixed and recorded in memory"
    );

    expect(latestJson.summary.regression_count).toBe(1);
    expect(latestJson.regressions).toHaveLength(1);
    expect(latestJson.regressions[0].finding_id).toBe("sec-1");
    expect(latestJson.regressions[0].memory_refs).toContain("mem_abc123");
    expect(latestJson.regressions[0].regression_reason).toBe(
      "Re-introduces the SQL injection previously fixed and recorded in memory"
    );
  });

  it("shows disabled prompt when withMemory is false (state 1)", async () => {
    const runId = "run-e2e-regression-state1";
    writeHandoffFile(tmpDir, runId, "handoff-1.md", {
      agent: "omre-reviewer-security",
      dimension: "security",
    });
    writeHandoffFile(tmpDir, runId, "handoff-2.md", {
      agent: "omre-reviewer-quality",
      dimension: "quality",
    });

    const { finalizeReview } = await loadFinalizeReview();
    finalizeReview({ runId, cwd: tmpDir, withMemory: false });

    const latestMd = fs.readFileSync(
      path.join(tmpDir, ".omre", "reports", "latest.md"),
      "utf8"
    );

    expect(latestMd).toContain("## Historical Regressions");
    expect(latestMd).toContain("Review Memory retrieval was not active");
    expect(latestMd).toContain("--with-memory");
    expect(latestMd).toContain("memory.retrieval.enabled");
    expect(latestMd).not.toContain("No historical regressions detected");
    expect(latestMd).not.toContain("🔴");
  });

  it("shows 'no regressions' when retrieval active but no regression reported (state 2)", async () => {
    const runId = "run-e2e-regression-state2";
    writeHandoffFile(tmpDir, runId, "handoff-1.md", {
      agent: "omre-reviewer-security",
      dimension: "security",
    });
    writeHandoffFile(tmpDir, runId, "handoff-2.md", {
      agent: "omre-reviewer-quality",
      dimension: "quality",
    });

    const { finalizeReview } = await loadFinalizeReview();
    finalizeReview({ runId, cwd: tmpDir, withMemory: true });

    const latestMd = fs.readFileSync(
      path.join(tmpDir, ".omre", "reports", "latest.md"),
      "utf8"
    );
    const latestJson = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".omre", "reports", "latest.json"),
        "utf8"
      )
    );

    expect(latestMd).toContain("## Historical Regressions");
    expect(latestMd).toContain("No historical regressions detected");
    expect(latestMd).toContain("None of this run's findings match previously-fixed issues");
    expect(latestMd).not.toContain("Review Memory retrieval was not active");

    expect(latestJson.summary.regression_count).toBe(0);
    expect(latestJson.regressions).toHaveLength(0);
  });

  it("renders boundary hint when retrieval is off but regressions exist", async () => {
    const runId = "run-e2e-regression-boundary";
    writeHandoffFile(tmpDir, runId, "handoff-1.md", {
      findings: [buildRegressionFinding()],
    });

    const { finalizeReview } = await loadFinalizeReview();
    finalizeReview({ runId, cwd: tmpDir, withMemory: false });

    const latestMd = fs.readFileSync(
      path.join(tmpDir, ".omre", "reports", "latest.md"),
      "utf8"
    );

    expect(latestMd).toContain("## Historical Regressions");
    expect(latestMd).toContain(
      "Review Memory retrieval was not active for this run, but a reviewer reported potential regressions"
    );
    expect(latestMd).toContain("Hardcoded secret");
    expect(latestMd).toContain("🔴 **Historical Regression**");
    expect(latestMd).toContain("- 🔴 **Hardcoded secret**");
    expect(latestMd).not.toContain(
      "**1** finding(s) recur from previously-fixed issues in Review Memory"
    );
  });

  it("reads marker and renders active-empty state without input flag", async () => {
    const runId = "run-e2e-marker-active-empty";
    writeRunMetaFile(tmpDir, runId, { withMemory: true, noMemory: false });
    writeHandoffFile(tmpDir, runId, "handoff-1.md", {
      agent: "omre-reviewer-security",
      dimension: "security",
    });
    writeHandoffFile(tmpDir, runId, "handoff-2.md", {
      agent: "omre-reviewer-quality",
      dimension: "quality",
    });

    const { finalizeReview } = await loadFinalizeReview();
    finalizeReview({ runId, cwd: tmpDir });

    const latestMd = fs.readFileSync(
      path.join(tmpDir, ".omre", "reports", "latest.md"),
      "utf8"
    );

    expect(latestMd).toContain("## Historical Regressions");
    expect(latestMd).toContain("No historical regressions detected");
    expect(latestMd).toContain("None of this run's findings match previously-fixed issues");
    expect(latestMd).not.toContain("Review Memory retrieval was not active");
  });

  it("reads marker and renders disabled hint without input flag", async () => {
    const runId = "run-e2e-marker-disabled";
    writeRunMetaFile(tmpDir, runId, { withMemory: false, noMemory: false });
    writeHandoffFile(tmpDir, runId, "handoff-1.md", {
      agent: "omre-reviewer-security",
      dimension: "security",
    });
    writeHandoffFile(tmpDir, runId, "handoff-2.md", {
      agent: "omre-reviewer-quality",
      dimension: "quality",
    });

    const { finalizeReview } = await loadFinalizeReview();
    finalizeReview({ runId, cwd: tmpDir });

    const latestMd = fs.readFileSync(
      path.join(tmpDir, ".omre", "reports", "latest.md"),
      "utf8"
    );

    expect(latestMd).toContain("## Historical Regressions");
    expect(latestMd).toContain("Review Memory retrieval was not active");
    expect(latestMd).toContain("--with-memory");
    expect(latestMd).toContain("memory.retrieval.enabled");
    expect(latestMd).not.toContain("No historical regressions detected");
  });

  it("memory.enabled=false overrides marker withMemory=true", async () => {
    const runId = "run-e2e-memory-disabled";
    writeProjectConfig(tmpDir, { memory: { enabled: false } });
    writeRunMetaFile(tmpDir, runId, { withMemory: true, noMemory: false });
    writeHandoffFile(tmpDir, runId, "handoff-1.md", {
      agent: "omre-reviewer-security",
      dimension: "security",
    });
    writeHandoffFile(tmpDir, runId, "handoff-2.md", {
      agent: "omre-reviewer-quality",
      dimension: "quality",
    });

    const { finalizeReview } = await loadFinalizeReview();
    finalizeReview({ runId, cwd: tmpDir });

    const latestMd = fs.readFileSync(
      path.join(tmpDir, ".omre", "reports", "latest.md"),
      "utf8"
    );

    expect(latestMd).toContain("## Historical Regressions");
    expect(latestMd).toContain("Review Memory retrieval was not active");
    expect(latestMd).toContain("--with-memory");
    expect(latestMd).toContain("memory.retrieval.enabled");
    expect(latestMd).not.toContain("No historical regressions detected");
  });

  it("noMemory=true overrides retrieval.enabled=true", async () => {
    const runId = "run-e2e-no-memory-precedence";
    writeProjectConfig(tmpDir, {
      memory: { enabled: true, retrieval: { enabled: true } },
    });
    writeRunMetaFile(tmpDir, runId, { withMemory: false, noMemory: true });
    writeHandoffFile(tmpDir, runId, "handoff-1.md", {
      agent: "omre-reviewer-security",
      dimension: "security",
    });
    writeHandoffFile(tmpDir, runId, "handoff-2.md", {
      agent: "omre-reviewer-quality",
      dimension: "quality",
    });

    const { finalizeReview } = await loadFinalizeReview();
    finalizeReview({ runId, cwd: tmpDir });

    const latestMd = fs.readFileSync(
      path.join(tmpDir, ".omre", "reports", "latest.md"),
      "utf8"
    );

    expect(latestMd).toContain("## Historical Regressions");
    expect(latestMd).toContain("Review Memory retrieval was not active");
    expect(latestMd).toContain("--with-memory");
    expect(latestMd).toContain("memory.retrieval.enabled");
    expect(latestMd).not.toContain("No historical regressions detected");
  });
});

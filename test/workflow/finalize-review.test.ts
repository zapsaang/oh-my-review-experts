import { afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Local interfaces for the missing src/workflow/finalize-review.ts module.
// These keep the test file typecheck-clean without a static import.
// ---------------------------------------------------------------------------

interface FinalizeReviewInput {
  runId: string;
  cwd: string;
  trusted?: boolean;
}

interface DegradedSlice {
  slice_id: string;
  missing_dimensions: string[];
}

interface FinalizeReviewResult {
  written: string[];
  handoffsConsumed: number;
  degradedSlices: DegradedSlice[];
  missingDimensionsGlobal: string[];
  memoryIndexResult?: {
    success: boolean;
    error?: string;
  };
}

interface IndexLatestOptions {
  cwd?: string;
}

interface IndexLatestResult {
  runId: string;
  rawFindings: number;
  normalizedFindings: number;
  existingFindings: number;
  eventsGenerated: number;
  findingsDeduplicated: number;
  dryRun: boolean;
}

interface AutoCompactThresholdResult {
  needsCompaction: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Dynamic import helper — uses a non-literal specifier so TypeScript does
// NOT attempt static module resolution of the missing file.
// ---------------------------------------------------------------------------

async function loadFinalizeReview(): Promise<{
  finalizeReview(input: FinalizeReviewInput): FinalizeReviewResult;
}> {
  const segments = ["..", "..", "src", "workflow", "finalize-review.js"];
  const modPath = segments.join("/");
  const mod = await import(modPath);
  return mod as unknown as {
    finalizeReview(input: FinalizeReviewInput): FinalizeReviewResult;
  };
}

async function loadFinalizeReviewWithMemoryMocks(options: {
  runIndexLatest?: (input: IndexLatestOptions) => IndexLatestResult;
  checkAutoCompactThreshold?: (cwd: string, memoryConfig: unknown) => AutoCompactThresholdResult;
} = {}): Promise<{
  finalizeReview(input: FinalizeReviewInput): FinalizeReviewResult;
  runIndexLatestMock: ReturnType<typeof vi.fn<(input: IndexLatestOptions) => IndexLatestResult>>;
  checkAutoCompactThresholdMock: ReturnType<typeof vi.fn<(cwd: string, memoryConfig: unknown) => AutoCompactThresholdResult>>;
}> {
  vi.resetModules();
  const runIndexLatestMock = vi.fn<(input: IndexLatestOptions) => IndexLatestResult>(
    options.runIndexLatest ?? (() => buildIndexLatestResult())
  );
  const checkAutoCompactThresholdMock = vi.fn<(cwd: string, memoryConfig: unknown) => AutoCompactThresholdResult>(
    options.checkAutoCompactThreshold ?? (() => ({ needsCompaction: false }))
  );

  vi.doMock("../../src/memory/indexing.js", () => ({
    runIndexLatest: runIndexLatestMock,
  }));
  vi.doMock("../../src/memory/pipeline.js", () => ({
    checkAutoCompactThreshold: checkAutoCompactThresholdMock,
  }));

  const mod = await loadFinalizeReview();
  return {
    finalizeReview: mod.finalizeReview,
    runIndexLatestMock,
    checkAutoCompactThresholdMock,
  };
}

afterEach(() => {
  vi.doUnmock("../../src/memory/indexing.js");
  vi.doUnmock("../../src/memory/pipeline.js");
  vi.resetModules();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function createTempProject(): string {
  const absoluteTmpDir = fs.mkdtempSync(path.join(process.cwd(), "omre-finalize-"));
  const relativeTmpDir = path.relative(process.cwd(), absoluteTmpDir);
  fs.mkdirSync(path.join(absoluteTmpDir, ".omre"), { recursive: true });
  writeProjectConfig(absoluteTmpDir);
  return relativeTmpDir;
}

function writeProjectConfig(cwd: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(cwd, ".omre"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".omre", "config.json"),
    JSON.stringify({
      report: {
        enabled: true,
        directory: ".omre/reports",
        timestamped: true,
        latestMarkdown: "latest.md",
        latestJson: "latest.json",
      },
      handoff: {
        enabled: true,
        directory: ".omre/handoffs",
      },
      ...overrides,
    }),
    "utf8"
  );
}

function buildIndexLatestResult(): IndexLatestResult {
  return {
    runId: "mock-run",
    rawFindings: 1,
    normalizedFindings: 1,
    existingFindings: 0,
    eventsGenerated: 1,
    findingsDeduplicated: 0,
    dryRun: false,
  };
}

function buildHandoffJsonHeader(
  overrides: Record<string, unknown> = {}
): string {
  const base = {
    schema_version: "1",
    task_id: "task-123",
    agent: "omre-reviewer-security",
    dimension: "security",
    status: "completed",
    target: { kind: "working-tree", value: "src/auth.ts" },
    slice_id: "slice-1",
    findings: [
      {
        id: "sec-1",
        severity: "critical",
        file: "src/auth.ts",
        line: 42,
        title: "Hardcoded secret",
        description: "API key is hardcoded in source",
        evidence: "const API_KEY = 'sk-...'",
        confidence: "high",
        classification: "injection",
      },
    ],
    meta: { total_findings: 1, notes: "" },
    ...overrides,
  };
  return "```json\n" + JSON.stringify(base, null, 2) + "\n```";
}

function writeHandoffFile(
  cwd: string,
  runId: string,
  filename: string,
  overrides: Record<string, unknown> = {}
): void {
  const handoffDir = path.join(cwd, ".omre", "handoffs", runId);
  fs.mkdirSync(handoffDir, { recursive: true });
  const content =
    buildHandoffJsonHeader(overrides) +
    "\n\n# Review Handoff\n\nTest body content for deterministic rendering.\n";
  fs.writeFileSync(path.join(handoffDir, filename), content, "utf8");
}

// ---------------------------------------------------------------------------
// RED tests — each will fail at runtime because src/workflow/finalize-review.ts
// does not exist yet (T7 implements it).
// ---------------------------------------------------------------------------

describe("finalizeReview [Fix 2-B RED]", () => {
  it("reads all handoff files in .omre/handoffs/{runId}/ and emits a markdown report >= 50 lines starting with '#'", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-20260519-test";
      writeHandoffFile(cwd, runId, "handoff-1.md", {
        agent: "omre-reviewer-security",
        dimension: "security",
      });
      writeHandoffFile(cwd, runId, "handoff-2.md", {
        agent: "omre-reviewer-quality",
        dimension: "quality",
      });

      const mod = await loadFinalizeReview();
      const result = mod.finalizeReview({ runId, cwd });

      const latestMd = fs.readFileSync(
        path.join(cwd, ".omre", "reports", "latest.md"),
        "utf8"
      );
      expect(latestMd.startsWith("#")).toBe(true);
      const nonBlankLines = latestMd
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(nonBlankLines.length).toBeGreaterThanOrEqual(50);

      expect(result.handoffsConsumed).toBe(2);
      expect(result.written.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("emits a JSON report with slices[].findings[] structure", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-20260519-json";
      writeHandoffFile(cwd, runId, "handoff-1.md");

      const mod = await loadFinalizeReview();
      mod.finalizeReview({ runId, cwd });

      const latestJsonPath = path.join(
        cwd,
        ".omre",
        "reports",
        "latest.json"
      );
      expect(fs.existsSync(latestJsonPath)).toBe(true);
      const jsonContent = fs.readFileSync(latestJsonPath, "utf8");
      const parsed = JSON.parse(jsonContent);
      expect(Array.isArray(parsed.slices)).toBe(true);
      expect(parsed.slices.length).toBeGreaterThan(0);
      expect(Array.isArray(parsed.slices[0].findings)).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is deterministic — same handoffs produce byte-identical markdown and JSON", async () => {
    const cwd1 = createTempProject();
    const cwd2 = createTempProject();
    try {
      const runId = "run-deterministic";
      const overrides = {
        agent: "omre-reviewer-spec",
        dimension: "spec",
      };
      writeHandoffFile(cwd1, runId, "handoff-1.md", overrides);
      writeHandoffFile(cwd2, runId, "handoff-1.md", overrides);

      const mod = await loadFinalizeReview();
      mod.finalizeReview({ runId, cwd: cwd1 });
      mod.finalizeReview({ runId, cwd: cwd2 });

      const md1 = fs.readFileSync(
        path.join(cwd1, ".omre", "reports", "latest.md"),
        "utf8"
      );
      const md2 = fs.readFileSync(
        path.join(cwd2, ".omre", "reports", "latest.md"),
        "utf8"
      );
      expect(md1).toBe(md2);

      const json1 = fs.readFileSync(
        path.join(cwd1, ".omre", "reports", "latest.json"),
        "utf8"
      );
      const json2 = fs.readFileSync(
        path.join(cwd2, ".omre", "reports", "latest.json"),
        "utf8"
      );
      expect(json1).toBe(json2);
    } finally {
      fs.rmSync(cwd1, { recursive: true, force: true });
      fs.rmSync(cwd2, { recursive: true, force: true });
    }
  });

  it("surfaces degraded coverage when handoffs declare missing dimensions", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-degraded";
      writeHandoffFile(cwd, runId, "handoff-1.md", {
        agent: "omre-reviewer-performance",
        dimension: "performance",
        meta: {
          total_findings: 0,
          notes: "Degraded: missing dimensions concurrency, security",
        },
      });

      const mod = await loadFinalizeReview();
      const result = mod.finalizeReview({ runId, cwd });

      expect(result.degradedSlices.length).toBeGreaterThan(0);
      expect(result.missingDimensionsGlobal.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("throws when runId path resolves outside cwd (path traversal)", async () => {
    const cwd = createTempProject();
    try {
      const mod = await loadFinalizeReview();
      expect(() =>
        mod.finalizeReview({ runId: "../../etc/passwd", cwd })
      ).toThrow();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("throws when handoff dir is empty", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-empty";
      fs.mkdirSync(path.join(cwd, ".omre", "handoffs", runId), {
        recursive: true,
      });

      const mod = await loadFinalizeReview();
      expect(() => mod.finalizeReview({ runId, cwd })).toThrow();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("auto-indexes after writeReport succeeds and returns memoryIndexResult.success=true", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-auto-index-success";
      writeHandoffFile(cwd, runId, "handoff-1.md");
      let latestJsonExistedWhenIndexRan = false;

      const mod = await loadFinalizeReviewWithMemoryMocks({
        runIndexLatest: (options) => {
          expect(options).toEqual({ cwd });
          latestJsonExistedWhenIndexRan = fs.existsSync(path.join(cwd, ".omre", "reports", "latest.json"));
          return buildIndexLatestResult();
        },
      });

      const result = mod.finalizeReview({ runId, cwd });

      expect(latestJsonExistedWhenIndexRan).toBe(true);
      expect(mod.runIndexLatestMock).toHaveBeenCalledTimes(1);
      expect(mod.checkAutoCompactThresholdMock).toHaveBeenCalledTimes(1);
      expect(mod.checkAutoCompactThresholdMock).toHaveBeenCalledWith(cwd, expect.objectContaining({ enabled: true }));
      expect(result.memoryIndexResult).toEqual({ success: true });
      expect(result.written.some((filePath) => filePath.endsWith("latest.json"))).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps written reports when auto-indexing throws and returns memoryIndexResult.error", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-auto-index-failure";
      writeHandoffFile(cwd, runId, "handoff-1.md");
      const indexFailure = new Error("Memory event schema version mismatch: manifest has eventSchemaVersion 999");

      const mod = await loadFinalizeReviewWithMemoryMocks({
        runIndexLatest: () => {
          throw indexFailure;
        },
      });

      const result = mod.finalizeReview({ runId, cwd });
      const latestJsonPath = path.join(cwd, ".omre", "reports", "latest.json");

      expect(mod.runIndexLatestMock).toHaveBeenCalledTimes(1);
      expect(result.written.some((filePath) => filePath.endsWith("latest.json"))).toBe(true);
      expect(fs.existsSync(latestJsonPath)).toBe(true);
      expect(result.memoryIndexResult?.success).toBe(false);
      expect(result.memoryIndexResult?.error).toContain("eventSchemaVersion 999");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not call runIndexLatest when auto-index after review is disabled", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-auto-index-disabled";
      writeProjectConfig(cwd, {
        memory: {
          enabled: true,
          indexing: {
            autoIndexAfterReview: false,
          },
        },
      });
      writeHandoffFile(cwd, runId, "handoff-1.md");

      const mod = await loadFinalizeReviewWithMemoryMocks();

      const result = mod.finalizeReview({ runId, cwd });

      expect(mod.runIndexLatestMock).not.toHaveBeenCalled();
      expect(result.memoryIndexResult).toBeUndefined();
      expect(result.written.some((filePath) => filePath.endsWith("latest.json"))).toBe(true);
      expect(fs.existsSync(path.join(cwd, ".omre", "reports", "latest.json"))).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("logs a warning when auto-compact threshold is exceeded", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-auto-compact-warning";
      writeHandoffFile(cwd, runId, "handoff-1.md");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const mod = await loadFinalizeReviewWithMemoryMocks({
        checkAutoCompactThreshold: () => ({
          needsCompaction: true,
          reason: "segments=5 > minRawSegments=3",
        }),
      });

      const result = mod.finalizeReview({ runId, cwd });

      expect(mod.checkAutoCompactThresholdMock).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        "Review memory threshold exceeded (segments=5 > minRawSegments=3). Run `omre memory compact` to merge segments."
      );
      expect(result.written.some((filePath) => filePath.endsWith("latest.json"))).toBe(true);

      logSpy.mockRestore();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not log a warning when auto-compact threshold is not exceeded", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-auto-compact-no-warning";
      writeHandoffFile(cwd, runId, "handoff-1.md");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const mod = await loadFinalizeReviewWithMemoryMocks({
        checkAutoCompactThreshold: () => ({ needsCompaction: false }),
      });

      const result = mod.finalizeReview({ runId, cwd });

      expect(mod.checkAutoCompactThresholdMock).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Review memory threshold exceeded")
      );
      expect(result.written.some((filePath) => filePath.endsWith("latest.json"))).toBe(true);

      logSpy.mockRestore();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// RED tests — regression rendering across markdown marker, markdown section,
// and JSON aggregate surfaces. Fail until Tasks 2-4 implement the renderer.
// ---------------------------------------------------------------------------

describe("finalizeReview — regression rendering", () => {
  const REGRESSION_REASON =
    "Re-introduces the SQL injection previously fixed and recorded in memory";

  function buildRegressionFinding(
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      id: "sec-1",
      severity: "critical",
      file: "src/auth.ts",
      line: 42,
      title: "Hardcoded secret",
      description: "API key is hardcoded in source",
      evidence: "const API_KEY = 'sk-...'",
      confidence: "high",
      classification: "injection",
      isRegression: true,
      memoryRefs: ["mem_abc123"],
      regressionReason: REGRESSION_REASON,
      ...overrides,
    };
  }

  it("renders an inline historical-regression marker in markdown for a regression finding", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-reg-md-marker";
      writeHandoffFile(cwd, runId, "handoff-1.md", {
        findings: [buildRegressionFinding()],
      });

      const { finalizeReview } = await loadFinalizeReview();
      finalizeReview({ runId, cwd });

      const latestMd = fs.readFileSync(
        path.join(cwd, ".omre", "reports", "latest.md"),
        "utf8"
      );
      expect(latestMd).toContain("🔴 **Historical Regression**");
      expect(latestMd).toContain(REGRESSION_REASON);
      expect(latestMd).toContain("mem_abc123");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("renders a Historical Regressions markdown section ordered after Findings and before Summary", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-reg-md-section";
      writeHandoffFile(cwd, runId, "handoff-1.md", {
        findings: [buildRegressionFinding()],
      });

      const { finalizeReview } = await loadFinalizeReview();
      finalizeReview({ runId, cwd });

      const latestMd = fs.readFileSync(
        path.join(cwd, ".omre", "reports", "latest.md"),
        "utf8"
      );
      expect(latestMd).toContain("## Historical Regressions");
      expect(latestMd.indexOf("## Historical Regressions")).toBeLessThan(
        latestMd.indexOf("## Summary")
      );
      expect(latestMd.indexOf("## Findings")).toBeLessThan(
        latestMd.indexOf("## Historical Regressions")
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("omits all regression markdown when no findings are regressions", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-reg-md-zero";
      writeHandoffFile(cwd, runId, "handoff-1.md", {
        agent: "omre-reviewer-security",
        dimension: "security",
      });
      writeHandoffFile(cwd, runId, "handoff-2.md", {
        agent: "omre-reviewer-quality",
        dimension: "quality",
      });

      const { finalizeReview } = await loadFinalizeReview();
      finalizeReview({ runId, cwd });

      const latestMd = fs.readFileSync(
        path.join(cwd, ".omre", "reports", "latest.md"),
        "utf8"
      );
      expect(latestMd).not.toContain("## Historical Regressions");
      expect(latestMd).not.toContain("🔴");
      const nonBlankLines = latestMd
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(nonBlankLines.length).toBeGreaterThanOrEqual(50);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("emits a JSON regression aggregate with full slim key set for a regression finding", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-reg-json";
      writeHandoffFile(cwd, runId, "handoff-1.md", {
        findings: [buildRegressionFinding()],
      });

      const { finalizeReview } = await loadFinalizeReview();
      finalizeReview({ runId, cwd });

      const json = JSON.parse(
        fs.readFileSync(path.join(cwd, ".omre", "reports", "latest.json"), "utf8")
      );
      expect(json.summary.regression_count).toBe(1);
      expect(Array.isArray(json.regressions)).toBe(true);
      const reg = json.regressions[0];
      expect(reg.finding_id).toBe("sec-1");
      expect(typeof reg.slice_id).toBe("string");
      expect(typeof reg.title).toBe("string");
      expect(typeof reg.severity).toBe("string");
      expect(typeof reg.file).toBe("string");
      expect(["string", "number"]).toContain(typeof reg.line);
      expect(reg.memory_refs[0]).toBe("mem_abc123");
      expect(reg.regression_reason).toBe(REGRESSION_REASON);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("emits a zero-regression JSON aggregate when no findings are regressions", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-reg-json-zero";
      writeHandoffFile(cwd, runId, "handoff-1.md");

      const { finalizeReview } = await loadFinalizeReview();
      finalizeReview({ runId, cwd });

      const json = JSON.parse(
        fs.readFileSync(path.join(cwd, ".omre", "reports", "latest.json"), "utf8")
      );
      expect(json.summary.regression_count).toBe(0);
      expect(json.regressions).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("orders regressions deterministically by (slice_id, severityRank, id) and is byte-identical across runs", async () => {
    const cwd1 = createTempProject();
    const cwd2 = createTempProject();
    try {
      const runId = "run-reg-determinism";
      const seed = (cwd: string): void => {
        writeHandoffFile(cwd, runId, "handoff-slice2.md", {
          slice_id: "slice-2",
          findings: [
            buildRegressionFinding({
              id: "reg-b",
              severity: "low",
              memoryRefs: ["mem_b"],
            }),
          ],
        });
        writeHandoffFile(cwd, runId, "handoff-slice1.md", {
          slice_id: "slice-1",
          findings: [
            buildRegressionFinding({
              id: "reg-a",
              severity: "critical",
              memoryRefs: ["mem_a"],
            }),
          ],
        });
      };
      seed(cwd1);
      seed(cwd2);

      const { finalizeReview } = await loadFinalizeReview();
      finalizeReview({ runId, cwd: cwd1 });
      finalizeReview({ runId, cwd: cwd2 });

      const json1Str = fs.readFileSync(
        path.join(cwd1, ".omre", "reports", "latest.json"),
        "utf8"
      );
      const json2Str = fs.readFileSync(
        path.join(cwd2, ".omre", "reports", "latest.json"),
        "utf8"
      );
      const json1 = JSON.parse(json1Str);
      // slice-1 sorts before slice-2; reg-a (slice-1) precedes reg-b (slice-2).
      expect(
        json1.regressions.map((r: { finding_id: string }) => r.finding_id)
      ).toEqual(["reg-a", "reg-b"]);
      expect(json1Str).toBe(json2Str);
    } finally {
      fs.rmSync(cwd1, { recursive: true, force: true });
      fs.rmSync(cwd2, { recursive: true, force: true });
    }
  });

  it("treats a non-boolean isRegression value as not-a-regression (strict === true)", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-reg-nonboolean";
      writeHandoffFile(cwd, runId, "handoff-1.md", {
        findings: [buildRegressionFinding({ isRegression: "true" })],
      });

      const { finalizeReview } = await loadFinalizeReview();
      finalizeReview({ runId, cwd });

      const json = JSON.parse(
        fs.readFileSync(path.join(cwd, ".omre", "reports", "latest.json"), "utf8")
      );
      expect(json.summary.regression_count).toBe(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("renders a regression with an absent regressionReason as a stable null shape", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-reg-no-reason";
      const { regressionReason: _omit, ...finding } = buildRegressionFinding({ memoryRefs: ["mem_x"] });
      writeHandoffFile(cwd, runId, "handoff-1.md", {
        findings: [finding],
      });

      const { finalizeReview } = await loadFinalizeReview();
      finalizeReview({ runId, cwd });

      const latestMd = fs.readFileSync(
        path.join(cwd, ".omre", "reports", "latest.md"),
        "utf8"
      );
      expect(latestMd).toContain("🔴 **Historical Regression**");
      expect(latestMd).not.toContain("undefined");

      const json = JSON.parse(
        fs.readFileSync(path.join(cwd, ".omre", "reports", "latest.json"), "utf8")
      );
      expect(json.regressions.length).toBe(1);
      expect(json.regressions[0].regression_reason).toBeNull();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("renders a regression marker with empty memoryRefs without a dangling refs artifact", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-reg-empty-refs";
      writeHandoffFile(cwd, runId, "handoff-1.md", {
        findings: [buildRegressionFinding({ memoryRefs: [] })],
      });

      const { finalizeReview } = await loadFinalizeReview();
      finalizeReview({ runId, cwd });

      const latestMd = fs.readFileSync(
        path.join(cwd, ".omre", "reports", "latest.md"),
        "utf8"
      );
      expect(latestMd).toContain("🔴 **Historical Regression**");
      expect(latestMd).not.toContain("Memory refs: \n");
      expect(latestMd).not.toContain("()");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

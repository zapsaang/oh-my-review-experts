import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeReport, validateReportMarkdown, renderCoverageWarning } from "../../src/tools/report.js";
import { OmreConfig } from "../../src/config/schema.js";
import { DEFAULT_MEMORY_CONFIG } from "../../src/memory/config.js";

function createTestConfig(overrides: Partial<OmreConfig["report"]> = {}): OmreConfig {
  return {
    enabled: true,
    command: { name: "review-code", aliases: ["rc"], enabled: true, injection: "both", scopeResolution: "auto" },
    agents: {},
    slicing: { enabled: true, maxSlices: 4, skipDocsOnly: true, skipTestOnlyHeavyReview: true, forceWholeTargetAboveSlices: 12 },
    partialRerun: { enabled: true, maxRetriesPerTask: 1 },
    costGuardrail: { enabled: true, maxEstimatedTasks: 24, compactModeThreshold: 20, hardStopThreshold: 60 },
    arbitration: { hierarchicalThreshold: 3 },
    report: { enabled: true, directory: ".omre/reports", latestMarkdown: "latest.md", latestJson: "latest.json", timestamped: false, ...overrides },
    handoff: { enabled: true, directory: ".omre/handoffs" },
    reviewers: { default: ["spec", "quality"], bySliceType: { "business-module": [], "migration": [], "api-contract": [], "dependency-change": [], "infra-change": [], "shared-library": [], "test-only": [], "docs-only": [] } },
    memory: DEFAULT_MEMORY_CONFIG,
  };
}

function createValidReportMarkdown(): string {
  const lines: string[] = [];
  lines.push("# Review Results");
  lines.push("");
  lines.push("## Run");
  lines.push("");
  lines.push("- Target: current-change");
  lines.push("- Run ID: 20260519-141258-095");
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  lines.push("All dimensions reviewed.");
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  lines.push("No issues found.");
  lines.push("");
  lines.push("### Detail");
  lines.push("");
  for (let i = 0; i < 40; i++) {
    lines.push(`- Item ${i + 1}: reviewed.`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("Clean report.");
  return lines.join("\n");
}

describe("writeReport", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-report-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes latest.md and latest.json", () => {
    const config = createTestConfig({ directory: "reports" });
    const validMd = createValidReportMarkdown();
    const written = writeReport(config, { target: "test", markdown: validMd, json: { ok: true } }, tmpDir);
    expect(written).toHaveLength(2);
    expect(fs.readFileSync(path.join(tmpDir, "reports", "latest.md"), "utf8")).toBe(validMd);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "reports", "latest.json"), "utf8"))).toEqual({ ok: true });
  });

  it("blocks path traversal in report.directory", () => {
    const config = createTestConfig({ directory: "../../../etc" });
    expect(() =>
      writeReport(config, { target: "test", markdown: createValidReportMarkdown(), json: {} }, tmpDir)
    ).toThrow("Path traversal blocked");
  });

  it("writes timestamped history files when enabled", () => {
    const config = createTestConfig({ directory: "reports", timestamped: true });
    const validMd = createValidReportMarkdown();
    const written = writeReport(config, { target: "test", markdown: validMd, json: { ok: true } }, tmpDir);
    expect(written.length).toBeGreaterThan(2);
    const historyDir = path.join(tmpDir, "reports", "history");
    expect(fs.existsSync(historyDir)).toBe(true);
    const files = fs.readdirSync(historyDir);
    expect(files.some((f) => f.endsWith("-review.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("-review.json"))).toBe(true);
  });

  it("renders coverage warning when degraded slices present", () => {
    const config = createTestConfig({ directory: "reports" });
    const payload = {
      target: "test",
      markdown: createValidReportMarkdown(),
      json: { ok: true },
      degradedSlices: [{ slice_id: "slice-2", missing_dimensions: ["security"] }],
      missingDimensionsGlobal: ["security"],
    };
    writeReport(config, payload, tmpDir);
    const md = fs.readFileSync(path.join(tmpDir, "reports", "latest.md"), "utf8");
    expect(md.startsWith("## Coverage warning")).toBe(true);
    expect(md).toContain("slice-2");
    expect(md).toContain("security");
    expect(md).toContain("# Review Results");
  });

  it("renders coverage warning when only missingDimensionsGlobal present", () => {
    const config = createTestConfig({ directory: "reports" });
    const payload = {
      target: "test",
      markdown: createValidReportMarkdown(),
      json: { ok: true },
      degradedSlices: [],
      missingDimensionsGlobal: ["performance"],
    };
    writeReport(config, payload, tmpDir);
    const md = fs.readFileSync(path.join(tmpDir, "reports", "latest.md"), "utf8");
    expect(md.startsWith("## Coverage warning")).toBe(true);
    expect(md).toContain("performance");
    expect(md).toContain("# Review Results");
  });

  it("does not render coverage warning when no degraded coverage", () => {
    const config = createTestConfig({ directory: "reports" });
    const payload = {
      target: "test",
      markdown: createValidReportMarkdown(),
      json: { ok: true },
    };
    writeReport(config, payload, tmpDir);
    const md = fs.readFileSync(path.join(tmpDir, "reports", "latest.md"), "utf8");
    expect(md.startsWith("# Review Results")).toBe(true);
    expect(md).not.toContain("Coverage warning");
  });

  it("replaces 'No issues found' headline when coverage is degraded", () => {
    const config = createTestConfig({ directory: "reports" });
    const payload = {
      target: "test",
      markdown: createValidReportMarkdown(),
      json: { ok: true },
      degradedSlices: [{ slice_id: "slice-1", missing_dimensions: ["security"] }],
      missingDimensionsGlobal: ["security"],
    };
    writeReport(config, payload, tmpDir);
    const md = fs.readFileSync(path.join(tmpDir, "reports", "latest.md"), "utf8");
    expect(md).toContain("## Coverage warning");
    expect(md).toContain("No confirmed issues found in covered dimensions");
    expect(md).not.toContain("No issues found");
  });

  describe("[Fix 4] markdown validation", () => {
    it("accepts a real-shaped report (>= 50 lines, '#' heading)", () => {
      const config = createTestConfig({ directory: "reports" });
      const validMd = createValidReportMarkdown();
      expect(() => writeReport(config, { target: "test", markdown: validMd, json: {} }, tmpDir)).not.toThrow();
      const md = fs.readFileSync(path.join(tmpDir, "reports", "latest.md"), "utf8");
      expect(md.startsWith("#")).toBe(true);
    });

    it("coverage warning prepend still passes validation with a valid report payload", () => {
      const config = createTestConfig({ directory: "reports" });
      const payload = {
        target: "test",
        markdown: createValidReportMarkdown(),
        json: { ok: true },
        degradedSlices: [{ slice_id: "slice-1", missing_dimensions: ["security"] }],
        missingDimensionsGlobal: ["security"],
      };
      expect(() => writeReport(config, payload, tmpDir)).not.toThrow();
      const md = fs.readFileSync(path.join(tmpDir, "reports", "latest.md"), "utf8");
      expect(md.startsWith("## Coverage warning")).toBe(true);
    });

    it("rejects 'Report persisted to …' reference markdown", () => {
      const config = createTestConfig({ directory: "reports" });
      expect(() =>
        writeReport(config, { target: "test", markdown: "Report persisted to /foo/bar.md", json: {} }, tmpDir)
      ).toThrow(/reason=reference-only/);
    });

    it("rejects 'Saved to …' reference markdown", () => {
      const config = createTestConfig({ directory: "reports" });
      expect(() =>
        writeReport(config, { target: "test", markdown: "Saved to /foo/bar.md", json: {} }, tmpDir)
      ).toThrow(/reason=reference-only/);
    });

    it("rejects 'See file: …' reference markdown", () => {
      const config = createTestConfig({ directory: "reports" });
      expect(() =>
        writeReport(config, { target: "test", markdown: "See file: /foo/bar.md", json: {} }, tmpDir)
      ).toThrow(/reason=reference-only/);
    });

    it("rejects 'See report: …' reference markdown", () => {
      const config = createTestConfig({ directory: "reports" });
      expect(() =>
        writeReport(config, { target: "test", markdown: "See report: /foo/bar.md", json: {} }, tmpDir)
      ).toThrow(/reason=reference-only/);
    });

    it("rejects Chinese reference variant '报告已保存到 …'", () => {
      const config = createTestConfig({ directory: "reports" });
      expect(() =>
        writeReport(config, { target: "test", markdown: "报告已保存到 /foo/bar.md", json: {} }, tmpDir)
      ).toThrow(/reason=reference-only/);
    });

    it("rejects Chinese reference variant '报告写入至 …'", () => {
      const config = createTestConfig({ directory: "reports" });
      expect(() =>
        writeReport(config, { target: "test", markdown: "报告写入至 /foo/bar.md", json: {} }, tmpDir)
      ).toThrow(/reason=reference-only/);
    });

    it("rejects 'The full report is at …'", () => {
      const config = createTestConfig({ directory: "reports" });
      expect(() =>
        writeReport(config, { target: "test", markdown: "The full report is at /foo/bar.md", json: {} }, tmpDir)
      ).toThrow(/reason=reference-only/);
    });

    it("rejects 'The full report can be found at …'", () => {
      const config = createTestConfig({ directory: "reports" });
      expect(() =>
        writeReport(config, { target: "test", markdown: "The full report can be found at /foo/bar.md", json: {} }, tmpDir)
      ).toThrow(/reason=reference-only/);
    });

    it("rejects empty markdown", () => {
      const config = createTestConfig({ directory: "reports" });
      expect(() =>
        writeReport(config, { target: "test", markdown: "", json: {} }, tmpDir)
      ).toThrow(/reason=empty/);
    });

    it("rejects whitespace-only markdown", () => {
      const config = createTestConfig({ directory: "reports" });
      expect(() =>
        writeReport(config, { target: "test", markdown: "   \n\t\n   ", json: {} }, tmpDir)
      ).toThrow(/reason=empty/);
    });

    it("rejects markdown shorter than MIN_REPORT_LENGTH", () => {
      const config = createTestConfig({ directory: "reports" });
      expect(() =>
        writeReport(config, { target: "test", markdown: "# Short\n\nToo small.", json: {} }, tmpDir)
      ).toThrow(/reason=too-short/);
    });

    it("rejects markdown with fewer than MIN_REPORT_LINES non-blank lines", () => {
      const config = createTestConfig({ directory: "reports" });
      // Must be clearly > MIN_REPORT_LENGTH, start with '#', but < 5 non-blank lines
      const md = "# Report\n\n" + "x".repeat(500) + "\n\nend";
      expect(() =>
        writeReport(config, { target: "test", markdown: md, json: {} }, tmpDir)
      ).toThrow(/reason=too-few-lines/);
    });

    it("rejects markdown with no leading '#' heading", () => {
      const config = createTestConfig({ directory: "reports" });
      // Must be clearly > MIN_REPORT_LENGTH and >= 5 non-blank lines, but no leading '#'
      const md = "Review Results\n\n" + "line one with lots of padding text\n".repeat(20);
      expect(() =>
        writeReport(config, { target: "test", markdown: md, json: {} }, tmpDir)
      ).toThrow(/reason=no-heading/);
    });
  });

  describe("[Fix 5] runId/history propagation", () => {
    it("uses runId for history markdown filename when runId provided", () => {
      const config = createTestConfig({ directory: "reports", timestamped: true });
      const validMd = createValidReportMarkdown();
      const payload = {
        target: "test",
        markdown: validMd,
        json: { ok: true },
        runId: "run-fixed-id",
      };
      writeReport(config, payload, tmpDir);
      const historyDir = path.join(tmpDir, "reports", "history");
      const files = fs.readdirSync(historyDir);
      expect(files).toContain("run-fixed-id-review.md");
    });

    it("uses runId for history json filename when runId provided", () => {
      const config = createTestConfig({ directory: "reports", timestamped: true });
      const validMd = createValidReportMarkdown();
      const payload = {
        target: "test",
        markdown: validMd,
        json: { ok: true },
        runId: "run-fixed-id",
      };
      writeReport(config, payload, tmpDir);
      const historyDir = path.join(tmpDir, "reports", "history");
      const files = fs.readdirSync(historyDir);
      expect(files).toContain("run-fixed-id-review.json");
    });

    it("includes runId-named history files in written array when runId provided", () => {
      const config = createTestConfig({ directory: "reports", timestamped: true });
      const validMd = createValidReportMarkdown();
      const payload = {
        target: "test",
        markdown: validMd,
        json: { ok: true },
        runId: "run-fixed-id",
      };
      const written = writeReport(config, payload, tmpDir);
      expect(written.some((p) => p.endsWith("run-fixed-id-review.md"))).toBe(true);
      expect(written.some((p) => p.endsWith("run-fixed-id-review.json"))).toBe(true);
    });

    it("falls back to timestamp when runId is absent", () => {
      const config = createTestConfig({ directory: "reports", timestamped: true });
      const validMd = createValidReportMarkdown();
      writeReport(config, { target: "test", markdown: validMd, json: { ok: true } }, tmpDir);
      const historyDir = path.join(tmpDir, "reports", "history");
      const files = fs.readdirSync(historyDir);
      expect(files.some((f) => f.endsWith("-review.md"))).toBe(true);
      expect(files.some((f) => f.endsWith("-review.json"))).toBe(true);
    });

    it("history markdown content equals latest markdown content", () => {
      const config = createTestConfig({ directory: "reports", timestamped: true });
      const validMd = createValidReportMarkdown();
      writeReport(config, { target: "test", markdown: validMd, json: { ok: true } }, tmpDir);
      const latestMd = fs.readFileSync(path.join(tmpDir, "reports", "latest.md"), "utf8");
      const historyDir = path.join(tmpDir, "reports", "history");
      const mdFile = fs.readdirSync(historyDir).find((f) => f.endsWith("-review.md"));
      expect(mdFile).toBeDefined();
      const historyMd = fs.readFileSync(path.join(historyDir, mdFile!), "utf8");
      expect(historyMd).toBe(latestMd);
    });

    it("history json content equals latest json content", () => {
      const config = createTestConfig({ directory: "reports", timestamped: true });
      const validMd = createValidReportMarkdown();
      writeReport(config, { target: "test", markdown: validMd, json: { ok: true } }, tmpDir);
      const latestJson = JSON.parse(fs.readFileSync(path.join(tmpDir, "reports", "latest.json"), "utf8"));
      const historyDir = path.join(tmpDir, "reports", "history");
      const jsonFile = fs.readdirSync(historyDir).find((f) => f.endsWith("-review.json"));
      expect(jsonFile).toBeDefined();
      const historyJson = JSON.parse(fs.readFileSync(path.join(historyDir, jsonFile!), "utf8"));
      expect(historyJson).toEqual(latestJson);
    });
  });
});

describe("validateReportMarkdown direct tests", () => {
  it("returns ok: true for well-formed markdown >= 200 chars and >= 5 non-blank lines starting with #", () => {
    const md = [
      "# Review Report",
      "This is line one with enough content to contribute to the overall length requirement of two hundred characters.",
      "Line two also has sufficient text to ensure we meet the minimum length threshold for validation.",
      "Line three continues with more words to pad out the document properly.",
      "Line four is here as well with additional content for completeness.",
      "Line five brings us to the end with enough text to satisfy all constraints.",
    ].join("\n");
    const result = validateReportMarkdown(md);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns ok: false reason: empty for empty/whitespace input", () => {
    const result = validateReportMarkdown("   \n\n  ");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty");
  });

  it("returns ok: false reason: too-short when trimmed length < 200", () => {
    const result = validateReportMarkdown("# Title\nshort body");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too-short");
  });

  it("returns ok: false reason: too-few-lines when non-blank lines < 5", () => {
    const md = "# Title\n" + "x".repeat(200) + "\n\nend";
    const result = validateReportMarkdown(md);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too-few-lines");
  });

  it("returns ok: false reason: no-heading when first non-whitespace char is not #", () => {
    const md = "Title without hash\n" + "a".repeat(50) + "\n" + "b".repeat(50) + "\n" + "c".repeat(50) + "\n" + "d".repeat(50) + "\n" + "e".repeat(50);
    const result = validateReportMarkdown(md);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-heading");
  });

  it("returns ok: false reason: reference-only for short reference messages", () => {
    const result = validateReportMarkdown("Report persisted to /tmp/foo.md");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("reference-only");
  });
});

describe("renderCoverageWarning direct tests", () => {
  it("returns the warning header when both inputs are empty", () => {
    const result = renderCoverageWarning([], []);
    expect(result).toContain("## Coverage warning");
    expect(result).toContain("Coverage is degraded");
    expect(result).not.toContain("### Degraded slices");
    expect(result).not.toContain("### Missing dimensions globally");
  });

  it("includes Degraded slices section when degradedSlices is non-empty", () => {
    const result = renderCoverageWarning([{ slice_id: "s1", missing_dimensions: ["security"] }], []);
    expect(result).toContain("### Degraded slices");
    expect(result).toContain("s1");
    expect(result).toContain("security");
  });

  it("includes Missing dimensions globally section when missingDimensionsGlobal is non-empty", () => {
    const result = renderCoverageWarning([], ["spec", "concurrency"]);
    expect(result).toContain("### Missing dimensions globally");
    expect(result).toContain("spec");
    expect(result).toContain("concurrency");
  });

  it("includes both sections when both inputs are non-empty", () => {
    const result = renderCoverageWarning(
      [{ slice_id: "s1", missing_dimensions: ["security"] }],
      ["spec", "concurrency"]
    );
    expect(result).toContain("### Degraded slices");
    expect(result).toContain("### Missing dimensions globally");
    const degradedIndex = result.indexOf("### Degraded slices");
    const missingIndex = result.indexOf("### Missing dimensions globally");
    expect(degradedIndex).toBeLessThan(missingIndex);
    expect(result).toContain("s1");
    expect(result).toContain("security");
    expect(result).toContain("spec");
    expect(result).toContain("concurrency");
  });
});

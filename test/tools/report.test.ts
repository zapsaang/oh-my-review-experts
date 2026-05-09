import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeReport } from "../../src/tools/report.js";
import { OmreConfig } from "../../src/config/schema.js";

function createTestConfig(overrides: Partial<OmreConfig["report"]> = {}): OmreConfig {
  return {
    enabled: true,
    command: { name: "review-code", aliases: ["rc"], enabled: true, injection: "both" },
    models: {
      orchestrator: "test",
      spec: "test",
      quality: "test",
      security: "test",
      performance: "test",
      concurrency: "test",
      slicePlanner: "test",
      validator: "test",
      sliceArbiter: "test",
      globalArbiter: "test",
      reportWriter: "test",
    },
    slicing: { enabled: true, maxSlices: 4, skipDocsOnly: true, skipTestOnlyHeavyReview: true, forceWholeTargetAboveSlices: 12 },
    partialRerun: { enabled: true, maxRetriesPerTask: 1 },
    costGuardrail: { enabled: true, maxEstimatedTasks: 24, compactModeThreshold: 20, hardStopThreshold: 60 },
    report: {
      enabled: true,
      directory: ".omre/reports",
      latestMarkdown: "latest.md",
      latestJson: "latest.json",
      timestamped: false,
      ...overrides,
    },
    handoff: { enabled: true, directory: ".omre/handoffs" },
    reviewers: { default: ["spec", "quality"], bySliceType: {} },
  };
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
    const written = writeReport(config, { target: "test", markdown: "# Report", json: { ok: true } }, tmpDir);
    expect(written).toHaveLength(2);
    expect(fs.readFileSync(path.join(tmpDir, "reports", "latest.md"), "utf8")).toBe("# Report");
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "reports", "latest.json"), "utf8"))).toEqual({ ok: true });
  });

  it("blocks path traversal in report.directory", () => {
    const config = createTestConfig({ directory: "../../../etc" });
    expect(() => writeReport(config, { target: "test", markdown: "x", json: {} }, tmpDir)).toThrow("Path traversal blocked");
  });

  it("writes timestamped history files when enabled", () => {
    const config = createTestConfig({ directory: "reports", timestamped: true });
    const written = writeReport(config, { target: "test", markdown: "# Report", json: { ok: true } }, tmpDir);
    expect(written.length).toBeGreaterThan(2);
    const historyDir = path.join(tmpDir, "reports", "history");
    expect(fs.existsSync(historyDir)).toBe(true);
    const files = fs.readdirSync(historyDir);
    expect(files.some((f) => f.endsWith("-review.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("-review.json"))).toBe(true);
  });
});

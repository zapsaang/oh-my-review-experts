import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeHandoff, readHandoffs } from "../../src/tools/handoff.js";
import { OmreConfig } from "../../src/config/schema.js";

function createTestConfig(overrides: Partial<OmreConfig["handoff"]> = {}): OmreConfig {
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
    },
    handoff: {
      enabled: true,
      directory: ".omre/handoffs",
      ...overrides,
    },
    reviewers: { default: ["spec", "quality"], bySliceType: {} },
  };
}

describe("writeHandoff", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-handoff-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a handoff file with correct structure", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const filePath = writeHandoff(
      config,
      {
        agentName: "security-reviewer",
        scope: "auth-module",
        status: "completed",
        confidence: "high",
        filesInspected: ["src/auth.ts", "src/middleware.ts"],
        findings: [
          {
            severity: "high",
            category: "injection",
            file: "src/auth.ts",
            lines: "45-52",
            evidence: "User input concatenated directly into SQL query",
            impact: "Potential SQL injection allowing unauthorized data access",
            recommendation: "Use parameterized queries",
          },
        ],
        suggestedFixes: ["Replace string concatenation with prepared statements"],
        openQuestions: ["Is this endpoint publicly accessible?"],
        notesForPrimary: "Focus on the login endpoint first",
      },
      tmpDir,
    );

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toContain("handoffs/");
    expect(filePath).toContain("security-reviewer");
    expect(filePath).toContain("auth-module");

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("# Review Handoff");
    expect(content).toContain("Agent: security-reviewer");
    expect(content).toContain("Scope: auth-module");
    expect(content).toContain("Status: completed");
    expect(content).toContain("Confidence: high");
    expect(content).toContain("src/auth.ts");
    expect(content).toContain("Severity: high");
    expect(content).toContain("Use parameterized queries");
  });

  it("throws when handoff is disabled", () => {
    const config = createTestConfig({ enabled: false });
    expect(() =>
      writeHandoff(
        config,
        {
          agentName: "test",
          scope: "test",
          status: "completed",
          confidence: "high",
          filesInspected: [],
          findings: [],
        },
        tmpDir,
      ),
    ).toThrow("Handoff protocol is disabled");
  });

  it("blocks path traversal in handoff.directory", () => {
    const config = createTestConfig({ directory: "../../../etc" });
    expect(() =>
      writeHandoff(
        config,
        {
          agentName: "test",
          scope: "test",
          status: "completed",
          confidence: "high",
          filesInspected: [],
          findings: [],
        },
        tmpDir,
      ),
    ).toThrow("Path traversal blocked");
  });

  it("sanitizes agent and scope names in filename", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const filePath = writeHandoff(
      config,
      {
        agentName: "reviewer@security",
        scope: "auth/module",
        status: "completed",
        confidence: "medium",
        filesInspected: ["src/test.ts"],
        findings: [],
      },
      tmpDir,
    );

    const filename = path.basename(filePath);
    expect(filename).toContain("reviewer-security");
    expect(filename).toContain("auth-module");
    expect(filename).not.toContain("@");
    expect(filename).not.toContain("/");
  });

  it("supports runId for scoping handoffs", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const filePath = writeHandoff(
      config,
      {
        agentName: "security-reviewer",
        scope: "auth",
        status: "completed",
        confidence: "high",
        filesInspected: ["src/auth.ts"],
        findings: [],
      },
      tmpDir,
      "run-20260507-001",
    );

    expect(filePath).toContain("handoffs/run-20260507-001/");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("handles concurrent writes without collision", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const payload = {
      agentName: "test",
      scope: "test",
      status: "completed" as const,
      confidence: "high" as const,
      filesInspected: ["src/test.ts"],
      findings: [],
    };

    const filePath1 = writeHandoff(config, payload, tmpDir);
    const filePath2 = writeHandoff(config, payload, tmpDir);

    expect(filePath1).not.toBe(filePath2);
    expect(fs.existsSync(filePath1)).toBe(true);
    expect(fs.existsSync(filePath2)).toBe(true);
  });

  it("redacts secrets in handoff content", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const filePath = writeHandoff(
      config,
      {
        agentName: "security-reviewer",
        scope: "auth-module",
        status: "completed",
        confidence: "high",
        filesInspected: ["src/auth.ts"],
        findings: [
          {
            severity: "high",
            category: "secret-leak",
            file: "src/auth.ts",
            lines: "45",
            evidence: "API key found: AKIAIOSFODNN7EXAMPLE",
            impact: "AWS credentials exposed in source code",
            recommendation: "Rotate credentials and use environment variables",
          },
        ],
      },
      tmpDir,
    );

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(content).toContain("[REDACTED_AWS_ACCESS_KEY_ID]");
  });
});

describe("readHandoffs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-handoff-read-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads all handoff files from directory", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const handoffDir = path.join(tmpDir, "handoffs");
    fs.mkdirSync(handoffDir, { recursive: true });

    fs.writeFileSync(path.join(handoffDir, "20260507-120000-reviewer-1.md"), "# Handoff 1", "utf8");
    fs.writeFileSync(path.join(handoffDir, "20260507-120001-reviewer-2.md"), "# Handoff 2", "utf8");
    fs.writeFileSync(path.join(handoffDir, "ignore.txt"), "not a handoff", "utf8");

    const handoffs = readHandoffs(config, tmpDir);
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0].content).toBe("# Handoff 1");
    expect(handoffs[1].content).toBe("# Handoff 2");
  });

  it("returns empty array when directory does not exist", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const handoffs = readHandoffs(config, tmpDir);
    expect(handoffs).toEqual([]);
  });

  it("returns empty array when handoff is disabled", () => {
    const config = createTestConfig({ enabled: false });
    const handoffs = readHandoffs(config, tmpDir);
    expect(handoffs).toEqual([]);
  });

  it("reads handoffs scoped to runId", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const handoffDir = path.join(tmpDir, "handoffs", "run-001");
    fs.mkdirSync(handoffDir, { recursive: true });

    fs.writeFileSync(path.join(handoffDir, "20260507-120000-reviewer-1.md"), "# Handoff 1", "utf8");

    const otherRunDir = path.join(tmpDir, "handoffs", "run-002");
    fs.mkdirSync(otherRunDir, { recursive: true });
    fs.writeFileSync(path.join(otherRunDir, "20260507-120001-reviewer-2.md"), "# Handoff 2", "utf8");

    const handoffs = readHandoffs(config, tmpDir, "run-001");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].content).toBe("# Handoff 1");
  });

  it("skips symlinks when reading handoffs", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const handoffDir = path.join(tmpDir, "handoffs");
    fs.mkdirSync(handoffDir, { recursive: true });

    fs.writeFileSync(path.join(handoffDir, "real.md"), "# Real", "utf8");
    fs.symlinkSync(path.join(handoffDir, "real.md"), path.join(handoffDir, "link.md"));

    const handoffs = readHandoffs(config, tmpDir);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].content).toBe("# Real");
  });
});

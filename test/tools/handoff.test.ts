import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeHandoff, readHandoffs, parseHandoffJsonHeader } from "../../src/tools/handoff.js";
import { OmreConfig } from "../../src/config/schema.js";
import { DEFAULT_MEMORY_CONFIG } from "../../src/memory/config.js";

function createTestConfig(overrides: Partial<OmreConfig["handoff"]> = {}): OmreConfig {
  return {
    enabled: true,
    command: { name: "review-code", aliases: ["rc"], enabled: true, injection: "both", scopeResolution: "auto" },
    agents: {},
    slicing: { enabled: true, maxSlices: 4, skipDocsOnly: true, skipTestOnlyHeavyReview: true, forceWholeTargetAboveSlices: 12 },
    partialRerun: { enabled: true, maxRetriesPerTask: 1 },
    costGuardrail: { enabled: true, maxEstimatedTasks: 24, compactModeThreshold: 20, hardStopThreshold: 60 },
    arbitration: { hierarchicalThreshold: 3 },
    report: { enabled: true, directory: ".omre/reports", latestMarkdown: "latest.md", latestJson: "latest.json", timestamped: false },
    handoff: { enabled: true, directory: ".omre/handoffs", ...overrides },
    reviewers: { default: ["spec", "quality"], bySliceType: { "business-module": [], "migration": [], "api-contract": [], "dependency-change": [], "infra-change": [], "shared-library": [], "test-only": [], "docs-only": [] } },
    memory: DEFAULT_MEMORY_CONFIG,
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
      const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        scope: "auth-module",
        status: "completed",
        filesInspected: ["src/auth.ts", "src/middleware.ts"],
        findings: [
          {
            id: "sec-1",
            severity: "high",
            classification: "injection",
            file: "src/auth.ts",
            line: 45,
            title: "SQL Injection",
            description: "Potential SQL injection allowing unauthorized data access",
            evidence: "User input concatenated directly into SQL query",
            confidence: "high",
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
    expect(filePath).toContain("omre-reviewer-security");
    expect(filePath).toContain("auth-module");

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("# Review Handoff");
    expect(content).toContain("Agent: omre-reviewer-security");
    expect(content).toContain("Scope: auth-module");
    expect(content).toContain("Status: completed");
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
          agent: "test",
          dimension: "quality",
          status: "completed",
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
          agent: "test",
          dimension: "quality",
          status: "completed",
          filesInspected: [],
          findings: [],
        },
        tmpDir,
      ),
    ).toThrow("Path traversal blocked");
  });

  it("sanitizes agent and scope names in filename", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer@security",
        dimension: "security",
        scope: "auth/module",
        status: "completed",
        filesInspected: ["src/test.ts"],
        findings: [],
      },
      tmpDir,
    );

    const filename = path.basename(filePath);
    expect(filename).toContain("omre-reviewer-security");
    expect(filename).toContain("auth-module");
    expect(filename).not.toContain("@");
    expect(filename).not.toContain("/");
  });

  it("supports runId for scoping handoffs", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const { filePath } = writeHandoff(
      config,
      {
        agent: "security-reviewer",
        dimension: "security",
        scope: "auth",
        status: "completed",
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
      agent: "test",
      dimension: "quality",
      status: "completed" as const,
      filesInspected: ["src/test.ts"],
      findings: [],
    };

    const { filePath: filePath1 } = writeHandoff(config, payload, tmpDir);
    const { filePath: filePath2 } = writeHandoff(config, payload, tmpDir);

    expect(filePath1).not.toBe(filePath2);
    expect(fs.existsSync(filePath1)).toBe(true);
    expect(fs.existsSync(filePath2)).toBe(true);
  });

  it("redacts secrets in handoff content", () => {
    const config = createTestConfig({ directory: "handoffs" });
      const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        scope: "auth-module",
        status: "completed",
        filesInspected: ["src/auth.ts"],
        findings: [
          {
            id: "sec-1",
            severity: "high",
            classification: "secret-leak",
            file: "src/auth.ts",
            line: 45,
            title: "AWS key exposed",
            description: "AWS credentials exposed in source code",
            evidence: "API key found: AKIAIOSFODNN7EXAMPLE",
            confidence: "high",
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

  it("redacts secrets in finding.category, finding.impact, and finding.recommendation", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const ghToken = "ghp_abcdefghijklmnopqrstuvwxyz1234567890abcd";
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const apiKey = "sk-1234567890abcdef1234567890abcdef";
    const { filePath } = writeHandoff(
      config,
      {
        agent: "security-reviewer",
        dimension: "security",
        scope: "auth-module",
        status: "completed",
        findings: [
          {
            id: "sec-1",
            severity: "high",
            classification: "secret-leak",
            file: "src/auth.ts",
            line: 45,
            title: "Token leak",
            description: "Token in code",
            evidence: "see file",
            confidence: "high",
            category: `leak: ${ghToken}`,
            impact: `Compromised: ${awsKey}`,
            recommendation: `Rotate immediately: ${apiKey}`,
          },
        ],
      },
      tmpDir,
    );

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).not.toContain(ghToken);
    expect(content).not.toContain(awsKey);
    expect(content).not.toContain(apiKey);
  });

  it("redacts GitHub PAT in JSON header and preserves JSON validity", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890abcd";
      const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        scope: "auth-module",
        status: "completed",
        filesInspected: ["src/auth.ts"],
        findings: [
          {
            id: "sec-1",
            severity: "high",
            classification: "secret-leak",
            file: "src/auth.ts",
            line: 45,
            title: "GitHub token exposed",
            description: "Hardcoded GitHub PAT in source",
            evidence: `Found ${token}`,
            confidence: "high",
            recommendation: "Use GitHub App authentication",
          },
        ],
      },
      tmpDir,
    );

    const content = fs.readFileSync(filePath, "utf8");
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(content).not.toContain(token);
    expect(content).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts Bearer token in JSON header and preserves JSON validity", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const bearer = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
      const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        scope: "auth-module",
        status: "completed",
        filesInspected: ["src/auth.ts"],
        findings: [
          {
            id: "sec-1",
            severity: "high",
            classification: "secret-leak",
            file: "src/auth.ts",
            line: 45,
            title: "Bearer token exposed",
            description: "Hardcoded bearer token in source",
            evidence: `Authorization: ${bearer}`,
            confidence: "high",
            recommendation: "Use OAuth2 refresh tokens",
          },
        ],
      },
      tmpDir,
    );

    const content = fs.readFileSync(filePath, "utf8");
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(content).not.toContain(bearer);
    expect(content).toContain("[REDACTED_BEARER_TOKEN]");
  });

  it("redacts generic API key in JSON header and preserves JSON validity", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const apiKey = "api-key: abcdef1234567890abcdef1234567890";
      const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        scope: "auth-module",
        status: "completed",
        filesInspected: ["src/auth.ts"],
        findings: [
          {
            id: "sec-1",
            severity: "high",
            classification: "secret-leak",
            file: "src/auth.ts",
            line: 45,
            title: "API key exposed",
            description: "Hardcoded API key in source",
            evidence: `Found ${apiKey}`,
            confidence: "high",
            recommendation: "Move to environment variables",
          },
        ],
      },
      tmpDir,
    );

    const content = fs.readFileSync(filePath, "utf8");
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(content).not.toContain("abcdef1234567890abcdef1234567890");
    expect(content).toContain("[REDACTED_API_KEY]");
  });

  it("redacts password in JSON header and preserves JSON validity", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const password = "password: SuperSecret123!";
    const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        scope: "auth-module",
        status: "completed",
        filesInspected: ["src/auth.ts"],
        findings: [
          {
            id: "sec-1",
            severity: "high",
            classification: "secret-leak",
            file: "src/auth.ts",
            line: 45,
            title: "Hardcoded secret",
            description: `Secret value: ${password}`,
            evidence: `Found: ${password}`,
            confidence: "high",
          },
        ],
      },
      tmpDir,
    );

    const content = fs.readFileSync(filePath, "utf8");
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(content).not.toContain("SuperSecret123!");
    expect(content).toContain("[REDACTED_PASSWORD]");
  });

  it("redacts generic token in JSON header and preserves JSON validity", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const token = "token: abcdef1234567890abcdef1234567890";
      const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        scope: "auth-module",
        status: "completed",
        filesInspected: ["src/auth.ts"],
        findings: [
          {
            id: "sec-1",
            severity: "high",
            classification: "secret-leak",
            file: "src/auth.ts",
            line: 45,
            title: "Generic token exposed",
            description: "Hardcoded token in source",
            evidence: `Found ${token}`,
            confidence: "high",
            recommendation: "Use token rotation",
          },
        ],
      },
      tmpDir,
    );

    const content = fs.readFileSync(filePath, "utf8");
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(content).not.toContain("abcdef1234567890abcdef1234567890");
    expect(content).toContain("[REDACTED_TOKEN]");
  });

  it("redacts private key block in JSON header and preserves JSON validity", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const keyBlock = `-----BEGIN RSA PRIVATE KEY-----
MIIEpQIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgwMbRvI0MBZhpJ
-----END RSA PRIVATE KEY-----`;
      const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        scope: "auth-module",
        status: "completed",
        filesInspected: ["src/auth.ts"],
        findings: [
          {
            id: "sec-1",
            severity: "high",
            classification: "secret-leak",
            file: "src/auth.ts",
            line: 45,
            title: "Private key exposed",
            description: "Hardcoded private key in source",
            evidence: `Found key:\n${keyBlock}`,
            confidence: "high",
            recommendation: "Use a key management service",
          },
        ],
      },
      tmpDir,
    );

    const content = fs.readFileSync(filePath, "utf8");
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(content).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(content).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("truncates long scope names in filename", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const longScope = "aura-daemon-core-changes--collectors-memory-linux-rs--collectors-meta-rs";
      const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        scope: longScope,
        status: "completed",
        filesInspected: ["src/test.ts"],
        findings: [],
      },
      tmpDir,
    );

    const filename = path.basename(filePath);
    const scopePart = filename.replace(/^\d{8}-\d{6}-\d{3}-omre-reviewer-security-/, "").replace(/\.md$/, "");
    expect(scopePart.length).toBeLessThanOrEqual(35);
    expect(filename).toContain("omre-reviewer-security");
    expect(filename).not.toContain(longScope);
  });

  it("does not truncate scope at exactly 35 chars", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const exactScope = "a".repeat(35);
    const { filePath } = writeHandoff(
      config,
      {
        agent: "test",
        dimension: "quality",
        scope: exactScope,
        status: "completed",
        filesInspected: ["src/test.ts"],
        findings: [],
      },
      tmpDir,
    );

    const filename = path.basename(filePath);
    const scopePart = filename.replace(/^\d{8}-\d{6}-\d{3}-test-/, "").replace(/\.md$/, "");
    expect(scopePart).toBe(exactScope);
  });

  it("truncates scope at 36 chars to 35", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const overScope = "a".repeat(36);
    const { filePath } = writeHandoff(
      config,
      {
        agent: "test",
        dimension: "quality",
        scope: overScope,
        status: "completed",
        filesInspected: ["src/test.ts"],
        findings: [],
      },
      tmpDir,
    );

    const filename = path.basename(filePath);
    const scopePart = filename.replace(/^\d{8}-\d{6}-\d{3}-test-/, "").replace(/\.md$/, "");
    expect(scopePart.length).toBe(35);
    expect(scopePart).toBe("a".repeat(35));
  });

  it("falls back to dimension when scope is empty", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const result = writeHandoff(
      config,
      {
        agent: "omre-reviewer-spec",
        dimension: "spec",
        status: "completed",
        filesInspected: [],
        findings: [],
      },
      tmpDir,
      "run-001",
    );

    expect(typeof result).toBe("object");
    expect(typeof result.filePath).toBe("string");
    expect(typeof result.taskId).toBe("string");
    expect(result.taskId.length).toBeGreaterThan(0);
    expect(result.taskId).toContain("run-001");
    expect(result.taskId).toContain("omre-reviewer-spec");

    const content = fs.readFileSync(result.filePath, "utf8");
    const header = parseHandoffJsonHeader(content);
    expect(header.success).toBe(true);
    if (header.success) {
      expect((header.data as { task_id: string }).task_id).toBe(result.taskId);
    }
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

describe("writeHandoff round-trip", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-handoff-roundtrip-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("output starts with ```json fence", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        status: "completed",
        filesInspected: ["src/auth.ts"],
        findings: [],
      },
      tmpDir,
    );
    const content = fs.readFileSync(filePath, "utf8");
    expect(content.trimStart().startsWith("```json")).toBe(true);
  });

  it("parseHandoffJsonHeader returns success:true on writeHandoff output", () => {
    const config = createTestConfig({ directory: "handoffs" });
      const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-quality",
        dimension: "quality",
        status: "completed",
        filesInspected: ["src/index.ts"],
        findings: [],
      },
      tmpDir,
    );
    const content = fs.readFileSync(filePath, "utf8");
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
  });

  it("JSON header contains correct schema_version", () => {
    const config = createTestConfig({ directory: "handoffs" });
      const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-spec",
        dimension: "spec",
        status: "completed",
        filesInspected: [],
        findings: [],
      },
      tmpDir,
    );
    const content = fs.readFileSync(filePath, "utf8");
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.schema_version).toBe("1");
  });

  it("finding IDs round-trip through parseHandoffJsonHeader", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        status: "completed",
        filesInspected: ["src/auth.ts"],
        findings: [
          {
            id: "sec-1",
            severity: "high",
            file: "src/auth.ts",
            line: 42,
            title: "SQL Injection",
            description: "User input concatenated into SQL",
            evidence: "query = 'SELECT * FROM users WHERE id = ' + userId",
            confidence: "high",
            classification: "injection",
          },
          {
            id: "sec-2",
            severity: "medium",
            file: "src/auth.ts",
            line: 88,
            title: "Weak hashing",
            description: "MD5 used for password hashing",
            evidence: "md5(password)",
            confidence: "medium",
            classification: "cryptography",
          },
        ],
      },
      tmpDir,
    );
    const content = fs.readFileSync(filePath, "utf8");
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const findings = data.findings as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(2);
    expect(findings[0].id).toBe("sec-1");
    expect(findings[1].id).toBe("sec-2");
    expect(findings[0].severity).toBe("high");
  });

  it("preserves memory regression fields in the JSON header", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const secretToken = "token: abcdef1234567890abcdef1234567890";
    const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        status: "completed",
        filesInspected: ["src/auth.ts"],
        findings: [
          {
            id: "sec-1",
            severity: "high",
            file: "src/auth.ts",
            line: 42,
            title: "SQL Injection regression",
            description: "User input is concatenated into SQL again",
            evidence: "query = 'SELECT * FROM users WHERE id = ' + userId",
            confidence: "high",
            classification: "injection",
            memoryRefs: ["mem_auth_1", "mem_fixed_2"],
            isRegression: true,
            regressionReason: `Previously fixed pattern recurred with ${secretToken}`,
          },
        ],
      },
      tmpDir,
    );

    const content = fs.readFileSync(filePath, "utf8");
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const findings = data.findings as Array<Record<string, unknown>>;
    expect(findings[0].memoryRefs).toEqual(["mem_auth_1", "mem_fixed_2"]);
    expect(findings[0].isRegression).toBe(true);
    expect(findings[0].regressionReason).toContain("[REDACTED_TOKEN]");
    expect(findings[0].regressionReason).not.toContain("abcdef1234567890abcdef1234567890");
  });

  it("secret redaction does not corrupt JSON header validity", () => {
    const config = createTestConfig({ directory: "handoffs" });
    const simulatedSecret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const { filePath } = writeHandoff(
      config,
      {
        agent: "omre-reviewer-security",
        dimension: "security",
        status: "completed",
        filesInspected: ["src/auth.ts"],
        findings: [
          {
            id: "sec-1",
            severity: "high",
            file: "src/auth.ts",
            line: 10,
            title: "Hardcoded secret",
            description: `Secret value: ${simulatedSecret}`,
            evidence: `Found: ${simulatedSecret}`,
            confidence: "high",
            classification: "secret-leak",
          },
        ],
      },
      tmpDir,
    );
    const content = fs.readFileSync(filePath, "utf8");
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
  });
});

describe("parseHandoffJsonHeader BOM and CRLF", () => {
  it("strips UTF-8 BOM before parsing", () => {
    const json = JSON.stringify({ schema_version: "1", findings: [] });
    const content = `\uFEFF\`\`\`json\n${json}\n\`\`\`\n\n# Review Handoff\n`;
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    const data = result.data as Record<string, unknown>;
    expect(data.schema_version).toBe("1");
  });

  it("handles CRLF line endings in fence detection", () => {
    const json = JSON.stringify({ schema_version: "1", findings: [] });
    const content = `\`\`\`json\r\n${json}\r\n\`\`\`\r\n\r\n# Review Handoff\r\n`;
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    const data = result.data as Record<string, unknown>;
    expect(data.schema_version).toBe("1");
  });
});

describe("parseHandoffJsonHeader", () => {
  it("parses a valid JSON header", () => {
    const content = `
\`\`\`json
{
  "schema_version": "1",
  "task_id": "task-1",
  "agent": "omre-reviewer-security",
  "dimension": "security",
  "status": "completed",
  "target": { "kind": "working-tree", "value": "auth review" },
  "slice_id": "slice-1",
  "findings": [
    {
      "id": "sec-1",
      "severity": "high",
      "file": "src/auth.ts",
      "line": 42,
      "title": "SQL Injection",
      "description": "User input concatenated into SQL",
      "evidence": "Line 42: query = 'SELECT * FROM users WHERE id = ' + userId",
      "confidence": "high",
      "classification": "injection"
    }
  ],
  "meta": { "total_findings": 1, "notes": "" }
}
\`\`\`

# Review Handoff

## Metadata

- Agent: omre-reviewer-security
`;
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.data).toBeDefined();
    const data = result.data as Record<string, unknown>;
    expect(data.schema_version).toBe("1");
    expect(data.agent).toBe("omre-reviewer-security");
    expect(data.status).toBe("completed");
    expect(Array.isArray(data.findings)).toBe(true);
    expect(data.findings).toHaveLength(1);
  });

  it("returns error when JSON header is missing", () => {
    const content = "# Review Handoff\n\n## Metadata\n\n- Agent: omre-reviewer-security";
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toContain("JSON header missing");
  });

  it("returns error when JSON fence is unclosed", () => {
    const content = "```json\n{\"schema_version\": \"1\"";
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(false);
    expect(result.error).toContain("closing fence not found");
  });

  it("returns error when JSON content is empty", () => {
    const content = "```json\n\n```\n\n# Review Handoff";
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(false);
    expect(result.error).toContain("JSON header empty");
  });

  it("returns error when JSON is malformed", () => {
    const content = "```json\n{schema_version: 1}\n```\n\n# Review Handoff";
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(false);
    expect(result.error).toContain("JSON parse error");
  });

  it("parses JSON header with leading whitespace", () => {
    const content = "   \n\n```json\n{\"schema_version\": \"1\", \"findings\": []}\n```\n";
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    const data = result.data as Record<string, unknown>;
    expect(data.schema_version).toBe("1");
    expect(data.findings).toEqual([]);
  });

  it("returns success:true for valid JSON header with mismatched schema_version", () => {
    const content = `
\`\`\`json
{
  "schema_version": "999",
  "task_id": "task-1",
  "agent": "omre-reviewer-security",
  "dimension": "security",
  "status": "completed",
  "target": { "kind": "working-tree", "value": "auth review" },
  "slice_id": "slice-1",
  "findings": [],
  "meta": { "total_findings": 0, "notes": "" }
}
\`\`\`

# Review Handoff

## Metadata

- Agent: omre-reviewer-security
`;
    const result = parseHandoffJsonHeader(content);
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.data).not.toBeNull();
    const data = result.data as Record<string, unknown>;
    expect(data.schema_version).toBe("999");
  });
});

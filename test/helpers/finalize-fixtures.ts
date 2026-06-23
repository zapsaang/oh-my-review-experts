import fs from "node:fs";
import path from "node:path";

// process.cwd() base is required: loadConfig→assertSafeCwd rejects absolute paths outside cwd.
export function createTempProject(): string {
  const tmpDir = fs.mkdtempSync(path.join(process.cwd(), "omre-test-"));
  try {
    fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".omre", "handoffs"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".omre", "reports"), { recursive: true });
    writeProjectConfig(tmpDir);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
  return tmpDir;
}

export function writeProjectConfig(cwd: string, overrides: Record<string, unknown> = {}): void {
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

export function buildHandoffJsonHeader(
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

export function writeHandoffFile(
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

export function writeRunMetaFile(
  cwd: string,
  runId: string,
  meta: { withMemory: boolean; noMemory: boolean }
): void {
  const handoffDir = path.join(cwd, ".omre", "handoffs", runId);
  fs.mkdirSync(handoffDir, { recursive: true });
  fs.writeFileSync(
    path.join(handoffDir, ".run-meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8"
  );
}

export function buildRegressionFinding(
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
    regressionReason: "Re-introduces the SQL injection previously fixed and recorded in memory",
    ...overrides,
  };
}

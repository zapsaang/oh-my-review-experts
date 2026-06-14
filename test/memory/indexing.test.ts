import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runIndexLatest, type IndexLatestResult } from "../../src/memory/indexing.js";
import { readAllEventSegments } from "../../src/memory/events.js";
import { resolveMemoryPaths } from "../../src/memory/paths.js";
import { readMaterializedState } from "../../src/memory/store.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-memory-indexing-"));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(repoRoot: string, memory: Record<string, unknown>): void {
  const configDir = path.join(repoRoot, ".omre");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ memory }, null, 2), "utf8");
}

function writeLatestReport(repoRoot: string, runId = "20260530-120000-001"): void {
  fs.mkdirSync(path.join(repoRoot, ".omre", "reports"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, ".omre", "reports", "latest.json"),
    JSON.stringify({
      run_id: runId,
      status: "completed",
      slices: [
        {
          slice_id: "auth-module",
          findings: [reportFinding()],
        },
      ],
      summary: {
        total_slices: 1,
        total_findings: 1,
        handoffs_consumed: 1,
      },
      degraded_slices: [],
      missing_dimensions_global: [],
    }),
    "utf8",
  );
}

function writeHandoff(repoRoot: string, runId = "20260530-120000-001"): void {
  const handoffDir = path.join(repoRoot, ".omre", "handoffs", runId);
  fs.mkdirSync(handoffDir, { recursive: true });
  fs.writeFileSync(
    path.join(handoffDir, "security.md"),
    `\`\`\`json
{
  "schema_version": "1.0.0",
  "task_id": "${runId}-security",
  "agent": "omre-reviewer-security",
  "dimension": "security",
  "status": "completed",
  "target": { "kind": "working-tree", "value": "auth-module" },
  "slice_id": "auth-module",
  "findings": [
    {
      "id": "sec-handoff-1",
      "severity": "medium",
      "file": "src/middleware.ts",
      "line": "87-92",
      "title": "Missing rate limit on login endpoint",
      "description": "The login route does not enforce rate limiting.",
      "evidence": "router.post('/login', loginHandler)",
      "classification": "authz-gap",
      "category": "missing-control",
      "impact": "Attackers can submit unlimited login attempts.",
      "recommendation": "Add rate limiting middleware."
    }
  ],
  "meta": { "total_findings": 1 }
}
\`\`\`
`,
    "utf8",
  );
}

function reportFinding() {
  return {
    id: "sec-report-1",
    severity: "high",
    file: "src/auth.ts",
    line: 42,
    title: "Hardcoded JWT secret in source",
    description: "The JWT secret is embedded directly in source code.",
    evidence: "const SECRET = 'super-secret-key-123';",
    confidence: "high",
    classification: "injection",
    category: "secret-leak",
    impact: "A leaked secret can be used to forge tokens.",
    recommendation: "Move the secret to an environment variable.",
  };
}

function segmentFiles(repoRoot: string): string[] {
  const paths = resolveMemoryPaths(repoRoot);
  if (!fs.existsSync(paths.segmentsDir)) return [];
  return fs.readdirSync(paths.segmentsDir).filter((file) => file.endsWith(".jsonl"));
}

describe("memory indexing", () => {
  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports runIndexLatest and the IndexLatestResult contract from indexing.js", () => {
    const result: IndexLatestResult = {
      runId: "disabled",
      rawFindings: 0,
      normalizedFindings: 0,
      existingFindings: 0,
      eventsGenerated: 0,
      findingsDeduplicated: 0,
      dryRun: false,
    };

    expect(typeof runIndexLatest).toBe("function");
    expect(result.runId).toBe("disabled");
  });

  it("returns an empty disabled result without creating memory artifacts", () => {
    const repoRoot = makeTempRepo();
    writeConfig(repoRoot, { enabled: false });
    writeLatestReport(repoRoot);
    writeHandoff(repoRoot);
    process.chdir(repoRoot);
    const logs: string[] = [];

    const result = runIndexLatest({
      cwd: repoRoot,
      output: {
        log: (...values: unknown[]) => logs.push(values.join(" ")),
        error: () => {},
      },
    });

    const paths = resolveMemoryPaths(repoRoot);
    expect(result).toEqual({
      runId: "disabled",
      rawFindings: 0,
      normalizedFindings: 0,
      existingFindings: 0,
      eventsGenerated: 0,
      findingsDeduplicated: 0,
      dryRun: false,
    });
    expect(fs.existsSync(paths.root)).toBe(false);
    expect(logs.join("\n")).toContain("memory disabled");
  });

  it("generates events and writes a segment plus materialized state", () => {
    const repoRoot = makeTempRepo();
    const runId = "20260530-120000-001";
    writeLatestReport(repoRoot, runId);
    writeHandoff(repoRoot, runId);
    process.chdir(repoRoot);

    const result = runIndexLatest({
      cwd: repoRoot,
      output: {
        log: () => {},
        error: () => {},
      },
    });

    const paths = resolveMemoryPaths(repoRoot);
    expect(result.runId).toBe(runId);
    expect(result.rawFindings).toBe(2);
    expect(result.eventsGenerated).toBe(2);
    expect(result.segmentPath).toBeDefined();
    expect(result.materializedFindings).toBe(2);
    expect(segmentFiles(repoRoot)).toHaveLength(1);
    const { events } = readAllEventSegments(paths);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.type === "finding.discovered")).toBe(true);
    const state = readMaterializedState(paths);
    expect(state?.findings.map((finding) => finding.title).sort()).toEqual([
      "Hardcoded JWT secret in source",
      "Missing rate limit on login endpoint",
    ]);
    expect(fs.existsSync(paths.relatedIndexFile)).toBe(true);
    expect(fs.existsSync(paths.manifestFile)).toBe(true);
  });
});

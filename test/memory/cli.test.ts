import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { createCliProgram } from "../../src/cli.js";
import { registerMemoryCli, runIndexLatest } from "../../src/memory/cli.js";
import { readAllEventSegments } from "../../src/memory/events.js";
import { resolveMemoryPaths } from "../../src/memory/paths.js";
import { readMaterializedState } from "../../src/memory/store.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-memory-cli-"));
  tempDirs.push(dir);
  return dir;
}

function runIndexLatestCommand(args: string[] = []): void {
  const program = createCliProgram();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  program.parse(["node", "omre", "memory", "index-latest", ...args]);
}

function writeConfig(repoRoot: string, memory: Record<string, unknown>): void {
  const configDir = path.join(repoRoot, ".omre");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ memory }, null, 2), "utf8");
}

function writeLatestReport(repoRoot: string, runId = "20260530-120000-001", findings = [reportFinding()]): void {
  writeReportFile(path.join(repoRoot, ".omre", "reports", "latest.json"), runId, findings);
}

function writeReportFile(reportPath: string, runId = "20260530-120000-001", findings = [reportFinding()]): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      run_id: runId,
      status: "completed",
      slices: [
        {
          slice_id: "auth-module",
          findings,
        },
      ],
      summary: {
        total_slices: 1,
        total_findings: findings.length,
        handoffs_consumed: 1,
      },
      degraded_slices: [],
      missing_dimensions_global: [],
    }),
    "utf8",
  );
}

function writeHandoff(repoRoot: string, runId = "20260530-120000-001"): void {
  writeHandoffFile(path.join(repoRoot, ".omre", "handoffs", runId), runId);
}

function writeHandoffFile(handoffDir: string, runId = "20260530-120000-001"): void {
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

function segmentFiles(repoRoot: string, memoryDir?: string): string[] {
  const paths = resolveMemoryPaths(repoRoot, memoryDir);
  if (!fs.existsSync(paths.segmentsDir)) return [];
  return fs.readdirSync(paths.segmentsDir).filter((file) => file.endsWith(".jsonl"));
}

describe("memory index-latest CLI", () => {
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    vi.doUnmock("../../src/memory/extractor/index.js");
    vi.doUnmock("../../src/memory/dedupe.js");
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers the memory command on an existing Commander program", () => {
    const program = new Command();

    registerMemoryCli(program);

    const memory = program.commands.find((command) => command.name() === "memory");
    expect(memory).toBeDefined();
    expect(memory?.commands.map((command) => command.name())).toContain("index-latest");
  });

  it("runs the full pipeline in dry-run mode without writing events or materialized state", () => {
    const repoRoot = makeTempRepo();
    writeLatestReport(repoRoot);
    writeHandoff(repoRoot);
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    runIndexLatestCommand(["--dry-run"]);

    const paths = resolveMemoryPaths(repoRoot);
    expect(segmentFiles(repoRoot)).toEqual([]);
    expect(fs.existsSync(paths.root)).toBe(false);
    expect(fs.existsSync(paths.memoryFile)).toBe(false);
    expect(fs.existsSync(paths.manifestFile)).toBe(false);
    expect(readAllEventSegments(paths)).toEqual([]);
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("dry-run");
    expect(output).toContain("findings extracted: 2");
    expect(output).toContain("events generated: 2");
  });

  it("writes a valid event segment and updates materialized state in normal mode", () => {
    const repoRoot = makeTempRepo();
    const runId = "20260530-120000-001";
    writeLatestReport(repoRoot, runId);
    writeHandoff(repoRoot, runId);
    process.chdir(repoRoot);
    vi.spyOn(console, "log").mockImplementation(() => {});

    runIndexLatestCommand();

    const paths = resolveMemoryPaths(repoRoot);
    expect(segmentFiles(repoRoot)).toHaveLength(1);
    const events = readAllEventSegments(paths);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.type === "finding.discovered")).toBe(true);
    const state = readMaterializedState(paths);
    expect(state).not.toBeNull();
    expect(state?.findings).toHaveLength(2);
    expect(state?.findings.map((finding) => finding.title).sort()).toEqual([
      "Hardcoded JWT secret in source",
      "Missing rate limit on login endpoint",
    ]);
    expect(state?.findings.every((finding) => finding.origin.runId === runId)).toBe(true);
    const sourceTypesByTitle = Object.fromEntries(
      state?.findings.map((finding) => [finding.title, finding.origin.sourceType]) ?? [],
    );
    expect(sourceTypesByTitle).toEqual({
      "Hardcoded JWT secret in source": "report",
      "Missing rate limit on login endpoint": "import",
    });
    expect(fs.existsSync(paths.relatedIndexFile)).toBe(true);
    expect(fs.existsSync(paths.manifestFile)).toBe(true);
  });

  it("accepts custom report and handoff directory options", () => {
    const repoRoot = makeTempRepo();
    const runId = "20260530-120000-001";
    writeReportFile(path.join(repoRoot, "artifacts", "latest.json"), runId);
    writeHandoffFile(path.join(repoRoot, "artifacts", "handoffs"), runId);
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => runIndexLatestCommand([
      "--dry-run",
      "--report",
      "artifacts/latest.json",
      "--handoff-dir",
      "artifacts/handoffs",
    ])).not.toThrow();

    const paths = resolveMemoryPaths(repoRoot);
    expect(fs.existsSync(paths.root)).toBe(false);
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("findings extracted: 2");
  });

  it("returns early without creating memory directories when memory is disabled", () => {
    const repoRoot = makeTempRepo();
    writeConfig(repoRoot, { enabled: false });
    writeLatestReport(repoRoot);
    writeHandoff(repoRoot);
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = runIndexLatest();

    const paths = resolveMemoryPaths(repoRoot);
    expect(result.rawFindings).toBe(0);
    expect(result.eventsGenerated).toBe(0);
    expect(fs.existsSync(paths.root)).toBe(false);
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("memory disabled");
  });

  it("writes memory artifacts to the configured memory directory", () => {
    const repoRoot = makeTempRepo();
    writeConfig(repoRoot, { directory: ".custom-memory" });
    writeLatestReport(repoRoot);
    writeHandoff(repoRoot);
    process.chdir(repoRoot);
    vi.spyOn(console, "log").mockImplementation(() => {});

    runIndexLatestCommand();

    const defaultPaths = resolveMemoryPaths(repoRoot);
    const configuredPaths = resolveMemoryPaths(repoRoot, ".custom-memory");
    expect(fs.existsSync(defaultPaths.root)).toBe(false);
    expect(segmentFiles(repoRoot, ".custom-memory")).toHaveLength(1);
    expect(readMaterializedState(configuredPaths)?.findings).toHaveLength(2);
  });

  it("writes nothing when latest report and run handoffs contain no findings", () => {
    const repoRoot = makeTempRepo();
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    runIndexLatestCommand();

    const paths = resolveMemoryPaths(repoRoot);
    expect(segmentFiles(repoRoot)).toEqual([]);
    expect(readAllEventSegments(paths)).toEqual([]);
    expect(readMaterializedState(paths)).toBeNull();
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("findings extracted: 0");
    expect(output).toContain("events generated: 0");
  });

  it("rejects unsafe report run_id values before reading handoff paths", () => {
    const repoRoot = makeTempRepo();
    writeLatestReport(repoRoot, "../../../tmp/evil", [reportFinding()]);
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const paths = resolveMemoryPaths(repoRoot);

    expect(() => runIndexLatest({ output: { log: () => {}, error: () => {} } })).toThrow(
      "Invalid run id in latest report",
    );

    expect(segmentFiles(repoRoot)).toEqual([]);
    expect(fs.existsSync(paths.memoryFile)).toBe(false);
    expect(fs.existsSync(paths.manifestFile)).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("uses extractRawFindings and sorts generated events before writing", async () => {
    vi.resetModules();
    const repoRoot = makeTempRepo();
    const runId = "20260530-120000-001";
    writeLatestReport(repoRoot, runId, []);
    fs.mkdirSync(path.join(repoRoot, ".omre", "handoffs", runId), { recursive: true });
    process.chdir(repoRoot);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const laterEvent = {
      type: "finding.seen_again" as const,
      eventId: "evt_later",
      at: "2026-05-30T12:00:02.000Z",
      findingId: "mem_missing_later",
      runId,
      sourcePath: ".omre/reports/latest.json",
      matchedBy: "test",
    };
    const earlierEvent = {
      type: "finding.seen_again" as const,
      eventId: "evt_earlier",
      at: "2026-05-30T12:00:01.000Z",
      findingId: "mem_missing_earlier",
      runId,
      sourcePath: ".omre/reports/latest.json",
      matchedBy: "test",
    };
    const extractRawFindings = vi.fn(() => []);
    const deduplicateAndGenerateEvents = vi.fn(() => ({
      events: [laterEvent, earlierEvent],
      findings: [],
    }));
    vi.doMock("../../src/memory/extractor/index.js", () => ({ extractRawFindings }));
    vi.doMock("../../src/memory/dedupe.js", () => ({ deduplicateAndGenerateEvents }));
    const { runIndexLatest: runIndexLatestWithMocks } = await import("../../src/memory/cli.js");

    runIndexLatestWithMocks({ cwd: repoRoot });

    const reportPath = path.join(repoRoot, ".omre", "reports", "latest.json");
    const handoffDir = path.join(repoRoot, ".omre", "handoffs", runId);
    expect(extractRawFindings).toHaveBeenCalledWith({
      reportPath,
      handoffDir,
      sources: ["reports", "handoffs"],
    });
    const paths = resolveMemoryPaths(repoRoot);
    const [segmentFile] = segmentFiles(repoRoot);
    const writtenEvents = fs.readFileSync(path.join(paths.segmentsDir, segmentFile ?? ""), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { eventId: string });
    expect(writtenEvents.map((event) => event.eventId)).toEqual(["evt_earlier", "evt_later"]);
  });
});

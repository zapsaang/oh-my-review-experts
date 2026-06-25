import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { createCliProgram } from "../../src/cli.js";
import { registerMemoryCli, runIndexLatest } from "../../src/memory/cli.js";
import { readAllEventSegments } from "../../src/memory/events.js";
import { resolveMemoryPaths, type MemoryPaths } from "../../src/memory/paths.js";
import { readMaterializedState, writeMaterializedState, rebuildMaterializedStateFromEvents } from "../../src/memory/store.js";
import {
  makeTempRepo as makeTempMemoryRepo,
  seedManifest,
  writeFinding,
  writeSegment,
} from "./_helpers.js";

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

function writeMemoryManifest(repoRoot: string, eventSchemaVersion: number): void {
  const paths = resolveMemoryPaths(repoRoot);
  fs.mkdirSync(paths.materializedDir, { recursive: true });
  fs.writeFileSync(
    paths.manifestFile,
    JSON.stringify({
      schemaVersion: 1,
      eventSchemaVersion,
      viewSchemaVersion: 1,
      lastRebuiltAt: "2026-05-30T12:00:00.000Z",
      materializedHash: "0123456789abcdef",
      relatedIndexHash: "fedcba9876543210",
      includedEventFiles: [],
      compactedInputSegments: [],
      gcSummary: {
        deletedRawSegments: 0,
        deletedTmpFiles: 0,
        deletedQuarantineFiles: 0,
      },
      quarantine: [],
    }),
    "utf8",
  );
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
    expect(readAllEventSegments(paths)).toEqual({ events: [], skipped: 0 });
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
    const { events } = readAllEventSegments(paths);
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

    const result = runIndexLatest({ output: console });

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

  it("skips incompatible event lines during rebuild instead of failing fast", () => {
    const repoRoot = makeTempRepo();
    const runId = "20260530-120000-001";
    writeLatestReport(repoRoot, runId);
    writeHandoff(repoRoot, runId);
    const paths = resolveMemoryPaths(repoRoot);
    fs.mkdirSync(paths.segmentsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.segmentsDir, "future-schema.jsonl"), "{\"type\":\"future.event\"}\n", "utf8");
    process.chdir(repoRoot);
    const log = vi.fn();

    const result = runIndexLatest({ output: { log, error: () => {} } });

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("warning: skipped 1 corrupted event lines during rebuild");
    expect(result.materializedFindings).toBe(2);
    expect(readAllEventSegments(paths).skipped).toBe(1);
    expect(segmentFiles(repoRoot)).toContain("future-schema.jsonl");
  });

  it("rejects an incompatible manifest event schema before rebuilding from event segments", () => {
    const repoRoot = makeTempRepo();
    const runId = "20260530-120000-001";
    writeLatestReport(repoRoot, runId);
    writeHandoff(repoRoot, runId);
    writeMemoryManifest(repoRoot, 999);
    const paths = resolveMemoryPaths(repoRoot);
    fs.mkdirSync(paths.segmentsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.segmentsDir, "future-schema.jsonl"), "{\"type\":\"future.event\"}\n", "utf8");
    process.chdir(repoRoot);

    expect(() => runIndexLatest({ output: { log: () => {}, error: () => {} } })).toThrow(
      "Memory event schema version mismatch: manifest has eventSchemaVersion 999, but this CLI supports 1",
    );
    expect(segmentFiles(repoRoot)).toEqual(["future-schema.jsonl"]);
  });

  it("writes nothing when latest report and run handoffs contain no findings", () => {
    const repoRoot = makeTempRepo();
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    runIndexLatestCommand();

    const paths = resolveMemoryPaths(repoRoot);
    expect(segmentFiles(repoRoot)).toEqual([]);
    expect(readAllEventSegments(paths)).toEqual({ events: [], skipped: 0 });
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

  it("uses extractStructuredFindings and sorts generated events before writing", async () => {
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
    const extractStructuredFindings = vi.fn(() => ({ report: [], handoffs: [] }));
    const deduplicateAndGenerateEvents = vi.fn(() => ({
      events: [laterEvent, earlierEvent],
      findings: [],
    }));
    vi.doMock("../../src/memory/extractor/index.js", () => ({ extractStructuredFindings }));
    vi.doMock("../../src/memory/dedupe.js", () => ({ deduplicateAndGenerateEvents }));
    const { runIndexLatest: runIndexLatestWithMocks } = await import("../../src/memory/cli.js");

    runIndexLatestWithMocks({ cwd: repoRoot });

    const reportPath = path.join(repoRoot, ".omre", "reports", "latest.json");
    const handoffDir = path.join(repoRoot, ".omre", "handoffs", runId);
    expect(extractStructuredFindings).toHaveBeenCalledWith({
      reportPath,
      handoffDir,
      logger: expect.anything(),
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

describe("memory check CLI", () => {
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers the check subcommand", () => {
    const program = new Command();
    registerMemoryCli(program);
    const memory = program.commands.find((c) => c.name() === "memory");
    expect(memory?.commands.map((c) => c.name())).toContain("check");
  });

  it("shows help for memory check", () => {
    const program = createCliProgram();
    program.exitOverride();
    let out = "";
    program.configureOutput({
      writeOut: (str) => { out += str; },
      writeErr: () => {},
    });
    expect(() => program.parse(["node", "omre", "memory", "check", "--help"])).toThrow();
    expect(out).toContain("check");
    expect(out).toContain("Check memory store integrity");
  });

  it("runs check on empty repo without error", () => {
    const repoRoot = makeTempRepo();
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "check"]);

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Memory Check");
    expect(output).toContain("Version:");
    expect(output).toContain("Segments:");
  });

  it("check via CLI produces output on seeded state with segments", () => {
    const paths = makeTempMemoryRepo();
    const finding = writeFinding({ id: "mem_check123456789012" });
    const event = {
      type: "finding.discovered" as const,
      eventId: "evt_check000000000001",
      at: "2026-05-28T00:00:00.000Z",
      finding,
    };
    writeSegment(paths, [event], "run-check-1");
    writeSegment(paths, [event], "run-check-2");
    writeSegment(paths, [event], "run-check-3");
    writeSegment(paths, [event], "run-check-c", { kind: "compacted" });
    process.chdir(path.dirname(path.dirname(paths.root)));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "check"]);

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Segments:");
    expect(output).toContain("raw: 3");
    expect(output).toContain("compacted: 1");
    expect(output).toContain("Version:");
  });
});

describe("memory mark CLI", () => {
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers the mark subcommand", () => {
    const program = new Command();
    registerMemoryCli(program);
    const memory = program.commands.find((c) => c.name() === "memory");
    expect(memory?.commands.map((c) => c.name())).toContain("mark");
  });

  it("shows help for memory mark", () => {
    const program = createCliProgram();
    program.exitOverride();
    let out = "";
    program.configureOutput({
      writeOut: (str) => { out += str; },
      writeErr: () => {},
    });
    expect(() => program.parse(["node", "omre", "memory", "mark", "--help"])).toThrow();
    expect(out).toContain("mark");
    expect(out).toContain("Mark a memory finding with a new status");
  });

  it("marks a finding with a status change", () => {
    const paths = makeTempMemoryRepo();
    const finding = writeFinding({ id: "mem_test12345678901234", status: "open" });
    const state = seedManifest(paths);
    state.findings.push(finding);
    writeMaterializedState(paths, state);
    process.chdir(path.dirname(path.dirname(paths.root)));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "mark", "mem_test12345678901234", "--status", "confirmed"]);

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("marked mem_test12345678901234: open → confirmed");
  });

  it("invalid mark exits non-zero", () => {
    const paths = makeTempMemoryRepo();
    const finding = writeFinding({ id: "mem_markfail0000000001", status: "ignored" });
    const state = seedManifest(paths);
    state.findings.push(finding);
    writeMaterializedState(paths, state);
    process.chdir(path.dirname(path.dirname(paths.root)));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });

    expect(() =>
      program.parse(["node", "omre", "memory", "mark", "mem_markfail0000000001", "--status", "confirmed"]),
    ).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(errOutput).toContain("invalid transition: ignored → confirmed");
  });
});

describe("memory compact CLI", () => {
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers the compact subcommand", () => {
    const program = new Command();
    registerMemoryCli(program);
    const memory = program.commands.find((c) => c.name() === "memory");
    expect(memory?.commands.map((c) => c.name())).toContain("compact");
  });

  it("shows help for memory compact", () => {
    const program = createCliProgram();
    program.exitOverride();
    let out = "";
    program.configureOutput({
      writeOut: (str) => { out += str; },
      writeErr: () => {},
    });
    expect(() => program.parse(["node", "omre", "memory", "compact", "--help"])).toThrow();
    expect(out).toContain("compact");
    expect(out).toContain("Compact raw memory segments");
  });

  it("compacts empty repo gracefully", () => {
    const repoRoot = makeTempRepo();
    writeConfig(repoRoot, { enabled: true });
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "compact"]);

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("compacted 0 segments into 0 files");
  });

  it("compact --dry-run writes nothing", () => {
    const paths = makeTempMemoryRepo();
    seedManifest(paths);
    const event = {
      type: "finding.discovered" as const,
      eventId: "evt_compact0000000001",
      at: "2026-05-28T00:00:00.000Z",
      finding: writeFinding({ id: "mem_compact00000000001" }),
    };
    writeSegment(paths, [event], "run-compact-1");
    writeSegment(paths, [event], "run-compact-2");
    writeSegment(paths, [event], "run-compact-3");
    process.chdir(path.dirname(path.dirname(paths.root)));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const before = fs.readdirSync(paths.compactedDir);
    const manifestBefore = readMaterializedState(paths)?.manifest.compactedInputSegments;

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "compact", "--dry-run"]);

    expect(fs.readdirSync(paths.compactedDir)).toEqual(before);
    expect(fs.readdirSync(paths.compactedDir)).toEqual([]);
    expect(readMaterializedState(paths)?.manifest.compactedInputSegments).toEqual(manifestBefore);
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("compacted 3 segments into 1 files");
  });
});

describe("memory gc CLI", () => {
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers the gc subcommand", () => {
    const program = new Command();
    registerMemoryCli(program);
    const memory = program.commands.find((c) => c.name() === "memory");
    expect(memory?.commands.map((c) => c.name())).toContain("gc");
  });

  it("shows help for memory gc", () => {
    const program = createCliProgram();
    program.exitOverride();
    let out = "";
    program.configureOutput({
      writeOut: (str) => { out += str; },
      writeErr: () => {},
    });
    expect(() => program.parse(["node", "omre", "memory", "gc", "--help"])).toThrow();
    expect(out).toContain("gc");
    expect(out).toContain("Garbage collect memory store");
  });

  it("gc on empty repo gracefully", () => {
    const repoRoot = makeTempRepo();
    writeConfig(repoRoot, { enabled: true });
    fs.mkdirSync(path.join(repoRoot, ".omre", "memory", "gc"), { recursive: true });
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "gc"]);

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("deleted: tmp=0, empty=0, compacted-raw=0, overflow=0, quarantine=0");
    expect(output).toContain("gc summary updated");
  });

  it("gc --dry-run writes nothing", () => {
    const paths = makeTempMemoryRepo();
    seedManifest(paths);
    const tmpFile = path.join(paths.tmpDir, "stale.tmp");
    fs.writeFileSync(tmpFile, "stale", "utf8");
    const oldTime = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    fs.utimesSync(tmpFile, oldTime, oldTime);
    const emptySegment = path.join(paths.segmentsDir, "empty.jsonl");
    fs.writeFileSync(emptySegment, "", "utf8");
    process.chdir(path.dirname(path.dirname(paths.root)));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const tmpBefore = fs.readdirSync(paths.tmpDir);
    const segmentsBefore = fs.readdirSync(paths.segmentsDir);
    const gcBefore = fs.readdirSync(paths.gcDir);

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "gc", "--dry-run"]);

    expect(fs.readdirSync(paths.tmpDir)).toEqual(tmpBefore);
    expect(fs.readdirSync(paths.segmentsDir)).toEqual(segmentsBefore);
    expect(fs.readdirSync(paths.gcDir)).toEqual(gcBefore);
    expect(fs.existsSync(tmpFile)).toBe(true);
    expect(fs.existsSync(emptySegment)).toBe(true);
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("deleted: tmp=1, empty=1, compacted-raw=0, overflow=0, quarantine=0");
  });
});

describe("memory trends", () => {
  const tempPaths: MemoryPaths[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const paths of tempPaths.splice(0)) {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("registers the trends subcommand", () => {
    const program = new Command();

    registerMemoryCli(program);

    const memory = program.commands.find((command) => command.name() === "memory");
    expect(memory?.commands.map((command) => command.name())).toContain("trends");
  });

  it("shows help for memory trends including --at-bucket option", () => {
    const program = createCliProgram();
    program.exitOverride();
    let out = "";
    program.configureOutput({
      writeOut: (str) => { out += str; },
      writeErr: () => {},
    });
    expect(() => program.parse(["node", "omre", "memory", "trends", "--help"])).toThrow();
    expect(out).toContain("trends");
    expect(out).toContain("--at-bucket");
    expect(out).toContain("Snapshot trends up to this ISO timestamp");
  });

  it("prints the trends report from memory event segments", () => {
    const paths = makeTempMemoryRepo();
    const repoRoot = path.dirname(path.dirname(paths.root));
    const finding = writeFinding({
      id: "mem_trends0000000000",
      fingerprint: "fp_trends0000000000",
      contentHash: "ch_trends0000000000",
      title: "Auth login regression",
      locations: [{ path: "src/auth/login.ts", line: 12 }],
      origin: {
        runId: "run-trends-1",
        sourceType: "report",
        sourcePath: ".omre/reports/latest.json",
        createdAt: "2026-05-28T00:00:00.000Z",
      },
      occurrence: {
        firstSeenAt: "2026-05-28T00:00:00.000Z",
        lastSeenAt: "2026-05-28T00:00:00.000Z",
        count: 1,
        runIds: ["run-trends-1"],
      },
    });
    const discovered = {
      type: "finding.discovered" as const,
      eventId: "evt_trends000000001",
      at: "2026-05-28T00:00:00.000Z",
      finding,
    };
    const fixed = {
      type: "finding.status_changed" as const,
      eventId: "evt_trends000000002",
      at: "2026-05-29T00:00:00.000Z",
      findingId: finding.id,
      from: "open" as const,
      to: "fixed" as const,
      markedBy: "reviewer@example.com",
    };
    const regressed = {
      type: "finding.regressed" as const,
      eventId: "evt_trends000000003",
      at: "2026-05-30T00:00:00.000Z",
      findingId: finding.id,
      fromStatus: "fixed" as const,
      toStatus: "open" as const,
      runId: "run-trends-2",
    };
    writeSegment(paths, [discovered, fixed, regressed], "run-trends-2");
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "trends"]);

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("memory trends");
    expect(output).toContain("module distribution:");
    expect(output).toContain("auth: 1 (100.0%)");
    expect(output).toContain("recurring regressions:");
    expect(output).toContain("mem_trends0000000000 | Auth login regression | count=1");
    expect(output).toContain("fix survival time:");
    expect(output).toContain("fixed=2026-05-29T00:00:00.000Z | regressed=2026-05-30T00:00:00.000Z");
    expect(output).toContain("per-run timeline:");
    expect(output).toContain("run-trends-1 | introduced=1 | seenAgain=0 | statusChanged=1 | regressed=0 | totalActive=0");
    expect(output).toContain("run-trends-2 | introduced=0 | seenAgain=0 | statusChanged=0 | regressed=1 | totalActive=1");
  });

  it("accepts --at-bucket to limit trends to a specific timestamp", () => {
    const paths = makeTempMemoryRepo();
    const repoRoot = path.dirname(path.dirname(paths.root));
    const finding = writeFinding({
      id: "mem_trends0000000001",
      fingerprint: "fp_trends0000000001",
      contentHash: "ch_trends0000000001",
      title: "Auth login regression",
      locations: [{ path: "src/auth/login.ts", line: 12 }],
      origin: {
        runId: "run-trends-1",
        sourceType: "report",
        sourcePath: ".omre/reports/latest.json",
        createdAt: "2026-05-28T00:00:00.000Z",
      },
      occurrence: {
        firstSeenAt: "2026-05-28T00:00:00.000Z",
        lastSeenAt: "2026-05-28T00:00:00.000Z",
        count: 1,
        runIds: ["run-trends-1"],
      },
    });
    const discovered = {
      type: "finding.discovered" as const,
      eventId: "evt_trends000000004",
      at: "2026-05-28T00:00:00.000Z",
      finding,
    };
    const fixed = {
      type: "finding.status_changed" as const,
      eventId: "evt_trends000000005",
      at: "2026-05-29T00:00:00.000Z",
      findingId: finding.id,
      from: "open" as const,
      to: "fixed" as const,
      markedBy: "reviewer@example.com",
    };
    const regressed = {
      type: "finding.regressed" as const,
      eventId: "evt_trends000000006",
      at: "2026-05-30T00:00:00.000Z",
      findingId: finding.id,
      fromStatus: "fixed" as const,
      toStatus: "open" as const,
      runId: "run-trends-2",
    };
    writeSegment(paths, [discovered, fixed, regressed], "run-trends-2");
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "trends", "--at-bucket", "2026-05-29T12:00:00.000Z"]);

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("memory trends");
    expect(output).toContain("module distribution:");
    expect(output).toContain("auth: 1 (100.0%)");
    expect(output).toContain("per-run timeline:");
    expect(output).toContain("run-trends-1 | introduced=1 | seenAgain=0 | statusChanged=1 | regressed=0 | totalActive=0");
  });

  it("rejects invalid --at-bucket with a clear error", () => {
    const paths = makeTempMemoryRepo();
    tempPaths.push(paths);
    const repoRoot = path.dirname(path.dirname(paths.root));
    const finding = writeFinding({
      id: "mem_invalid000000001",
      fingerprint: "fp_invalid00000001",
      contentHash: "ch_invalid00000001",
      title: "Invalid atBucket test finding",
      locations: [{ path: "src/test.ts", line: 1 }],
      origin: {
        runId: "run-invalid",
        sourceType: "report",
        sourcePath: ".omre/reports/latest.json",
        createdAt: "2026-05-28T00:00:00.000Z",
      },
      occurrence: {
        firstSeenAt: "2026-05-28T00:00:00.000Z",
        lastSeenAt: "2026-05-28T00:00:00.000Z",
        count: 1,
        runIds: ["run-invalid"],
      },
    });
    const event = {
      type: "finding.discovered" as const,
      eventId: "evt_invalid000001",
      at: "2026-05-28T00:00:00.000Z",
      finding,
    };
    writeSegment(paths, [event], "run-invalid");
    process.chdir(repoRoot);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    expect(() => program.parse(["node", "omre", "memory", "trends", "--at-bucket", "not-a-date"])).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);

    const errorOutput = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(errorOutput).toContain("Invalid atBucket timestamp");
  });

  it("warns about skipped corrupted event lines when reading trends", () => {
    const paths = makeTempMemoryRepo();
    tempPaths.push(paths);
    const repoRoot = path.dirname(path.dirname(paths.root));
    const finding = writeFinding({
      id: "mem_skipped000000001",
      fingerprint: "fp_skipped000000001",
      contentHash: "ch_skipped000000001",
      title: "Skipped warning test",
      locations: [{ path: "src/test.ts", line: 1 }],
      origin: {
        runId: "run-skipped",
        sourceType: "report",
        sourcePath: ".omre/reports/latest.json",
        createdAt: "2026-05-28T00:00:00.000Z",
      },
      occurrence: {
        firstSeenAt: "2026-05-28T00:00:00.000Z",
        lastSeenAt: "2026-05-28T00:00:00.000Z",
        count: 1,
        runIds: ["run-skipped"],
      },
    });
    const event = {
      type: "finding.discovered" as const,
      eventId: "evt_skipped000001",
      at: "2026-05-28T00:00:00.000Z",
      finding,
    };
    writeSegment(paths, [event], "run-skipped");

    // Append a corrupted line to the segment file
    const segmentFiles = fs.readdirSync(paths.segmentsDir);
    const segmentFile = segmentFiles.find((f) => f.endsWith(".jsonl"));
    if (segmentFile) {
      fs.appendFileSync(path.join(paths.segmentsDir, segmentFile), "\n{not valid json\n", "utf8");
    }

    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "trends"]);

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("warning: skipped 1 corrupted event lines");
    expect(output).toContain("memory trends");
    expect(output).toContain("module distribution:");
  });
});

describe("memory CLI registration", () => {
  it("registers all 12 memory subcommands", () => {
    const program = new Command();
    registerMemoryCli(program);
    const memory = program.commands.find((c) => c.name() === "memory");
    expect(memory).toBeDefined();
    expect(memory?.commands).toHaveLength(12);
    const names = memory?.commands.map((c) => c.name());
    expect(names).toEqual(
      expect.arrayContaining([
        "index-latest",
        "search",
        "list",
        "show",
        "stats",
        "check",
        "mark",
        "compact",
        "gc",
        "suggestions",
        "apply-suggestions",
        "trends",
      ]),
    );
  });
});

describe("memory stats - regression count", () => {
  const tempPaths: MemoryPaths[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    tempDirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
    for (const paths of tempPaths.splice(0)) {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("counts fixed findings with multiple runIds as regression candidates", () => {
    const paths = makeTempMemoryRepo();
    tempPaths.push(paths);
    const state = seedManifest(paths);
    state.findings.push(
      writeFinding({
        id: "mem_reg0000000000fixed",
        status: "fixed",
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: "2026-05-28T00:00:00.000Z",
          count: 2,
          runIds: ["run-a", "run-b"],
        },
      }),
    );
    writeMaterializedState(paths, state);
    process.chdir(path.dirname(path.dirname(paths.root)));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "stats"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("regression candidates: 1");
  });

  it("excludes fixed findings seen in only one run", () => {
    const paths = makeTempMemoryRepo();
    tempPaths.push(paths);
    const state = seedManifest(paths);
    state.findings.push(
      writeFinding({
        id: "mem_fixedsingle00001",
        status: "fixed",
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: "2026-05-28T00:00:00.000Z",
          count: 1,
          runIds: ["run-a"],
        },
      }),
    );
    writeMaterializedState(paths, state);
    process.chdir(path.dirname(path.dirname(paths.root)));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "stats"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("regression candidates: 0");
  });

  it("excludes non-fixed findings seen in multiple runs", () => {
    const paths = makeTempMemoryRepo();
    tempPaths.push(paths);
    const state = seedManifest(paths);
    state.findings.push(
      writeFinding({
        id: "mem_opentworuns00001",
        status: "open",
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: "2026-05-28T00:00:00.000Z",
          count: 2,
          runIds: ["run-a", "run-b"],
        },
      }),
    );
    writeMaterializedState(paths, state);
    process.chdir(path.dirname(path.dirname(paths.root)));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "stats"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("regression candidates: 0");
  });

  it("shows 0 when there are no findings", () => {
    const paths = makeTempMemoryRepo();
    tempPaths.push(paths);
    const state = seedManifest(paths);
    writeMaterializedState(paths, state);
    process.chdir(path.dirname(path.dirname(paths.root)));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "stats"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("regression candidates: 0");
    expect(output).toContain("memory stats");
  });

  it("counts fixed findings via event reconstruction", () => {
    const paths = makeTempMemoryRepo();
    tempPaths.push(paths);

    // Build state through event segments rather than direct materialized mutation.
    const event1 = {
      type: "finding.discovered" as const,
      eventId: "evt_ev00000000000001",
      at: "2026-05-28T00:00:00.000Z",
      finding: writeFinding({
        id: "mem_ev00000000000000",
        status: "open",
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: "2026-05-28T00:00:00.000Z",
          count: 1,
          runIds: ["run-ev-1"],
        },
      }),
    };
    const event2 = {
      type: "finding.seen_again" as const,
      eventId: "evt_ev00000000000002",
      at: "2026-05-28T00:00:00.000Z",
      findingId: "mem_ev00000000000000",
      runId: "run-ev-2",
      sourcePath: "src/auth.ts",
      matchedBy: "hash",
    };
    writeSegment(paths, [event1], "run-ev-1");
    writeSegment(paths, [event2], "run-ev-2");

    // Rebuild materialized state from event segments to verify the pipeline path.
    const { events } = readAllEventSegments(paths);
    const state = rebuildMaterializedStateFromEvents(events);
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0].occurrence.runIds).toEqual(["run-ev-1", "run-ev-2"]);

    // Mark fixed and persist.
    state.findings[0].status = "fixed";
    writeMaterializedState(paths, state);

    process.chdir(path.dirname(path.dirname(paths.root)));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "stats"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("regression candidates: 1");
  });
});

describe("memory suggestions", () => {
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists a high-confidence (file-deleted) suggestion", () => {
    const paths = makeTempMemoryRepo();
    const finding = writeFinding({
      id: "mem_high000000000000",
      fingerprint: "fp_high000000000000",
      contentHash: "ch_high000000000000",
      locations: [{ path: "gone.ts", line: 1 }],
    });
    const state = seedManifest(paths);
    state.findings.push(finding);
    writeMaterializedState(paths, state);
    const repoRoot = path.dirname(path.dirname(paths.root));
    // Do NOT create gone.ts — triggers file-deleted confidence
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "suggestions"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("mem_high000000000000");
    expect(output).toContain("high");
    expect(output).toContain("file-deleted");
    expect(output).toContain(finding.title);
  });

  it("lists a medium-confidence (time-decay) suggestion", () => {
    const paths = makeTempMemoryRepo();
    const repoRoot = path.dirname(path.dirname(paths.root));
    fs.writeFileSync(path.join(repoRoot, "real.ts"), "x");
    const finding = writeFinding({
      id: "mem_med0000000000000",
      fingerprint: "fp_med0000000000000",
      contentHash: "ch_med0000000000000",
      locations: [{ path: "real.ts", line: 1 }],
      occurrence: {
        firstSeenAt: "2020-01-01T00:00:00.000Z",
        lastSeenAt: "2020-01-01T00:00:00.000Z",
        count: 1,
        runIds: ["run-old"],
      },
    });
    const state = seedManifest(paths);
    state.findings.push(finding);
    writeMaterializedState(paths, state);
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "suggestions"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("medium");
    expect(output).toContain("time-decay");
  });

  it("prints 'no suggestions' when no stale candidates", () => {
    const paths = makeTempMemoryRepo();
    const repoRoot = path.dirname(path.dirname(paths.root));
    fs.writeFileSync(path.join(repoRoot, "fresh.ts"), "x");
    const finding = writeFinding({
      id: "mem_fresh00000000000",
      fingerprint: "fp_fresh00000000000",
      contentHash: "ch_fresh00000000000",
      locations: [{ path: "fresh.ts", line: 1 }],
      occurrence: {
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        count: 1,
        runIds: ["run-fresh"],
      },
    });
    const state = seedManifest(paths);
    state.findings.push(finding);
    writeMaterializedState(paths, state);
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "suggestions"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("no suggestions");
  });

  it("prints 'suggestions disabled' when memory.suggestions.enabled === false", () => {
    const paths = makeTempMemoryRepo();
    const repoRoot = path.dirname(path.dirname(paths.root));
    const finding = writeFinding({
      id: "mem_disabled00000000",
      fingerprint: "fp_disabled00000000",
      contentHash: "ch_disabled00000000",
      locations: [{ path: "gone.ts", line: 1 }],
    });
    const state = seedManifest(paths);
    state.findings.push(finding);
    writeMaterializedState(paths, state);
    writeConfig(repoRoot, { enabled: true, suggestions: { enabled: false } });
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "suggestions"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("suggestions disabled");
    expect(output).not.toContain("mem_disabled00000000");
  });

  it("returns gracefully when loadMaterializedMemory yields null", () => {
    const repoRoot = makeTempRepo();
    writeConfig(repoRoot, { enabled: false });
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });

    expect(() => program.parse(["node", "omre", "memory", "suggestions"])).not.toThrow();

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("memory disabled");
  });
});

describe("memory apply-suggestions", () => {
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedHighAndMediumViaEvents(paths: MemoryPaths): string {
    const repoRoot = path.dirname(path.dirname(paths.root));
    fs.writeFileSync(path.join(repoRoot, "real.ts"), "x");

    const highFinding = writeFinding({
      id: "mem_high000000000000",
      fingerprint: "fp_high000000000000",
      contentHash: "ch_high000000000000",
      locations: [{ path: "gone.ts", line: 1 }],
      occurrence: {
        firstSeenAt: "2020-01-01T00:00:00.000Z",
        lastSeenAt: "2020-01-01T00:00:00.000Z",
        count: 1,
        runIds: ["run-old"],
      },
    });
    const medFinding = writeFinding({
      id: "mem_med0000000000000",
      fingerprint: "fp_med0000000000000",
      contentHash: "ch_med0000000000000",
      locations: [{ path: "real.ts", line: 1 }],
      occurrence: {
        firstSeenAt: "2020-01-01T00:00:00.000Z",
        lastSeenAt: "2020-01-01T00:00:00.000Z",
        count: 1,
        runIds: ["run-old"],
      },
    });

    const event1 = {
      type: "finding.discovered" as const,
      eventId: "evt_high000000000001",
      at: "2020-01-01T00:00:00.000Z",
      finding: highFinding,
    };
    const event2 = {
      type: "finding.discovered" as const,
      eventId: "evt_med0000000000001",
      at: "2020-01-01T00:00:00.000Z",
      finding: medFinding,
    };
    writeSegment(paths, [event1, event2], "run-seed");

    const { events } = readAllEventSegments(paths);
    const state = rebuildMaterializedStateFromEvents(events);
    writeMaterializedState(paths, state);

    return repoRoot;
  }

  it("--dry-run prints planned marks for high-confidence only and does NOT mutate state", () => {
    const paths = makeTempMemoryRepo();
    const repoRoot = seedHighAndMediumViaEvents(paths);
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "apply-suggestions", "--dry-run"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("mem_high000000000000");
    expect(output).not.toContain("mem_med0000000000000");

    const stateAfter = readMaterializedState(paths);
    const highAfter = stateAfter?.findings.find((f) => f.id === "mem_high000000000000");
    expect(highAfter?.status).toBe("open");
  });

  it("applies high-confidence only (real run)", () => {
    const paths = makeTempMemoryRepo();
    const repoRoot = seedHighAndMediumViaEvents(paths);
    process.chdir(repoRoot);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "apply-suggestions"]);

    const stateAfter = readMaterializedState(paths);
    const highAfter = stateAfter?.findings.find((f) => f.id === "mem_high000000000000");
    const medAfter = stateAfter?.findings.find((f) => f.id === "mem_med0000000000000");
    expect(highAfter?.status).toBe("stale");
    expect(medAfter?.status).toBe("open");
  });

  it("honors memory.suggestions.enabled === false", () => {
    const paths = makeTempMemoryRepo();
    const repoRoot = seedHighAndMediumViaEvents(paths);
    writeConfig(repoRoot, { enabled: true, suggestions: { enabled: false } });
    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "apply-suggestions"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("suggestions disabled");

    const stateAfter = readMaterializedState(paths);
    const highAfter = stateAfter?.findings.find((f) => f.id === "mem_high000000000000");
    expect(highAfter?.status).toBe("open");
  });

  it("prints 'nothing to apply' when there are zero high-confidence suggestions", () => {
    const paths = makeTempMemoryRepo();
    const repoRoot = path.dirname(path.dirname(paths.root));
    fs.writeFileSync(path.join(repoRoot, "real.ts"), "x");

    const medFinding = writeFinding({
      id: "mem_med0000000000000",
      fingerprint: "fp_med0000000000000",
      contentHash: "ch_med0000000000000",
      locations: [{ path: "real.ts", line: 1 }],
      occurrence: {
        firstSeenAt: "2020-01-01T00:00:00.000Z",
        lastSeenAt: "2020-01-01T00:00:00.000Z",
        count: 1,
        runIds: ["run-old"],
      },
    });
    const event = {
      type: "finding.discovered" as const,
      eventId: "evt_med0000000000001",
      at: "2020-01-01T00:00:00.000Z",
      finding: medFinding,
    };
    writeSegment(paths, [event], "run-seed-med");
    const { events } = readAllEventSegments(paths);
    const state = rebuildMaterializedStateFromEvents(events);
    writeMaterializedState(paths, state);

    process.chdir(repoRoot);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.parse(["node", "omre", "memory", "apply-suggestions"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("no high-confidence suggestions to apply");
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it("partial-failure exit code", async () => {
    vi.resetModules();

    const { makeTempRepo: makeTempMemoryRepoFresh, writeSegment: writeSegmentFresh, writeFinding: writeFindingFresh } = await import("./_helpers.js");
    const { readAllEventSegments: readAllEventSegmentsFresh } = await import("../../src/memory/events.js");
    const { rebuildMaterializedStateFromEvents: rebuildFresh, writeMaterializedState: writeFresh, readMaterializedState: readFresh } = await import("../../src/memory/store.js");

    const paths = makeTempMemoryRepoFresh();
    const repoRoot = path.dirname(path.dirname(paths.root));
    tempDirs.push(repoRoot);

    const high1 = writeFindingFresh({
      id: "mem_high000000000000",
      fingerprint: "fp_high000000000000",
      contentHash: "ch_high000000000000",
      locations: [{ path: "gone1.ts", line: 1 }],
      occurrence: {
        firstSeenAt: "2020-01-01T00:00:00.000Z",
        lastSeenAt: "2020-01-01T00:00:00.000Z",
        count: 1,
        runIds: ["run-old"],
      },
    });
    const high2 = writeFindingFresh({
      id: "mem_high000000000001",
      fingerprint: "fp_high000000000001",
      contentHash: "ch_high000000000001",
      locations: [{ path: "gone2.ts", line: 1 }],
      occurrence: {
        firstSeenAt: "2020-01-01T00:00:00.000Z",
        lastSeenAt: "2020-01-01T00:00:00.000Z",
        count: 1,
        runIds: ["run-old"],
      },
    });

    const event1 = {
      type: "finding.discovered" as const,
      eventId: "evt_high000000000001",
      at: "2020-01-01T00:00:00.000Z",
      finding: high1,
    };
    const event2 = {
      type: "finding.discovered" as const,
      eventId: "evt_high000000000002",
      at: "2020-01-01T00:00:00.000Z",
      finding: high2,
    };
    writeSegmentFresh(paths, [event1, event2], "run-seed-partial");
    const { events } = readAllEventSegmentsFresh(paths);
    const state = rebuildFresh(events);
    writeFresh(paths, state);

    vi.doMock("../../src/memory/mark.js", () => ({
      runMemoryMark: vi.fn((o: { findingId: string; status: string; reason?: string; cwd?: string }) => {
        if (o.findingId === "mem_high000000000001") {
          throw new Error("boom");
        }
        return {
          success: true,
          findingId: o.findingId,
          previousStatus: "open",
          newStatus: "stale",
          eventId: "evt_mock000000000001",
          segmentPath: "/mock/segment.jsonl",
        };
      }),
    }));

    const { createCliProgram: createCliProgramFresh } = await import("../../src/cli.js");

    process.chdir(repoRoot);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const program = createCliProgramFresh();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });

    try {
      program.parse(["node", "omre", "memory", "apply-suggestions"]);
    } catch {
      // exitOverride or the process.exit mock throws a sentinel error
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

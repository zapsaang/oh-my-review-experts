import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMemoryCli } from "../../src/memory/cli.js";
import { ensureMemoryDirs, resolveMemoryPaths } from "../../src/memory/paths.js";
import type { MemoryFinding } from "../../src/memory/schema.js";
import { writeMaterializedState } from "../../src/memory/store.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];
const timestamp = "2026-06-01T12:00:00.000Z";

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-memory-cli-search-"));
  tempDirs.push(dir);
  return dir;
}

function runMemoryCommand(args: string[]): string {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  registerMemoryCli(program);

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  program.parse(["node", "omre", "memory", ...args]);

  return logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

function writeMemoryState(repoRoot: string, findings = fixtureFindings()): void {
  const paths = resolveMemoryPaths(repoRoot);
  ensureMemoryDirs(paths);
  writeMaterializedState(paths, {
    findings,
    relatedIndex: {
      schemaVersion: 1,
      generatedAt: timestamp,
      relations: [],
      byFindingId: {},
    },
    manifest: {
      schemaVersion: 1,
      eventSchemaVersion: 1,
      viewSchemaVersion: 1,
      lastRebuiltAt: timestamp,
      materializedHash: "materializedhash1",
      relatedIndexHash: "relatedindexhash1",
      includedEventFiles: [],
      compactedInputSegments: [],
      gcSummary: {
        deletedRawSegments: 0,
        deletedTmpFiles: 0,
        deletedQuarantineFiles: 0,
      },
      quarantine: [],
    },
  });
}

function fixtureFindings(): MemoryFinding[] {
  return [
    finding({
      id: "mem_1111111111111111",
      reviewer: "security",
      severity: "high",
      status: "open",
      title: "Missing tenant isolation",
      problem: "Tenant records are queried without checking the caller tenant.",
      evidence: "db.query('select * from tenants')",
      searchable: { redactedText: "tenant isolation", tokens: ["tenant", "isolation"] },
      locations: [{ path: "src/tenants.ts", line: 42 }],
      occurrence: {
        firstSeenAt: timestamp,
        lastSeenAt: "2026-06-01T12:00:00.000Z",
        count: 2,
        runIds: ["run-1", "run-2"],
      },
    }),
    finding({
      id: "mem_2222222222222222",
      reviewer: "quality",
      severity: "medium",
      status: "confirmed",
      title: "Cache TTL drift",
      problem: "Cache entries use inconsistent TTL values across modules.",
      evidence: "ttl = 300 in one module and ttl = 30 in another",
      searchable: { redactedText: "cache ttl drift", tokens: ["cache", "ttl", "drift"] },
      locations: [{ path: "src/cache.ts", line: 12 }],
      occurrence: {
        firstSeenAt: timestamp,
        lastSeenAt: "2026-06-02T12:00:00.000Z",
        count: 1,
        runIds: ["run-2"],
      },
    }),
    finding({
      id: "mem_3333333333333333",
      reviewer: "omre-reviewer-security",
      severity: "low",
      status: "fixed",
      title: "Tenant isolation regression candidate",
      problem: "A previously fixed tenant isolation gap may have returned.",
      evidence: "tenantId is not passed to the repository method",
      searchable: { redactedText: "tenant isolation", tokens: ["tenant", "isolation"] },
      locations: [{ path: "src/repository.ts", line: 7 }],
      occurrence: {
        firstSeenAt: timestamp,
        lastSeenAt: "2026-06-03T12:00:00.000Z",
        count: 1,
        runIds: ["run-3"],
      },
    }),
  ];
}

function finding(overrides: Partial<MemoryFinding>): MemoryFinding {
  const base = {
    schemaVersion: 1,
    id: "mem_0000000000000000",
    fingerprint: "fingerprintvalue1",
    repo: {
      rootHash: "repo1234567890abcd",
      packagePath: ".",
    },
    origin: {
      runId: "run-1",
      sourceType: "report",
      sourcePath: ".omre/reports/latest.json",
      createdAt: timestamp,
    },
    reviewer: "security",
    severity: "high",
    status: "open",
    category: "authz",
    title: "Example finding",
    problem: "Example problem.",
    evidence: "Example evidence.",
    locations: [{ path: "src/example.ts", line: 1 }],
    occurrence: {
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      count: 1,
      runIds: ["run-1"],
    },
    searchable: {
      redactedText: "example",
      tokens: ["example"],
    },
    metadata: {
      evidenceTruncated: false,
      problemTruncated: false,
      recommendationTruncated: false,
      sourceMalformed: false,
    },
    tags: [],
    contentHash: "contenthashvalue1",
  } satisfies MemoryFinding;

  return { ...base, ...overrides };
}

describe("memory search/list/show/stats CLI", () => {
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers all read-only memory query commands", () => {
    const program = new Command();

    registerMemoryCli(program);

    const memory = program.commands.find((command) => command.name() === "memory");
    expect(memory?.commands.map((command) => command.name()).sort()).toEqual([
      "index-latest",
      "list",
      "search",
      "show",
      "stats",
    ]);
  });

  it("searches materialized memory with ranking and stable plain text fields", () => {
    const repoRoot = makeTempRepo();
    writeMemoryState(repoRoot);
    process.chdir(repoRoot);

    const output = runMemoryCommand(["search", "tenant isolation"]);

    expect(output).toContain("memory search: tenant isolation");
    expect(output).toContain("matches: 2");
    expect(output).toContain("1. mem_3333333333333333 | Tenant isolation regression candidate | reviewer=security | status=fixed | score=1.000");
    expect(output).toContain("2. mem_1111111111111111 | Missing tenant isolation | reviewer=security | status=open | score=1.000");
  });

  it("lists materialized findings with status, reviewer alias, and limit filters", () => {
    const repoRoot = makeTempRepo();
    writeMemoryState(repoRoot);
    process.chdir(repoRoot);

    const output = runMemoryCommand(["list", "--status", "fixed", "--reviewer", "security", "--limit", "1"]);

    expect(output).toContain("memory list");
    expect(output).toContain("findings: 1");
    expect(output).toContain("- mem_3333333333333333 | Tenant isolation regression candidate | reviewer=security | status=fixed | severity=low");
    expect(output).not.toContain("mem_1111111111111111");
  });

  it("shows a single finding summary and exits cleanly when an id is missing", () => {
    const repoRoot = makeTempRepo();
    writeMemoryState(repoRoot);
    process.chdir(repoRoot);

    const output = runMemoryCommand(["show", "mem_1111111111111111"]);
    const missingOutput = runMemoryCommand(["show", "mem_9999999999999999"]);

    expect(output).toContain("memory show: mem_1111111111111111");
    expect(output).toContain("title: Missing tenant isolation");
    expect(output).toContain("reviewer: security");
    expect(output).toContain("status: open");
    expect(output).toContain("problem: Tenant records are queried without checking the caller tenant.");
    expect(output).toContain("evidence: db.query('select * from tenants')");
    expect(missingOutput).toContain("memory finding not found: mem_9999999999999999");
  });

  it("prints aggregate status and canonical reviewer counts", () => {
    const repoRoot = makeTempRepo();
    writeMemoryState(repoRoot);
    process.chdir(repoRoot);

    const output = runMemoryCommand(["stats"]);

    expect(output).toContain("memory stats");
    expect(output).toContain("total findings: 3");
    expect(output).toContain("by status:");
    expect(output).toContain("  open: 1");
    expect(output).toContain("  confirmed: 1");
    expect(output).toContain("  fixed: 1");
    expect(output).toContain("by reviewer:");
    expect(output).toContain("  quality: 1");
    expect(output).toContain("  security: 2");
  });

  it("prints a friendly no-state message for read-only commands", () => {
    const repoRoot = makeTempRepo();
    process.chdir(repoRoot);

    expect(runMemoryCommand(["search", "tenant"])).toContain("no memory state found");
    expect(runMemoryCommand(["list"])).toContain("no memory state found");
    expect(runMemoryCommand(["show", "mem_1111111111111111"])).toContain("no memory state found");
    expect(runMemoryCommand(["stats"])).toContain("no memory state found");
  });
});

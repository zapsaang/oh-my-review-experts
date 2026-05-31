import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runIndexLatest } from "../../src/memory/cli.js";
import { readAllEventSegments } from "../../src/memory/events.js";
import { resolveMemoryPaths } from "../../src/memory/paths.js";
import { MemoryEventSchema, MemoryFindingSchema, MemoryManifestSchema, RelatedIndexSchema } from "../../src/memory/schema.js";
import { readMaterializedState } from "../../src/memory/store.js";

const originalCwd = process.cwd();
const fixturesDir = path.join(originalCwd, "test", "memory", "fixtures");
const latestFixturePath = path.join(fixturesDir, "latest.json");
const handoffFixturePath = path.join(fixturesDir, "handoff-sample.md");
const tempDirs: string[] = [];
const silentOutput = {
  log: () => undefined,
  error: () => undefined,
};

interface ReportFixtureFinding {
  id: string;
  severity: string;
  file: string;
  line: number | string;
  title: string;
  description: string;
  evidence?: string;
  confidence: string;
  classification: string;
  category?: string;
  impact?: string;
  recommendation?: string;
}

interface LatestFixtureReport {
  run_id?: string;
  slices?: Array<{
    findings?: ReportFixtureFinding[];
    [key: string]: unknown;
  }>;
  summary?: {
    total_findings?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-memory-integration-"));
  tempDirs.push(dir);
  return dir;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function copyTask4Fixtures(repoRoot: string, extraReportFindings: ReportFixtureFinding[] = []): string {
  const reportDir = path.join(repoRoot, ".omre", "reports");
  fs.mkdirSync(reportDir, { recursive: true });

  const reportPath = path.join(reportDir, "latest.json");
  fs.copyFileSync(latestFixturePath, reportPath);

  const latestReport = readJsonFile<LatestFixtureReport>(reportPath);
  const runId = latestReport.run_id;
  if (!runId) {
    throw new Error("Task 4 latest.json fixture must include run_id");
  }

  if (extraReportFindings.length > 0) {
    const targetSlice = latestReport.slices?.[0];
    if (!targetSlice?.findings) {
      throw new Error("Task 4 latest.json fixture must include at least one findings slice");
    }

    targetSlice.findings.push(...extraReportFindings);
    if (typeof latestReport.summary?.total_findings === "number") {
      latestReport.summary.total_findings += extraReportFindings.length;
    }
    fs.writeFileSync(reportPath, `${JSON.stringify(latestReport, null, 2)}\n`, "utf8");
  }

  const handoffDir = path.join(repoRoot, ".omre", "handoffs", runId);
  fs.mkdirSync(handoffDir, { recursive: true });
  fs.copyFileSync(handoffFixturePath, path.join(handoffDir, "handoff-sample.md"));

  return runId;
}

function relatedReportFinding(overrides: Partial<ReportFixtureFinding> = {}): ReportFixtureFinding {
  return {
    id: "related-tenant-validation-1",
    severity: "medium",
    file: "src/api/users.ts",
    line: 34,
    title: "Missing tenant validation before database query",
    description: "The handler omits tenant validation before executing the database query.",
    evidence: "return db.query('select * from users where id = $1', [userId]);",
    confidence: "high",
    classification: "validation-gap",
    category: "validation-gap",
    impact: "Cross-tenant data can be queried without a tenant guard.",
    recommendation: "Validate tenant ownership before executing the query.",
    ...overrides,
  };
}

function runIndexLatestInRepo(repoRoot: string) {
  process.chdir(repoRoot);
  return runIndexLatest({ cwd: repoRoot, output: silentOutput });
}

function readSegmentEvents(segmentPath: string) {
  return fs.readFileSync(segmentPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => MemoryEventSchema.parse(JSON.parse(line)));
}

function expectSchemaValidDiskState(repoRoot: string, expectedFindings: number, expectedEvents: number) {
  const paths = resolveMemoryPaths(repoRoot);
  const { events } = readAllEventSegments(paths);
  const state = readMaterializedState(paths);

  expect(events).toHaveLength(expectedEvents);
  for (const event of events) {
    expect(MemoryEventSchema.safeParse(event).success).toBe(true);
  }

  expect(state).not.toBeNull();
  expect(state?.findings).toHaveLength(expectedFindings);
  for (const finding of state?.findings ?? []) {
    expect(MemoryFindingSchema.safeParse(finding).success).toBe(true);
  }
  expect(fs.existsSync(paths.manifestFile)).toBe(true);
  expect(fs.existsSync(paths.memoryFile)).toBe(true);
  expect(fs.existsSync(paths.relatedIndexFile)).toBe(true);

  const manifestParse = MemoryManifestSchema.safeParse(readJsonFile<unknown>(paths.manifestFile));
  expect(manifestParse.success).toBe(true);

  return { paths, events, state };
}

describe("memory index-latest integration pipeline", () => {
  afterEach(() => {
    process.chdir(originalCwd);
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs Task 4 fixture findings through extraction, redaction, normalization, event write, rebuild, manifest write, and related indexing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00.000Z"));
    const repoRoot = makeTempRepo();
    copyTask4Fixtures(repoRoot, [
      relatedReportFinding(),
      relatedReportFinding({
        id: "related-tenant-validation-2",
        file: "src/api/admin.ts",
        line: 58,
        evidence: "return db.query('select * from admins where id = $1', [adminId]);",
      }),
    ]);

    const result = runIndexLatestInRepo(repoRoot);

    expect(result.runId).toBe("20260530-120000-001");
    expect(result.rawFindings).toBe(7);
    expect(result.normalizedFindings).toBe(7);
    expect(result.eventsGenerated).toBe(8);
    expect(result.materializedFindings).toBe(7);
    expect(result.segmentPath).toBeDefined();

    const { paths, events, state } = expectSchemaValidDiskState(repoRoot, 7, 8);
    expect(events.filter((event) => event.type === "finding.discovered")).toHaveLength(7);
    expect(events.filter((event) => event.type === "finding.related")).toHaveLength(1);
    expect(state?.findings.map((finding) => finding.title).sort()).toEqual([
      "Hardcoded JWT secret in source",
      "Hardcoded JWT secret in source",
      "Missing rate limit on login endpoint",
      "Missing rate limit on login endpoint",
      "Missing tenant validation before database query",
      "Missing tenant validation before database query",
      "O(n²) loop in job deduplication",
    ].sort());

    const redactedFinding = state?.findings.find(
      (finding) => finding.origin.sourceType === "report" && finding.title === "Hardcoded JWT secret in source",
    );
    expect(redactedFinding?.evidence).toContain("[REDACTED_BEARER_TOKEN]");
    expect(redactedFinding?.evidence).not.toContain("abcdefghijklmnopqrstuvwxyz12345");

    const malformedFinding = state?.findings.find(
      (finding) => finding.origin.sourceType === "report" && finding.title === "Missing rate limit on login endpoint",
    );
    expect(malformedFinding?.evidence).toBe("[EVIDENCE_MISSING]");
    expect(malformedFinding?.metadata.sourceMalformed).toBe(true);
    expect(malformedFinding?.status).toBe("confirmed");

    const relatedIndex = RelatedIndexSchema.parse(readJsonFile<unknown>(paths.relatedIndexFile));
    expect(relatedIndex.relations).toHaveLength(1);
    const relation = relatedIndex.relations[0];
    if (!relation) {
      throw new Error("expected cross-path relation to be written");
    }
    expect(relation.relationType).toBe("similar-cross-path");
    expect(relatedIndex.byFindingId[relation.findingId]).toEqual([relation]);
    expect(state?.findings.some((finding) => finding.id === relation.relatedFindingId)).toBe(true);
    expect(state?.findings.some((finding) => finding.id === relation.findingId)).toBe(true);
  });

  it("deduplicates a second index-latest run into seen_again events while keeping one materialized finding per fingerprint", () => {
    vi.useFakeTimers();
    const repoRoot = makeTempRepo();
    copyTask4Fixtures(repoRoot);

    vi.setSystemTime(new Date("2026-05-30T12:15:00.000Z"));
    const firstRun = runIndexLatestInRepo(repoRoot);
    vi.setSystemTime(new Date("2026-05-30T12:20:00.000Z"));
    const secondRun = runIndexLatestInRepo(repoRoot);

    expect(firstRun.eventsGenerated).toBe(5);
    expect(firstRun.findingsDeduplicated).toBe(0);
    expect(secondRun.eventsGenerated).toBe(5);
    expect(secondRun.findingsDeduplicated).toBe(5);
    expect(secondRun.segmentPath).toBeDefined();

    const firstRunEvents = readSegmentEvents(firstRun.segmentPath ?? "");
    const secondRunEvents = readSegmentEvents(secondRun.segmentPath ?? "");
    expect(secondRunEvents).toHaveLength(5);
    expect(secondRunEvents.every((event) => event.type === "finding.seen_again")).toBe(true);

    const allIds = [...firstRunEvents.map((e) => e.eventId), ...secondRunEvents.map((e) => e.eventId)];
    expect(new Set(allIds).size).toBe(allIds.length);

    const { paths, events, state } = expectSchemaValidDiskState(repoRoot, 5, 10);
    expect(fs.readdirSync(paths.segmentsDir).filter((file) => file.endsWith(".jsonl"))).toHaveLength(2);
    expect(events.filter((event) => event.type === "finding.discovered")).toHaveLength(5);
    expect(events.filter((event) => event.type === "finding.seen_again")).toHaveLength(5);
    expect(state?.findings.map((finding) => finding.occurrence.count)).toEqual([2, 2, 2, 2, 2]);
    expect(state?.findings.every((finding) => finding.occurrence.lastSeenAt === "2026-05-30T12:20:00.000Z")).toBe(true);
  });

  it("keeps report and handoff findings from mixed fixture sources in the final materialized state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:30:00.000Z"));
    const repoRoot = makeTempRepo();
    copyTask4Fixtures(repoRoot);

    const result = runIndexLatestInRepo(repoRoot);

    expect(result.rawFindings).toBe(5);
    expect(result.eventsGenerated).toBe(5);
    const { state } = expectSchemaValidDiskState(repoRoot, 5, 5);
    expect(state?.findings.map((finding) => `${finding.origin.sourceType}:${finding.reviewer}:${finding.title}`).sort()).toEqual([
      "import:omre-reviewer-security:Hardcoded JWT secret in source",
      "import:omre-reviewer-security:Missing rate limit on login endpoint",
      "report:auth-module:Hardcoded JWT secret in source",
      "report:auth-module:Missing rate limit on login endpoint",
      "report:queue-worker:O(n²) loop in job deduplication",
    ].sort());

    for (const finding of state?.findings ?? []) {
      if (finding.origin.sourceType === "report") {
        expect(finding.origin.sourcePath).toBe(".omre/reports/latest.json");
      } else if (finding.origin.sourceType === "import") {
        expect(finding.origin.sourcePath).toBe(`.omre/handoffs/${result.runId}`);
      }
    }
  });
});

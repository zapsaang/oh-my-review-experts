import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ensureMemoryDirs, resolveMemoryPaths, type MemoryPaths } from "../../src/memory/paths.js";
import type { MemoryEvent, MemoryFinding, MemoryManifest } from "../../src/memory/schema.js";
import {
  readMaterializedState,
  writeMaterializedState,
  type MaterializedState,
} from "../../src/memory/store.js";

const DEFAULT_FINDING_ID = "mem_abcdef1234567890";
const DEFAULT_TIMESTAMP = "2026-05-28T00:00:00.000Z";

export function makeTempRepo(): MemoryPaths {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-memory-"));
  const paths = resolveMemoryPaths(tmpDir);
  ensureMemoryDirs(paths);
  return paths;
}

export interface WriteSegmentOptions {
  bytes?: number;
  kind?: "raw" | "compacted";
}

export function writeSegment(
  paths: MemoryPaths,
  events: MemoryEvent[],
  runId: string,
  opts: WriteSegmentOptions = {},
): string {
  const dir = opts.kind === "compacted" ? paths.compactedDir : paths.segmentsDir;
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${Date.now()}-${randomBytes(4).toString("hex")}-${safeRunId}.jsonl`;
  const segmentPath = path.join(dir, filename);

  let content = events.map((event) => JSON.stringify(event)).join("\n") + "\n";

  if (opts.bytes !== undefined && Buffer.byteLength(content, "utf8") < opts.bytes) {
    const remaining = opts.bytes - Buffer.byteLength(content, "utf8");
    content += " ".repeat(Math.max(0, remaining - 1)) + "\n";
  }

  fs.writeFileSync(segmentPath, content, { encoding: "utf8", flag: "wx" });
  return segmentPath;
}

export function writeFinding(overrides: Partial<MemoryFinding> = {}): MemoryFinding {
  const finding = {
    schemaVersion: 1,
    id: DEFAULT_FINDING_ID,
    fingerprint: "fp1234567890abcdef",
    repo: {
      rootHash: "repo1234567890abcd",
      packagePath: "packages/core",
    },
    origin: {
      runId: "run-20260528",
      sourceType: "report",
      sourcePath: ".omre/reports/latest.json",
      createdAt: DEFAULT_TIMESTAMP,
    },
    reviewer: "security",
    severity: "high",
    status: "open",
    category: "injection",
    title: "SQL injection risk",
    problem: "User input reaches a SQL query without parameterization.",
    evidence: "db.query(`SELECT * FROM users WHERE id = ${id}`)",
    locations: [{ path: "src/users.ts", line: 42 }],
    occurrence: {
      firstSeenAt: DEFAULT_TIMESTAMP,
      lastSeenAt: DEFAULT_TIMESTAMP,
      count: 1,
      runIds: ["run-20260528"],
    },
    searchable: {
      redactedText: "sql injection parameterized query",
      tokens: ["sql", "injection", "query"],
    },
    metadata: {
      evidenceTruncated: false,
      problemTruncated: false,
      recommendationTruncated: false,
      sourceMalformed: false,
    },
    tags: [],
    contentHash: "ch1234567890abcdef",
  } satisfies MemoryFinding;

  return { ...finding, ...overrides };
}

export function seedManifest(paths: MemoryPaths, partial: Partial<MemoryManifest> = {}): MaterializedState {
  const existing = readMaterializedState(paths);

  const baseManifest: MemoryManifest = existing?.manifest ?? {
    schemaVersion: 1,
    eventSchemaVersion: 1,
    viewSchemaVersion: 1,
    lastRebuiltAt: DEFAULT_TIMESTAMP,
    materializedHash: "mat1234567890abcdef",
    relatedIndexHash: "rel1234567890abcdef",
    includedEventFiles: [],
    compactedInputSegments: [],
    gcSummary: {
      lastGcAt: undefined,
      deletedRawSegments: 0,
      deletedTmpFiles: 0,
      deletedQuarantineFiles: 0,
    },
    quarantine: [],
  };

  const state: MaterializedState = {
    findings: existing?.findings ?? [],
    manifest: { ...baseManifest, ...partial },
    relatedIndex: existing?.relatedIndex ?? {
      schemaVersion: 1,
      generatedAt: DEFAULT_TIMESTAMP,
      relations: [],
      byFindingId: {},
    },
  };

  writeMaterializedState(paths, state);
  return state;
}

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../config/load-config.js";
import { deduplicateAndGenerateEvents, type DeduplicateThresholds } from "./dedupe.js";
import { compareMemoryEvents, createEventBatchContext, readAllEventSegments, writeEventSegment } from "./events.js";
import { extractStructuredFindings } from "./extractor/index.js";
import type { RawFinding } from "./extractor/types.js";
import { normalizeMemoryFinding, type NormalizeContext } from "./normalize.js";
import { withMemoryLock } from "./lock.js";
import { ensureMemoryDirs, resolveMemoryPaths, type MemoryPaths } from "./paths.js";
import { redactRawFinding } from "./redaction.js";
import type { MemoryFinding } from "./schema.js";
import {
  CURRENT_MEMORY_EVENT_SCHEMA_VERSION,
  readMaterializedState,
  readMemoryManifest,
  rebuildMaterializedStateFromEvents,
  writeMaterializedState,
} from "./store.js";
import { assertSafePath } from "../tools/fs-utils.js";

import { resolveLogger, type OmreLogger } from "./logger.js";

export interface IndexLatestOptions {
  cwd?: string;
  dryRun?: boolean;
  report?: string;
  handoffDir?: string;
  output?: OmreLogger;
}

export interface IndexLatestResult {
  runId: string;
  rawFindings: number;
  normalizedFindings: number;
  existingFindings: number;
  eventsGenerated: number;
  findingsDeduplicated: number;
  dryRun: boolean;
  segmentPath?: string;
  materializedFindings?: number;
}

const REPORT_RELATIVE_PATH = path.join(".omre", "reports", "latest.json");
const HANDOFF_RELATIVE_ROOT = path.join(".omre", "handoffs");
const SAFE_RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function runIndexLatest(options: IndexLatestOptions = {}): IndexLatestResult {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = cwd;
  const dryRun = !!options.dryRun;
  const output = resolveLogger(options.output);
  const config = loadConfig(cwd);

  if (!config.memory.enabled) {
    output.log("memory disabled by config; skipping index-latest");
    return emptyIndexLatestResult(dryRun);
  }

  const paths = resolveMemoryPaths(repoRoot, config.memory.directory);
  const reportPath = resolveInputPath(repoRoot, options.report ?? REPORT_RELATIVE_PATH, "memory index-latest report");
  const reportExists = fs.existsSync(reportPath);
  const runId = reportExists ? readRunIdFromReport(reportPath) : timestampRunId();
  const handoffDir = resolveInputPath(
    repoRoot,
    options.handoffDir ?? path.join(HANDOFF_RELATIVE_ROOT, runId),
    "memory index-latest handoff-dir",
  );
  const handoffDirExists = fs.existsSync(handoffDir);

  output.log(`memory index-latest${dryRun ? " dry-run" : ""}`);
  output.log(`run id: ${runId}`);

  const createdAt = new Date().toISOString();
  const baseNormalizeCtx = {
    runId,
    createdAt,
    repoRoot,
    repoRootHash: hashRepoRoot(repoRoot),
  };
  const reportSourcePath = toRepoRelativePath(repoRoot, reportPath);
  const handoffSourcePath = toRepoRelativePath(repoRoot, handoffDir);
  const extractReportPath = reportExists ? reportPath : undefined;
  const extractHandoffDir = handoffDirExists ? handoffDir : undefined;
  const { report: reportFindings, handoffs: handoffFindings } = extractStructuredFindings({
    reportPath: extractReportPath,
    handoffDir: extractHandoffDir,
    logger: output,
  });
  const newFindings = [
    ...normalizeRawFindings(reportFindings, {
      ...baseNormalizeCtx,
      sourceType: "report",
      sourcePath: reportSourcePath,
    }),
    ...normalizeRawFindings(handoffFindings, {
      ...baseNormalizeCtx,
      sourceType: "import",
      sourcePath: handoffSourcePath,
    }),
  ];
  const rawFindingsCount = reportFindings.length + handoffFindings.length;
  const existingState = readMaterializedState(paths);
  assertSupportedEventSchema(existingState?.manifest.eventSchemaVersion);
  const existingFindings = existingState?.findings ?? [];
  const batchCtx = createEventBatchContext(runId);
  const thresholds = thresholdsFromConfig(config.memory);
  const dedupeResult = deduplicateAndGenerateEvents(newFindings, existingFindings, {
    runId,
    batchCtx,
  }, thresholds);
  const discoveredCount = dedupeResult.events.filter((event) => event.type === "finding.discovered").length;
  const findingsDeduplicated = newFindings.length - discoveredCount;

  output.log(`findings extracted: ${rawFindingsCount}`);
  output.log(`events generated: ${dedupeResult.events.length}`);
  output.log(`findings deduplicated: ${findingsDeduplicated}`);

  const result: IndexLatestResult = {
    runId,
    rawFindings: rawFindingsCount,
    normalizedFindings: newFindings.length,
    existingFindings: existingFindings.length,
    eventsGenerated: dedupeResult.events.length,
    findingsDeduplicated,
    dryRun,
  };

  if (dryRun) {
    output.log("dry-run: skipped writing event segment and materialized state");
    return result;
  }

  if (dedupeResult.events.length === 0) {
    output.log("no events generated; nothing written");
    return result;
  }

  assertCompatibleEventSchema(paths);
  ensureMemoryDirs(paths);

  const written = withMemoryLock(paths, () => {
    const segment = writeEventSegment(paths, dedupeResult.events.sort(compareMemoryEvents), runId);
    const { events: allEvents, skipped } = readAllEventSegments(paths, output);
    if (skipped > 0) {
      output.log(`warning: skipped ${skipped} corrupted event lines during rebuild`);
    }
    const state = rebuildMaterializedStateFromEvents(allEvents);
    writeMaterializedState(paths, state);
    return { segment, state };
  });

  output.log(`event segment: ${written.segment.segmentPath}`);
  output.log(`materialized findings: ${written.state.findings.length}`);

  return {
    ...result,
    segmentPath: written.segment.segmentPath,
    materializedFindings: written.state.findings.length,
  };
}

function emptyIndexLatestResult(dryRun: boolean): IndexLatestResult {
  return {
    runId: "disabled",
    rawFindings: 0,
    normalizedFindings: 0,
    existingFindings: 0,
    eventsGenerated: 0,
    findingsDeduplicated: 0,
    dryRun,
  };
}

function assertSupportedEventSchema(eventSchemaVersion: number | undefined): void {
  if (eventSchemaVersion === undefined || eventSchemaVersion === CURRENT_MEMORY_EVENT_SCHEMA_VERSION) {
    return;
  }

  throw new Error(
    `Memory event schema version mismatch: manifest has eventSchemaVersion ${eventSchemaVersion}, `
      + `but this CLI supports ${CURRENT_MEMORY_EVENT_SCHEMA_VERSION}`,
  );
}

function resolveInputPath(repoRoot: string, inputPath: string, context: string): string {
  const resolvedPath = path.resolve(repoRoot, inputPath);
  assertSafePath(resolvedPath, repoRoot, context);
  return resolvedPath;
}

function toRepoRelativePath(repoRoot: string, resolvedPath: string): string {
  const relativePath = path.relative(repoRoot, resolvedPath);
  return relativePath.length === 0 ? "." : relativePath;
}

function normalizeRawFindings(rawFindings: RawFinding[], ctx: NormalizeContext): MemoryFinding[] {
  return rawFindings
    .map((finding) => redactRawFinding(finding))
    .map((finding) => normalizeMemoryFinding(finding, ctx));
}

function assertCompatibleEventSchema(paths: MemoryPaths): void {
  const manifest = readMemoryManifest(paths);
  if (manifest === null) {
    return;
  }

  if (manifest.eventSchemaVersion !== CURRENT_MEMORY_EVENT_SCHEMA_VERSION) {
    throw new Error(
      `Memory event schema version mismatch: manifest has eventSchemaVersion ${manifest.eventSchemaVersion}, but this CLI supports ${CURRENT_MEMORY_EVENT_SCHEMA_VERSION}. Refusing to rebuild memory from event segments.`,
    );
  }
}

function readRunIdFromReport(reportPath: string): string {
  const raw = fs.readFileSync(reportPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (isRecord(parsed) && typeof parsed.run_id === "string" && parsed.run_id.trim().length > 0) {
    return validateRunId(parsed.run_id.trim());
  }

  if (isRecord(parsed) && typeof parsed.runId === "string" && parsed.runId.trim().length > 0) {
    return validateRunId(parsed.runId.trim());
  }

  return timestampRunId();
}

function validateRunId(runId: string): string {
  if (!SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid run id in latest report: ${runId}`);
  }

  return runId;
}

function thresholdsFromConfig(memory: {
  dedupe?: { fingerprintThreshold?: number; contentHashThreshold?: number };
  retrieval?: { similarityThreshold?: number };
} | undefined): DeduplicateThresholds {
  return {
    fingerprintMerge: memory?.dedupe?.fingerprintThreshold ?? 0.92,
    samePathProblem: memory?.retrieval?.similarityThreshold ?? 0.75,
    crossPathRelated: memory?.dedupe?.contentHashThreshold ?? 0.85,
  };
}

function timestampRunId(): string {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function hashRepoRoot(repoRoot: string): string {
  return createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

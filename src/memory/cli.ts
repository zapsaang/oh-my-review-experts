import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Command } from "commander";
import { loadConfig } from "../config/load-config.js";
import { deduplicateAndGenerateEvents, type DeduplicateThresholds } from "./dedupe.js";
import { compareMemoryEvents, createEventBatchContext, readAllEventSegments, writeEventSegment } from "./events.js";
import { extractRawFindings } from "./extractor/index.js";
import type { RawFinding } from "./extractor/types.js";
import { normalizeMemoryFinding, type NormalizeContext } from "./normalize.js";
import { ensureMemoryDirs, resolveMemoryPaths } from "./paths.js";
import { redactRawFinding } from "./redaction.js";
import type { MemoryFinding } from "./schema.js";
import {
  readMaterializedState,
  rebuildMaterializedStateFromEvents,
  writeMaterializedState,
} from "./store.js";
import { assertSafePath } from "../tools/fs-utils.js";

export interface MemoryCliOutput {
  log: (...values: unknown[]) => void;
  error: (...values: unknown[]) => void;
}

export interface IndexLatestOptions {
  cwd?: string;
  dryRun?: boolean;
  report?: string;
  handoffDir?: string;
  output?: MemoryCliOutput;
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

export function registerMemoryCli(program: Command): void {
  const memory = program.command("memory")
    .description("Manage OMRE review memory");

  memory.command("index-latest")
    .description("Index latest review report and handoffs into memory")
    .option("--report <path>", "path to the review report JSON")
    .option("--handoff-dir <dir>", "directory containing handoff markdown files")
    .option("--dry-run", "run extraction, redaction, normalization, and dedupe without writing", false)
    .action((opts: { dryRun?: boolean; report?: string; handoffDir?: string }) => {
      try {
        runIndexLatest({ dryRun: !!opts.dryRun, report: opts.report, handoffDir: opts.handoffDir });
      } catch (err) {
        console.error(`memory index-latest failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

export function runIndexLatest(options: IndexLatestOptions = {}): IndexLatestResult {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = cwd;
  const dryRun = !!options.dryRun;
  const output = options.output ?? console;
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
  const rawFindings = extractRawFindings({
    reportPath: extractReportPath,
    handoffDir: extractHandoffDir,
    sources: ["reports", "handoffs"],
  });
  const reportFindingCount = reportExists && handoffDirExists
    ? extractRawFindings({ reportPath, sources: ["reports"] }).length
    : reportExists ? rawFindings.length : 0;
  const reportFindings = rawFindings.slice(0, reportFindingCount);
  const handoffFindings = rawFindings.slice(reportFindingCount);
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
  const existingFindings = existingState?.findings ?? [];
  const batchCtx = createEventBatchContext(runId);
  const thresholds = thresholdsFromConfig(config.memory);
  const dedupeResult = deduplicateAndGenerateEvents(newFindings, existingFindings, {
    runId,
    sourcePath: reportExists ? reportSourcePath : handoffSourcePath,
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

  ensureMemoryDirs(paths);

  const segment = writeEventSegment(paths, dedupeResult.events.sort(compareMemoryEvents), runId);
  const allEvents = readAllEventSegments(paths);
  const state = rebuildMaterializedStateFromEvents(allEvents);
  writeMaterializedState(paths, state);

  output.log(`event segment: ${segment.segmentPath}`);
  output.log(`materialized findings: ${state.findings.length}`);

  return {
    ...result,
    segmentPath: segment.segmentPath,
    materializedFindings: state.findings.length,
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

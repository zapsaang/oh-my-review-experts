import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Command } from "commander";
import { loadConfig } from "../config/load-config.js";
import { deduplicateAndGenerateEvents, type DeduplicateThresholds } from "./dedupe.js";
import { compareMemoryEvents, createEventBatchContext, readAllEventSegments, writeEventSegment } from "./events.js";
import { extractStructuredFindings } from "./extractor/index.js";
import type { RawFinding } from "./extractor/types.js";
import { normalizeMemoryFinding, type NormalizeContext } from "./normalize.js";
import { ensureMemoryDirs, resolveMemoryPaths, type MemoryPaths } from "./paths.js";
import { rankMemoryHits } from "./ranking.js";
import { redactRawFinding } from "./redaction.js";
import type { MemoryFinding } from "./schema.js";
import { searchMemory } from "./search.js";
import {
  CURRENT_MEMORY_EVENT_SCHEMA_VERSION,
  type MaterializedState,
  readMaterializedState,
  readMemoryManifest,
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

interface MemoryReadCliOptions {
  cwd?: string;
  output?: MemoryCliOutput;
}

interface ListCommandOptions {
  status?: string;
  reviewer?: string;
  limit?: string;
}

interface MemoryListOptions extends MemoryReadCliOptions {
  status?: string;
  reviewer?: string;
  limit?: number;
}

interface LoadedMaterializedState {
  state: MaterializedState;
  memoryConfig: ReturnType<typeof loadConfig>["memory"];
}

const REPORT_RELATIVE_PATH = path.join(".omre", "reports", "latest.json");
const HANDOFF_RELATIVE_ROOT = path.join(".omre", "handoffs");
const SAFE_RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const REVIEWER_PREFIX = "omre-reviewer-";
const MEMORY_STATUS_VALUES = [
  "open",
  "confirmed",
  "fixed",
  "ignored",
  "false-positive",
  "stale",
] satisfies Array<MemoryFinding["status"]>;

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

  memory.command("search")
    .description("Search materialized review memory")
    .argument("<query>", "keyword query")
    .action((query: string) => {
      runMemoryCliAction("memory search", () => runMemorySearch(query));
    });

  memory.command("list")
    .description("List materialized memory findings")
    .option("--status <status>", "filter by memory status")
    .option("--reviewer <reviewer>", "filter by reviewer dimension or omre-reviewer-* alias")
    .option("--limit <n>", "maximum findings to print")
    .action((opts: ListCommandOptions) => {
      runMemoryCliAction("memory list", () => runMemoryList({
        status: opts.status,
        reviewer: opts.reviewer,
        limit: parseLimit(opts.limit, "--limit"),
      }));
    });

  memory.command("show")
    .description("Show one materialized memory finding")
    .argument("<id>", "memory finding id")
    .action((id: string) => {
      runMemoryCliAction("memory show", () => runMemoryShow(id));
    });

  memory.command("stats")
    .description("Print materialized memory aggregate counts")
    .action(() => {
      runMemoryCliAction("memory stats", () => runMemoryStats());
    });
}

function runMemoryCliAction(commandName: string, action: () => void): void {
  try {
    action();
  } catch (err) {
    console.error(`${commandName} failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function runMemorySearch(query: string, options: MemoryReadCliOptions = {}): void {
  const output = options.output ?? console;
  const loaded = loadMaterializedMemory(options);
  if (loaded === null) {
    return;
  }

  const searchResult = searchMemory({
    findings: loaded.state.findings,
    query,
    includeFalsePositive: loaded.memoryConfig.retrieval.includeFalsePositive,
    similarityThreshold: loaded.memoryConfig.retrieval.similarityThreshold,
  });
  const rankedHits = rankMemoryHits({
    hits: searchResult.hits,
    includeFixedAsRegressionCandidates: loaded.memoryConfig.retrieval.includeFixedAsRegressionCandidates,
  });
  const limitedHits = rankedHits.slice(0, loaded.memoryConfig.retrieval.defaultTopK);

  output.log(`memory search: ${summarizeText(query, 200)}`);
  output.log(`matches: ${limitedHits.length}`);

  if (limitedHits.length === 0) {
    output.log("no memory findings matched query");
    return;
  }

  limitedHits.forEach((hit, index) => {
    output.log(`${index + 1}. ${formatSearchHit(hit.finding, hit.keywordScore)}`);
  });
}

function runMemoryList(options: MemoryListOptions = {}): void {
  const output = options.output ?? console;
  const loaded = loadMaterializedMemory(options);
  if (loaded === null) {
    return;
  }

  const status = parseMemoryStatus(options.status);
  const reviewer = options.reviewer === undefined ? undefined : canonicalReviewerName(options.reviewer);
  const findings = loaded.state.findings
    .filter((finding) => status === undefined || finding.status === status)
    .filter((finding) => reviewer === undefined || canonicalReviewerName(finding.reviewer) === reviewer);
  const limitedFindings = options.limit === undefined ? findings : findings.slice(0, options.limit);

  output.log("memory list");
  output.log(`findings: ${limitedFindings.length}`);

  if (limitedFindings.length === 0) {
    output.log("no memory findings matched filters");
    return;
  }

  for (const finding of limitedFindings) {
    output.log(`- ${formatListFinding(finding)}`);
  }
}

function runMemoryShow(id: string, options: MemoryReadCliOptions = {}): void {
  const output = options.output ?? console;
  const loaded = loadMaterializedMemory(options);
  if (loaded === null) {
    return;
  }

  const finding = loaded.state.findings.find((candidate) => candidate.id === id);
  if (finding === undefined) {
    output.log(`memory finding not found: ${id}`);
    return;
  }

  output.log(`memory show: ${finding.id}`);
  output.log(`title: ${summarizeText(finding.title, 240)}`);
  output.log(`reviewer: ${canonicalReviewerName(finding.reviewer)}`);
  output.log(`status: ${finding.status}`);
  output.log(`severity: ${finding.severity}`);
  output.log(`problem: ${summarizeText(finding.problem, 500)}`);
  output.log(`evidence: ${summarizeText(finding.evidence, 500)}`);
}

function runMemoryStats(options: MemoryReadCliOptions = {}): void {
  const output = options.output ?? console;
  const loaded = loadMaterializedMemory(options);
  if (loaded === null) {
    return;
  }

  const statusCounts = new Map<MemoryFinding["status"], number>();
  const reviewerCounts = new Map<string, number>();
  for (const finding of loaded.state.findings) {
    incrementCount(statusCounts, finding.status);
    incrementCount(reviewerCounts, canonicalReviewerName(finding.reviewer));
  }

  output.log("memory stats");
  output.log(`total findings: ${loaded.state.findings.length}`);
  output.log("by status:");
  for (const status of MEMORY_STATUS_VALUES) {
    const count = statusCounts.get(status);
    if (count !== undefined) {
      output.log(`  ${status}: ${count}`);
    }
  }
  output.log("by reviewer:");
  for (const reviewer of Array.from(reviewerCounts.keys()).sort()) {
    output.log(`  ${reviewer}: ${reviewerCounts.get(reviewer) ?? 0}`);
  }
}

function loadMaterializedMemory(options: MemoryReadCliOptions): LoadedMaterializedState | null {
  const output = options.output ?? console;
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(cwd);

  if (!config.memory.enabled) {
    output.log("memory disabled by config");
    return null;
  }

  const paths = resolveMemoryPaths(cwd, config.memory.directory);
  const state = readMaterializedState(paths);
  if (state === null) {
    output.log("no memory state found");
    return null;
  }

  return { state, memoryConfig: config.memory };
}

function parseMemoryStatus(status: string | undefined): MemoryFinding["status"] | undefined {
  if (status === undefined) {
    return undefined;
  }

  for (const candidate of MEMORY_STATUS_VALUES) {
    if (candidate === status) {
      return candidate;
    }
  }

  throw new Error(`invalid memory status: ${status}`);
}

function parseLimit(limit: string | undefined, optionName: string): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }

  return parsed;
}

function formatSearchHit(finding: MemoryFinding, score: number): string {
  return `${finding.id} | ${summarizeText(finding.title, 240)} | reviewer=${canonicalReviewerName(finding.reviewer)} | status=${finding.status} | score=${score.toFixed(3)}`;
}

function formatListFinding(finding: MemoryFinding): string {
  return `${finding.id} | ${summarizeText(finding.title, 240)} | reviewer=${canonicalReviewerName(finding.reviewer)} | status=${finding.status} | severity=${finding.severity}`;
}

function canonicalReviewerName(reviewer: string): string {
  return reviewer.startsWith(REVIEWER_PREFIX) ? reviewer.slice(REVIEWER_PREFIX.length) : reviewer;
}

function summarizeText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  if (maxLength <= 3) {
    return normalized.slice(0, maxLength);
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function incrementCount<TKey>(counts: Map<TKey, number>, key: TKey): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
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
  const { report: reportFindings, handoffs: handoffFindings } = extractStructuredFindings({
    reportPath: extractReportPath,
    handoffDir: extractHandoffDir,
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

  const segment = writeEventSegment(paths, dedupeResult.events.sort(compareMemoryEvents), runId);
  const { events: allEvents, skipped } = readAllEventSegments(paths);
  if (skipped > 0) {
    output.log(`warning: skipped ${skipped} corrupted event lines during rebuild`);
  }
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

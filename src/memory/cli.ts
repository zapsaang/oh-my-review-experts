import { runMemoryCheck, renderCheckResult } from "./check.js";
import { runMemoryMark } from "./mark.js";
import { runMemoryCompact } from "./compact.js";
import { runMemoryGc } from "./gc.js";
import { generateSuggestions } from "./suggestions.js";
import { readAllEventSegments } from "./events.js";
import type { Command } from "commander";
import { loadConfig } from "../config/load-config.js";
import { runIndexLatest, type IndexLatestOptions, type IndexLatestResult } from "./indexing.js";
import { resolveMemoryPaths } from "./paths.js";
import { rankMemoryHits } from "./ranking.js";
import { REVIEWER_PREFIX, canonicalReviewerName } from "./reviewer-name.js";
import type { MemoryFinding } from "./schema.js";
import { searchMemory } from "./search.js";
import { computeTrends, type TrendsReport } from "./trends.js";
import {
  type MaterializedState,
  readMaterializedState,
} from "./store.js";

export { runIndexLatest };
export type { IndexLatestOptions, IndexLatestResult };

export interface MemoryCliOutput {
  log: (...values: unknown[]) => void;
  error: (...values: unknown[]) => void;
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

interface SuggestionsContext {
  readonly loaded: LoadedMaterializedState;
  readonly result: ReturnType<typeof generateSuggestions>;
}

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
        runIndexLatest({ dryRun: !!opts.dryRun, report: opts.report, handoffDir: opts.handoffDir, output: console });
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
    .option("--reviewer <reviewer>", `filter by reviewer dimension or ${REVIEWER_PREFIX}* alias`)
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

  memory.command("check")
    .description("Check memory store integrity")
    .action(() => {
      runMemoryCliAction("memory check", () => {
        const paths = resolveMemoryPaths(process.cwd());
        const result = runMemoryCheck(paths, console);
        console.log(renderCheckResult(result));
      });
    });

  memory.command("mark <id>")
    .description("Mark a memory finding with a new status")
    .option("--status <status>", "new status")
    .option("--reason <reason>", "reason for status change")
    .action((id: string, opts: { status?: string; reason?: string }) => {
      runMemoryCliAction("memory mark", () => {
        const status = parseMemoryStatus(opts.status);
        if (status === undefined) {
          throw new Error("--status is required");
        }
        const result = runMemoryMark({ findingId: id, status, reason: opts.reason, cwd: process.cwd(), output: console });
        console.log(`marked ${result.findingId}: ${result.previousStatus} → ${result.newStatus}`);
      });
    });

  memory.command("compact")
    .description("Compact raw memory segments")
    .option("--dry-run", "show what would be compacted without writing", false)
    .action((opts: { dryRun?: boolean }) => {
      runMemoryCliAction("memory compact", () => {
        const result = runMemoryCompact({ cwd: process.cwd(), dryRun: !!opts.dryRun });
        const totalRaw = result.compactedSegments.reduce((sum, seg) => sum + seg.rawPaths.length, 0);
        const totalFiles = result.compactedSegments.length;
        console.log(`compacted ${totalRaw} segments into ${totalFiles} files`);
        for (const seg of result.compactedSegments) {
          console.log(`  - ${seg.compactedPath}`);
        }
      });
    });

  memory.command("gc")
    .description("Garbage collect memory store")
    .option("--dry-run", "show what would be deleted without writing", false)
    .option("--quarantine <days>", "quarantine files older than N days")
    .action((opts: { dryRun?: boolean; quarantine?: string }) => {
      runMemoryCliAction("memory gc", () => {
        const result = runMemoryGc({
          cwd: process.cwd(),
          dryRun: !!opts.dryRun,
          output: console,
          quarantine: opts.quarantine ? { olderThanDays: Number(opts.quarantine) } : undefined,
        });
        console.log(`deleted: tmp=${result.deleted.tmpFiles}, empty=${result.deleted.emptySegments}, compacted-raw=${result.deleted.compactedRawSegments}, overflow=${result.deleted.overflowRawSegments}, quarantine=${result.deleted.quarantineFiles}`);
        console.log("gc summary updated");
      });
    });

  memory.command("suggestions")
    .description("List stale-finding suggestions with confidence and reason")
    .action(() => {
      runMemoryCliAction("memory suggestions", () => runMemorySuggestions());
    });

  memory.command("apply-suggestions")
    .description("Apply high-confidence stale-finding suggestions")
    .option("--dry-run", "show what would be marked without writing", false)
    .action(async (opts: { dryRun?: boolean }) => {
      try {
        await runMemoryApplySuggestions({ dryRun: !!opts.dryRun });
      } catch (err) {
        console.error(`memory apply-suggestions failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  memory.command("trends")
    .description("Print review memory trends")
    .option("--at-bucket <iso>", "Snapshot trends up to this ISO timestamp")
    .action((opts: { atBucket?: string }) => {
      runMemoryCliAction("memory trends", () => runMemoryTrends({ atBucket: opts.atBucket }));
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

  // Heuristic: a "regression candidate" is a fixed finding seen across multiple
  // runs. This OVER-counts (multiple runIds != a true regression) and is only an
  // approximation. The precise count reads finding.regressed events
  // (readAllEventSegments + filter by event type, see schema.ts:114); deferred
  // to a future PR — the heuristic is sufficient for stats visibility in v0.5.
  const regressionCandidates = loaded.state.findings.filter(
    (f) => f.status === "fixed" && f.occurrence.runIds.length > 1,
  ).length;
  output.log(`regression candidates: ${regressionCandidates}`);
}

function runMemorySuggestions(): void {
  const context = loadSuggestionsContext();
  if (context === null) {
    return;
  }

  const { loaded, result } = context;

  if (result.suggestions.length === 0) {
    console.log("no suggestions");
    return;
  }

  const byId = new Map(loaded.state.findings.map(f => [f.id, f]));
  for (const s of result.suggestions) {
    const title = byId.get(s.findingId)?.title?.slice(0, 80) ?? "(unknown)";
    console.log(`${s.findingId} | ${s.confidence} | ${s.triggeredBy} | ${title} | ${s.reason}`);
  }
}

function runMemoryApplySuggestions({ dryRun }: { dryRun: boolean }): void {
  const context = loadSuggestionsContext();
  if (context === null) {
    return;
  }

  const { loaded, result } = context;

  const high = result.suggestions.filter(s => s.confidence === "high");
  if (high.length === 0) {
    console.log("no high-confidence suggestions to apply");
    return;
  }

  if (dryRun) {
    const byId = new Map(loaded.state.findings.map(f => [f.id, f]));
    for (const s of high) {
      const title = byId.get(s.findingId)?.title?.slice(0, 80) ?? "";
      console.log(`[dry-run] ${s.findingId} → stale${title ? ` (${title})` : ""}`);
    }
    return;
  }

  let failures = 0;
  for (const s of high) {
    try {
      runMemoryMark({ findingId: s.findingId, status: "stale", reason: s.reason, cwd: process.cwd() });
      console.log(`marked ${s.findingId} as stale`);
    } catch (err) {
      console.error(`failed to mark ${s.findingId}: ${err instanceof Error ? err.message : String(err)}`);
      failures++;
    }
  }

  if (failures > 0) {
    process.exit(1);
  }
}

function loadSuggestionsContext(): SuggestionsContext | null {
  const repoRoot = process.cwd();
  const loaded = loadMaterializedMemory({});
  if (loaded === null) {
    return null;
  }

  if (loaded.memoryConfig.suggestions.enabled === false) {
    console.log("suggestions disabled by config");
    return null;
  }

  const result = generateSuggestions(loaded.state.findings, {
    repoRoot,
    timeDecayDays: loaded.memoryConfig.suggestions.timeDecayDays,
    skipImportSourceForFileDeletion: loaded.memoryConfig.suggestions.skipImportSource,
  });

  return { loaded, result };
}

function runMemoryTrends(options: MemoryReadCliOptions & { atBucket?: string } = {}): void {
  const output = options.output ?? console;
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(cwd);

  if (!config.memory.enabled) {
    output.log("memory disabled by config");
    return;
  }

  const paths = resolveMemoryPaths(cwd, config.memory.directory);
  const { events, skipped } = readAllEventSegments(paths);
  if (skipped > 0) {
    output.log(`warning: skipped ${skipped} corrupted event lines while reading trends`);
  }

  const atBucket = options.atBucket ?? new Date().toISOString();
  renderTrendsReport(computeTrends(events, { atBucket }), output);
}

function renderTrendsReport(report: TrendsReport, output: MemoryCliOutput = console): void {
  output.log("memory trends");
  output.log("module distribution:");
  if (report.moduleDistribution.length === 0) {
    output.log("  none");
  } else {
    for (const row of report.moduleDistribution) {
      output.log(`  ${row.module}: ${row.count} (${row.percentage.toFixed(1)}%)`);
    }
  }

  output.log("recurring regressions:");
  if (report.recurringRegressions.length === 0) {
    output.log("  none");
  } else {
    for (const row of report.recurringRegressions) {
      const last = row.lastRegressionAt === undefined ? "never" : row.lastRegressionAt;
      output.log(`  ${row.findingId} | ${summarizeText(row.title, 160)} | count=${row.regressionCount} | last=${last}`);
    }
  }

  output.log("fix survival time:");
  if (report.fixSurvivalTime.length === 0) {
    output.log("  none");
  } else {
    for (const row of report.fixSurvivalTime) {
      const regressed = row.regressedAt === undefined ? "none" : row.regressedAt;
      output.log(`  ${row.findingId} | ${summarizeText(row.title, 160)} | fixed=${row.fixedAt} | regressed=${regressed} | survivedMs=${row.survivedMs}`);
    }
  }

  output.log("per-run timeline:");
  if (report.perRunTimeline.length === 0) {
    output.log("  none");
    return;
  }

  for (const row of report.perRunTimeline) {
    output.log(`  ${row.runId} | introduced=${row.introduced} | seenAgain=${row.seenAgain} | statusChanged=${row.statusChanged} | regressed=${row.regressed} | totalActive=${row.totalActive}`);
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

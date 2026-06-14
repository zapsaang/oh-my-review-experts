import type { Command } from "commander";
import { loadConfig } from "../config/load-config.js";
import { runIndexLatest, type IndexLatestOptions, type IndexLatestResult } from "./indexing.js";
import { resolveMemoryPaths } from "./paths.js";
import { rankMemoryHits } from "./ranking.js";
import { REVIEWER_PREFIX, canonicalReviewerName } from "./reviewer-name.js";
import type { MemoryFinding } from "./schema.js";
import { searchMemory } from "./search.js";
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

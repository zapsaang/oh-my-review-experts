import fs from "node:fs";
import path from "node:path";
import type { Stats } from "node:fs";
import { runIndexLatest, type IndexLatestResult } from "./cli.js";
import type { MemoryConfig } from "./config.js";
import { buildMemoryContextPack, type MemoryContextPack } from "./context-pack.js";
import { resolveMemoryPaths } from "./paths.js";
import { rankMemoryHits } from "./ranking.js";
import { searchMemory } from "./search.js";
import { normalizeWhitespace, stripMarkdownFences, tokenizeForSimilarity } from "./similarity.js";
import { readMaterializedState } from "./store.js";

export interface RetrieveMemoryContextInput {
  repoRoot: string;
  reviewer: string;
  slicePaths: string[];
  diffSummary: string;
  userGuidance?: string;
  memoryConfig: MemoryConfig;
  withMemory?: boolean;
  noMemory?: boolean;
}

export interface AutoCompactThresholdResult {
  needsCompaction: boolean;
  reason?: string;
}

const QUERY_TEXT_CHAR_LIMIT = 200;
const QUERY_TOKEN_LIMIT = 75;
const HOURS_IN_MS = 60 * 60 * 1000;

export function buildSearchQuery(input: RetrieveMemoryContextInput): string[] | undefined {
  const diffText = normalizeWhitespace(stripMarkdownFences(input.diffSummary)).slice(0, QUERY_TEXT_CHAR_LIMIT);
  const guidanceText = normalizeWhitespace(stripMarkdownFences(input.userGuidance ?? "")).slice(0, QUERY_TEXT_CHAR_LIMIT);
  const queryTokens = dedupeStable(tokenizeForSimilarity(`${diffText} ${guidanceText}`)).slice(0, QUERY_TOKEN_LIMIT);

  return queryTokens.length > 0 ? queryTokens : undefined;
}

export function retrieveMemoryContext(input: RetrieveMemoryContextInput): MemoryContextPack | undefined {
  if (!isRetrievalEnabled(input)) {
    return undefined;
  }

  let state: ReturnType<typeof readMaterializedState>;
  try {
    const paths = resolveMemoryPaths(input.repoRoot, input.memoryConfig.directory);
    state = readMaterializedState(paths);
  } catch {
    return undefined;
  }

  if (state === null || state.findings.length === 0) {
    return undefined;
  }

  const queryTokens = buildSearchQuery(input);
  if (queryTokens === undefined) {
    return undefined;
  }

  const reviewerConfig = input.memoryConfig.retrieval.byReviewer[input.reviewer];
  const topK = normalizePositiveInteger(reviewerConfig?.topK ?? input.memoryConfig.retrieval.defaultTopK);
  if (topK === 0) {
    return undefined;
  }

  const searchResult = searchMemory({
    findings: state.findings,
    query: queryTokens.join(" "),
    reviewer: input.reviewer,
    includeReviewers: reviewerConfig?.includeReviewers,
    paths: input.slicePaths,
    includeFalsePositive: input.memoryConfig.retrieval.includeFalsePositive,
    similarityThreshold: input.memoryConfig.retrieval.similarityThreshold,
  });

  if (searchResult.hits.length === 0) {
    return undefined;
  }

  const rankedHits = rankMemoryHits({
    hits: searchResult.hits,
    reviewer: input.reviewer,
    includeReviewers: reviewerConfig?.includeReviewers,
    includeFixedAsRegressionCandidates: input.memoryConfig.retrieval.includeFixedAsRegressionCandidates,
  }).slice(0, topK);

  if (rankedHits.length === 0) {
    return undefined;
  }

  return buildMemoryContextPack({
    hits: rankedHits,
    relatedIndex: state.relatedIndex,
    maxContextItems: input.memoryConfig.retrieval.maxContextItems,
    maxContextChars: input.memoryConfig.retrieval.maxContextChars,
  });
}

export function checkAutoCompactThreshold(cwd: string, memoryConfig: MemoryConfig): AutoCompactThresholdResult {
  if (!memoryConfig.compaction.enabled) {
    return { needsCompaction: false };
  }

  const segmentStats = readSegmentStats(cwd, memoryConfig);
  const segmentCount = segmentStats.length;
  if (segmentCount > memoryConfig.compaction.maxSegmentsBeforeCompaction) {
    return {
      needsCompaction: true,
      reason: `segments=${segmentCount} > maxSegmentsBeforeCompaction=${memoryConfig.compaction.maxSegmentsBeforeCompaction}`,
    };
  }

  const oldestMtime = oldestMtimeMs(segmentStats);
  if (oldestMtime !== undefined) {
    const ageHours = (Date.now() - oldestMtime) / HOURS_IN_MS;
    if (ageHours > memoryConfig.compaction.maxSegmentAgeHours) {
      return {
        needsCompaction: true,
        reason: `oldestSegmentAgeHours=${formatAgeHours(ageHours)} > maxSegmentAgeHours=${memoryConfig.compaction.maxSegmentAgeHours}`,
      };
    }
  }

  return { needsCompaction: false };
}

export function autoIndexAfterReview(cwd: string): IndexLatestResult {
  return runIndexLatest({ cwd });
}

function isRetrievalEnabled(input: RetrieveMemoryContextInput): boolean {
  return input.memoryConfig.enabled
    && (input.memoryConfig.retrieval.enabled || input.withMemory === true)
    && input.noMemory !== true
    && input.memoryConfig.retrieval.byReviewer[input.reviewer]?.enabled !== false;
}

function dedupeStable(tokens: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      deduped.push(token);
    }
  }

  return deduped;
}

function normalizePositiveInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.floor(value);
}

function readSegmentStats(cwd: string, memoryConfig: MemoryConfig): Stats[] {
  try {
    const paths = resolveMemoryPaths(cwd, memoryConfig.directory);
    if (!fs.existsSync(paths.segmentsDir)) {
      return [];
    }

    const stats: Stats[] = [];
    for (const fileName of fs.readdirSync(paths.segmentsDir)) {
      if (!fileName.endsWith(".jsonl")) {
        continue;
      }

      const fileStats = fs.statSync(path.join(paths.segmentsDir, fileName));
      if (fileStats.isFile()) {
        stats.push(fileStats);
      }
    }

    return stats;
  } catch {
    return [];
  }
}

function oldestMtimeMs(stats: Stats[]): number | undefined {
  let oldest: number | undefined;

  for (const stat of stats) {
    oldest = oldest === undefined ? stat.mtimeMs : Math.min(oldest, stat.mtimeMs);
  }

  return oldest;
}

function formatAgeHours(ageHours: number): string {
  return ageHours.toFixed(2).replace(/\.00$/, "");
}

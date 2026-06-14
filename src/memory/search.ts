import path from "node:path/posix";
import { canonicalReviewerName } from "./reviewer-name.js";
import type { MemoryFinding } from "./schema.js";
import { tokenizeForSimilarity } from "./similarity.js";

export type SearchMemoryStatus = MemoryFinding["status"];

export interface SearchMemoryInput {
  findings: MemoryFinding[];
  query: string;
  reviewer?: string;
  includeReviewers?: string[];
  paths?: string[];
  statuses?: SearchMemoryStatus[];
  includeFalsePositive?: boolean;
  limit?: number;
  similarityThreshold?: number;
}

export interface MemorySearchHit {
  finding: MemoryFinding;
  keywordScore: number;
  matchedTokens: string[];
  pathOverlapRank: number;
}

export interface SearchMemoryResult {
  hits: MemorySearchHit[];
  queryTokens: string[];
  effectiveReviewers: string[];
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.75;

export function searchMemory(input: SearchMemoryInput): SearchMemoryResult {
  const queryTokens = tokenizeForSimilarity(input.query);
  const effectiveReviewers = resolveEffectiveReviewers(input);
  const limit = normalizeLimit(input.limit);

  if (queryTokens.length === 0 || limit === 0 || hasExplicitEmptyReviewerFilter(input)) {
    return { hits: [], queryTokens, effectiveReviewers };
  }

  const queryTokenSet = new Set(queryTokens);
  const statuses = input.statuses ? new Set<SearchMemoryStatus>(input.statuses) : undefined;
  const reviewerFilter = buildReviewerFilter(input, effectiveReviewers);
  const normalizedInputPaths = normalizePaths(input.paths ?? []);
  const threshold = input.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const hits: MemorySearchHit[] = [];

  for (const finding of input.findings) {
    if (limit !== undefined && hits.length >= limit) {
      break;
    }

    if (!shouldSearchFinding(finding, statuses, input.includeFalsePositive === true, reviewerFilter)) {
      continue;
    }

    const findingTokens = uniqueTokens(resolveFindingTokens(finding));
    if (findingTokens.length === 0) {
      continue;
    }

    const keywordScore = jaccardTokenSimilarity(queryTokenSet, findingTokens);
    if (keywordScore < threshold) {
      continue;
    }

    hits.push({
      finding,
      keywordScore,
      matchedTokens: findMatchedTokens(queryTokens, findingTokens),
      pathOverlapRank: normalizedInputPaths.length === 0 ? 0 : computePathOverlapRank(finding, normalizedInputPaths),
    });
  }

  return { hits, queryTokens, effectiveReviewers };
}

function resolveEffectiveReviewers(input: SearchMemoryInput): string[] {
  if (input.includeReviewers !== undefined) {
    return input.includeReviewers;
  }

  return input.reviewer ? [input.reviewer] : [];
}

function hasExplicitEmptyReviewerFilter(input: SearchMemoryInput): boolean {
  return input.includeReviewers !== undefined && input.includeReviewers.length === 0;
}

function buildReviewerFilter(input: SearchMemoryInput, effectiveReviewers: string[]): Set<string> | undefined {
  if (input.includeReviewers === undefined && input.reviewer === undefined) {
    return undefined;
  }

  return new Set(effectiveReviewers.map((reviewer) => canonicalReviewerName(reviewer)));
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (!Number.isFinite(limit) || limit <= 0) {
    return 0;
  }

  return Math.floor(limit);
}

function shouldSearchFinding(
  finding: MemoryFinding,
  statuses: Set<SearchMemoryStatus> | undefined,
  includeFalsePositive: boolean,
  reviewerFilter: Set<string> | undefined,
): boolean {
  if (statuses && !statuses.has(finding.status)) {
    return false;
  }

  if (!includeFalsePositive && finding.status === "false-positive") {
    return false;
  }

  if (reviewerFilter && !reviewerFilter.has(canonicalReviewerName(finding.reviewer))) {
    return false;
  }

  return true;
}

function resolveFindingTokens(finding: MemoryFinding): string[] {
  if (finding.searchable.tokens.length > 0) {
    return finding.searchable.tokens;
  }

  return tokenizeForSimilarity(finding.searchable.redactedText);
}

function uniqueTokens(tokens: string[]): string[] {
  const unique: string[] = [];

  for (const token of tokens) {
    if (!unique.includes(token)) {
      unique.push(token);
    }
  }

  return unique;
}

function jaccardTokenSimilarity(queryTokens: Set<string>, findingTokens: string[]): number {
  if (queryTokens.size === 0 || findingTokens.length === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of findingTokens) {
    if (queryTokens.has(token)) {
      intersection++;
    }
  }

  return intersection / (queryTokens.size + findingTokens.length - intersection);
}

function findMatchedTokens(queryTokens: string[], findingTokens: string[]): string[] {
  const matched: string[] = [];

  for (const token of queryTokens) {
    if (!matched.includes(token) && findingTokens.includes(token)) {
      matched.push(token);
    }
  }

  return matched;
}

function normalizePaths(paths: string[]): string[] {
  const normalized: string[] = [];

  for (const pathValue of paths) {
    const trimmed = pathValue.trim();
    if (trimmed.length > 0) {
      normalized.push(path.normalize(trimmed));
    }
  }

  return normalized;
}

function computePathOverlapRank(finding: MemoryFinding, inputPaths: string[]): number {
  if (inputPaths.length === 0 || finding.locations.length === 0) {
    return 0;
  }

  const inputPathSet = new Set(inputPaths);
  const inputDirSet = new Set(inputPaths.map((inputPath) => path.dirname(inputPath)));
  let sameDirectory = false;

  for (const location of finding.locations) {
    const locationPath = normalizePath(location.path);
    if (!locationPath) {
      continue;
    }

    if (inputPathSet.has(locationPath)) {
      return 2;
    }

    if (inputDirSet.has(path.dirname(locationPath))) {
      sameDirectory = true;
    }
  }

  return sameDirectory ? 1 : 0;
}

function normalizePath(pathValue: string): string | undefined {
  const trimmed = pathValue.trim();

  return trimmed.length > 0 ? path.normalize(trimmed) : undefined;
}

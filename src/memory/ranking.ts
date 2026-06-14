import { compareSeverity } from "../shared/severity.js";
import type { MemoryFinding } from "./schema.js";
import type { MemorySearchHit } from "./search.js";

export interface RankMemoryInput {
  hits: MemorySearchHit[];
  reviewer?: string;
  includeReviewers?: string[];
  includeFixedAsRegressionCandidates?: boolean;
}

export interface RankedMemoryHit extends MemorySearchHit {
  regressionCandidate: boolean;
}

const REVIEWER_ALIAS_PREFIX = "omre-reviewer-";

const STATUS_RANK: Record<MemoryFinding["status"], number> = {
  open: 5,
  confirmed: 4,
  fixed: 3,
  ignored: 2,
  stale: 1,
  "false-positive": 0,
};

export function rankMemoryHits(input: RankMemoryInput): RankedMemoryHit[] {
  const targetReviewers = buildReviewerSet(input.reviewer, input.includeReviewers);

  return input.hits
    .map((hit) => ({
      ...hit,
      regressionCandidate: isRegressionCandidate(hit, input.includeFixedAsRegressionCandidates),
    }))
    .sort((left, right) => compareRankedHits(left, right, targetReviewers));
}

function isRegressionCandidate(
  hit: MemorySearchHit,
  includeFixedAsRegressionCandidates: boolean | undefined,
): boolean {
  return includeFixedAsRegressionCandidates !== false && hit.finding.status === "fixed";
}

function compareRankedHits(
  left: RankedMemoryHit,
  right: RankedMemoryHit,
  targetReviewers: Set<string>,
): number {
  return firstNonZero([
    compareBooleanDescending(left.regressionCandidate, right.regressionCandidate),
    compareSeverity(left.finding.severity, right.finding.severity),
    compareNumberDescending(statusRank(left.finding.status), statusRank(right.finding.status)),
    compareNumberDescending(left.pathOverlapRank, right.pathOverlapRank),
    compareNumberDescending(reviewerRank(left.finding.reviewer, targetReviewers), reviewerRank(right.finding.reviewer, targetReviewers)),
    compareNumberDescending(left.keywordScore, right.keywordScore),
    compareNumberDescending(Date.parse(left.finding.occurrence.lastSeenAt), Date.parse(right.finding.occurrence.lastSeenAt)),
    compareStringAscending(left.finding.id, right.finding.id),
  ]);
}

function statusRank(status: MemoryFinding["status"]): number {
  return STATUS_RANK[status];
}

function reviewerRank(reviewer: string, targetReviewers: Set<string>): number {
  if (targetReviewers.size === 0) {
    return 0;
  }

  return reviewerAliases(reviewer).some((alias) => targetReviewers.has(alias)) ? 1 : 0;
}

function buildReviewerSet(reviewer: string | undefined, includeReviewers: string[] | undefined): Set<string> {
  const reviewers = [reviewer, ...(includeReviewers ?? [])];
  const aliases = reviewers.flatMap((value) => (value === undefined ? [] : reviewerAliases(value)));
  return new Set(aliases);
}

function reviewerAliases(reviewer: string): string[] {
  if (reviewer.startsWith(REVIEWER_ALIAS_PREFIX)) {
    return [reviewer, reviewer.slice(REVIEWER_ALIAS_PREFIX.length)];
  }

  return [reviewer, `${REVIEWER_ALIAS_PREFIX}${reviewer}`];
}

function compareBooleanDescending(left: boolean, right: boolean): number {
  return compareNumberDescending(Number(left), Number(right));
}

function compareNumberDescending(left: number, right: number): number {
  return right - left;
}

function compareStringAscending(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function firstNonZero(values: number[]): number {
  return values.find((value) => value !== 0) ?? 0;
}

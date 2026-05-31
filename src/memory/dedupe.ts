import { nextEventId, type EventBatchContext } from "./events.js";
import { jaccardSimilarity } from "./similarity.js";
import { normalizeMemoryStatus } from "./schema.js";
import type { MemoryEvent, MemoryFinding } from "./schema.js";

export interface DeduplicateContext {
  runId: string;
  batchCtx: EventBatchContext;
}

export interface DeduplicateThresholds {
  fingerprintMerge: number;
  samePathProblem: number;
  crossPathRelated: number;
}

export interface DeduplicateResult {
  events: MemoryEvent[];
  findings: MemoryFinding[];
}

type MatchReason = "fingerprint-exact" | "title-similar" | "problem-similar-same-path";

interface SeenAgainMatch {
  finding: MemoryFinding;
  matchedBy: MatchReason;
}

export function deduplicateAndGenerateEvents(
  newFindings: MemoryFinding[],
  existingFindings: MemoryFinding[],
  ctx: DeduplicateContext,
  thresholds: DeduplicateThresholds,
): DeduplicateResult {
  const events: MemoryEvent[] = [];
  const findings = [...existingFindings];

  for (const finding of newFindings) {
    const seenAgainMatch = findSeenAgainMatch(finding, findings, thresholds);
    if (seenAgainMatch) {
      emitSeenAgainEvents(events, seenAgainMatch.finding, finding, seenAgainMatch.matchedBy, ctx);
      continue;
    }

    const relatedFinding = findRelatedFinding(finding, findings, thresholds.crossPathRelated);
    if (relatedFinding) {
      events.push({
        type: "finding.discovered",
        eventId: nextEventId(ctx.batchCtx),
        at: new Date().toISOString(),
        finding,
      });
      findings.push(finding);
      events.push({
        type: "finding.related",
        eventId: nextEventId(ctx.batchCtx),
        at: new Date().toISOString(),
        findingId: finding.id,
        relatedFindingId: relatedFinding.id,
        relationType: "similar-cross-path",
      });
      continue;
    }

    events.push({
      type: "finding.discovered",
      eventId: nextEventId(ctx.batchCtx),
      at: new Date().toISOString(),
      finding,
    });
    findings.push(finding);
  }

  return { events, findings };
}

function findSeenAgainMatch(
  finding: MemoryFinding,
  candidates: MemoryFinding[],
  thresholds: DeduplicateThresholds,
): SeenAgainMatch | null {
  const fingerprintMatch = candidates.find((candidate) => candidate.fingerprint === finding.fingerprint);
  if (fingerprintMatch) {
    return { finding: fingerprintMatch, matchedBy: "fingerprint-exact" };
  }

  const titleMatch = candidates.find(
    (candidate) => hasSameReviewerCategoryPath(finding, candidate)
      && jaccardSimilarity(finding.title, candidate.title) >= thresholds.fingerprintMerge,
  );
  if (titleMatch) {
    return { finding: titleMatch, matchedBy: "title-similar" };
  }

  const problemMatch = candidates.find(
    (candidate) => hasSameReviewerCategoryPath(finding, candidate)
      && jaccardSimilarity(finding.problem, candidate.problem) >= thresholds.samePathProblem,
  );
  if (problemMatch) {
    return { finding: problemMatch, matchedBy: "problem-similar-same-path" };
  }

  return null;
}

function emitSeenAgainEvents(
  events: MemoryEvent[],
  matchedFinding: MemoryFinding,
  incomingFinding: MemoryFinding,
  matchedBy: MatchReason,
  ctx: DeduplicateContext,
): void {
  events.push({
    type: "finding.seen_again",
    eventId: nextEventId(ctx.batchCtx),
    at: new Date().toISOString(),
    findingId: matchedFinding.id,
    runId: ctx.runId,
    sourcePath: incomingFinding.origin.sourcePath,
    matchedBy,
  });

  if (normalizeMemoryStatus(matchedFinding.status) === "fixed") {
    events.push({
      type: "finding.regressed",
      eventId: nextEventId(ctx.batchCtx),
      at: new Date().toISOString(),
      findingId: matchedFinding.id,
      fromStatus: "fixed",
      toStatus: "open",
      runId: ctx.runId,
    });
  }
}

function findRelatedFinding(
  finding: MemoryFinding,
  candidates: MemoryFinding[],
  threshold: number,
): MemoryFinding | null {
  return candidates.find(
    (candidate) => primaryPath(candidate) !== primaryPath(finding)
      && jaccardSimilarity(finding.problem, candidate.problem) >= threshold,
  ) ?? null;
}

function hasSameReviewerCategoryPath(left: MemoryFinding, right: MemoryFinding): boolean {
  return left.reviewer === right.reviewer
    && left.category === right.category
    && primaryPath(left) === primaryPath(right);
}

function primaryPath(finding: MemoryFinding): string {
  return finding.locations[0]?.path ?? "";
}

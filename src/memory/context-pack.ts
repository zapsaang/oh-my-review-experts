import type { RankedMemoryHit } from "./ranking.js";
import type { RelatedIndex } from "./schema.js";

const DEFAULT_MAX_CONTEXT_ITEMS = 6;
const DEFAULT_MAX_CONTEXT_CHARS = 8_000;

export interface MemoryContextPack {
  text: string;
  includedIds: string[];
  regressionCandidateIds: string[];
  truncated: boolean;
  totalMatched: number;
}

export interface BuildMemoryContextPackOptions {
  maxContextItems?: number;
  maxContextChars?: number;
}

export interface BuildMemoryContextPackInput extends BuildMemoryContextPackOptions {
  hits: RankedMemoryHit[];
  relatedIndex?: RelatedIndex;
}

export function encodeUntrustedMemoryField(value: string): string {
  return JSON.stringify(value);
}

interface NormalizedBuildInput {
  hits: RankedMemoryHit[];
  relatedIndex?: RelatedIndex;
  options: BuildMemoryContextPackOptions;
}

export function buildMemoryContextPack(input: BuildMemoryContextPackInput): MemoryContextPack;
export function buildMemoryContextPack(
  hits: RankedMemoryHit[],
  relatedIndex?: RelatedIndex,
  options?: BuildMemoryContextPackOptions,
): MemoryContextPack;
export function buildMemoryContextPack(
  inputOrHits: BuildMemoryContextPackInput | RankedMemoryHit[],
  relatedIndex?: RelatedIndex,
  options: BuildMemoryContextPackOptions = {},
): MemoryContextPack {
  const input = normalizeInput(inputOrHits, relatedIndex, options);
  const totalMatched = input.hits.length;

  if (totalMatched === 0) {
    return {
      text: "",
      includedIds: [],
      regressionCandidateIds: [],
      truncated: false,
      totalMatched,
    };
  }

  const maxContextItems = normalizeBudget(input.options.maxContextItems, DEFAULT_MAX_CONTEXT_ITEMS);
  const maxContextChars = normalizeBudget(input.options.maxContextChars, DEFAULT_MAX_CONTEXT_CHARS);
  const itemLimitedHits = input.hits.slice(0, maxContextItems);
  const itemBudgetTruncated = itemLimitedHits.length < totalMatched;
  const includedHits: RankedMemoryHit[] = [];
  let renderedHitsLength = 0;

  for (const hit of itemLimitedHits) {
    const candidateIncludedCount = includedHits.length + 1;
    const candidateTruncated = itemBudgetTruncated || candidateIncludedCount < itemLimitedHits.length;
    const renderedHitLength = renderHit(hit, input.relatedIndex).join("\n").length;
    const candidateRenderedHitsLength = renderedHitsLength
      + (includedHits.length > 0 ? 1 : 0)
      + renderedHitLength;
    const candidateHeader = `Memory Context Pack (totalMatched=${totalMatched}, included=${candidateIncludedCount}, truncated=${candidateTruncated})`;
    const candidateTextLength = candidateHeader.length + 1 + candidateRenderedHitsLength;

    if (candidateTextLength > maxContextChars) {
      break;
    }

    includedHits.push(hit);
    renderedHitsLength = candidateRenderedHitsLength;
  }

  const charBudgetTruncated = includedHits.length < itemLimitedHits.length;
  const truncated = itemBudgetTruncated || charBudgetTruncated;
  const text = renderWithinBudget(includedHits, input.relatedIndex, totalMatched, truncated, maxContextChars);
  const includedIds = includedHits.map((hit) => hit.finding.id);

  return {
    text,
    includedIds,
    regressionCandidateIds: includedHits
      .filter((hit) => hit.regressionCandidate)
      .map((hit) => hit.finding.id),
    truncated,
    totalMatched,
  };
}

function normalizeInput(
  inputOrHits: BuildMemoryContextPackInput | RankedMemoryHit[],
  relatedIndex: RelatedIndex | undefined,
  options: BuildMemoryContextPackOptions,
): NormalizedBuildInput {
  if (Array.isArray(inputOrHits)) {
    return { hits: inputOrHits, relatedIndex, options };
  }

  return {
    hits: inputOrHits.hits,
    relatedIndex: inputOrHits.relatedIndex,
    options: {
      maxContextItems: inputOrHits.maxContextItems,
      maxContextChars: inputOrHits.maxContextChars,
    },
  };
}

function normalizeBudget(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.floor(value);
}

function renderWithinBudget(
  hits: RankedMemoryHit[],
  relatedIndex: RelatedIndex | undefined,
  totalMatched: number,
  truncated: boolean,
  maxContextChars: number,
): string {
  const text = renderContextPackText(hits, relatedIndex, totalMatched, truncated);

  if (text.length <= maxContextChars) {
    return text;
  }

  return "";
}

function renderContextPackText(
  hits: RankedMemoryHit[],
  relatedIndex: RelatedIndex | undefined,
  totalMatched: number,
  truncated: boolean,
): string {
  const lines = [
    `Memory Context Pack (totalMatched=${totalMatched}, included=${hits.length}, truncated=${truncated})`,
  ];

  for (const hit of hits) {
    lines.push(...renderHit(hit, relatedIndex));
  }

  return lines.join("\n");
}

function renderHit(hit: RankedMemoryHit, relatedIndex: RelatedIndex | undefined): string[] {
  const finding = hit.finding;

  return [
    "--- memory item ---",
    `memory id: ${finding.id}`,
    `reviewer: ${encodeUntrustedMemoryField(finding.reviewer)}`,
    `severity: ${finding.severity}`,
    `status: ${finding.status}`,
    `title: ${encodeUntrustedMemoryField(finding.title)}`,
    `primary paths: ${formatPrimaryPaths(finding.locations)}`,
    `lastSeenAt: ${finding.occurrence.lastSeenAt}`,
    `occurrence count: ${finding.occurrence.count}`,
    `safe summary: ${formatSafeSummary(finding.searchable.redactedText)}`,
    `regressionCandidate: ${hit.regressionCandidate}`,
    `related memory IDs: ${formatRelatedMemoryIds(finding.id, relatedIndex)}`,
  ];
}

function formatPrimaryPaths(locations: RankedMemoryHit["finding"]["locations"]): string {
  const paths: string[] = [];

  for (const location of locations) {
    const path = encodeUntrustedMemoryField(location.path);
    if (location.path.length > 0 && !paths.includes(path)) {
      paths.push(path);
    }
  }

  return paths.length > 0 ? paths.join(", ") : "(none)";
}

function formatSafeSummary(redactedText: string): string {
  const summary = encodeUntrustedMemoryField(redactedText);

  return redactedText.length > 0 ? summary : "(none)";
}

function formatRelatedMemoryIds(findingId: string, relatedIndex: RelatedIndex | undefined): string {
  const relations = relatedIndex?.byFindingId[findingId] ?? [];

  if (relations.length === 0) {
    return "(none)";
  }

  return relations
    .map((relation) => {
      const relatedFindingId = encodeUntrustedMemoryField(relation.relatedFindingId);
      const relationType = encodeUntrustedMemoryField(relation.relationType);

      return `${relatedFindingId} (${relationType})`;
    })
    .join(", ");
}

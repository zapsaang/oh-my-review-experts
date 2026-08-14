import path from "node:path";
import type { OmreConfig, ReviewDimensionType } from "../config/schema.js";
import type { MemoryContextPack } from "../memory/context-pack.js";
import { resolveMemoryPaths } from "../memory/paths.js";
import { retrieveMemoryContext } from "../memory/pipeline.js";
import { readMaterializedState } from "../memory/store.js";
import { REVIEW_MEMORY_CONTRACT } from "../agents/prompts.js";
import type { EstimatedPlan } from "./types.js";

const MAX_REVIEW_MEMORY_CONTEXT_LENGTH = 15_000;
const REVIEW_MEMORY_TRUNCATED_MARKER = `[TRUNCATED: Review memory context exceeded ${MAX_REVIEW_MEMORY_CONTEXT_LENGTH} characters; remaining memory sections omitted.]`;

export interface MemoryFlags {
  isWithMemory: boolean;
  isNoMemory: boolean;
}

export interface ReviewMemorySectionPreview {
  reviewer: ReviewDimensionType;
  sliceId: string;
  text: string;
  sectionChars: number;
  allowedMemoryIds: string[];
  regressionCandidateIds: string[];
  totalMatched: number;
}

export interface ReviewMemorySectionCollection {
  attempted: boolean;
  sections: ReviewMemorySectionPreview[];
  truncated: boolean;
}

export function buildPerReviewerMemorySection(
  reviewer: ReviewDimensionType,
  sliceId: string,
  contextPack: MemoryContextPack,
): string {
  return [
    `--- MEMORY CONTEXT FOR ${reviewer} ON ${sliceId} START ---`,
    `reviewer: ${reviewer}`,
    `slice: ${sliceId}`,
    `allowedMemoryIds: ${JSON.stringify(contextPack.includedIds)}`,
    `regressionCandidateIds: ${JSON.stringify(contextPack.regressionCandidateIds)}`,
    "",
    "context:",
    contextPack.text,
    `--- MEMORY CONTEXT FOR ${reviewer} ON ${sliceId} END ---`,
  ].join("\n");
}

export function shouldAttemptMemoryRetrieval(config: OmreConfig, flags: MemoryFlags): boolean {
  return config.memory.enabled
    && (config.memory.retrieval.enabled || flags.isWithMemory)
    && !flags.isNoMemory;
}

export function renderReviewMemoryContextHeader(): string {
  return [
    "## Review Memory Context",
    "",
    REVIEW_MEMORY_CONTRACT.trim(),
  ].join("\n");
}

import type { OmreLogger } from "../memory/logger.js";

export function collectReviewMemorySections(
  cwd: string,
  config: OmreConfig,
  plan: EstimatedPlan,
  diffSummary: string,
  userGuidance: string,
  flags: MemoryFlags,
  logger?: OmreLogger,
): ReviewMemorySectionCollection {
  if (!shouldAttemptMemoryRetrieval(config, flags)) {
    return { attempted: false, sections: [], truncated: false };
  }

  const repoRoot = path.resolve(cwd);
  const sections: ReviewMemorySectionPreview[] = [];
  const markerReserve = `\n\n${REVIEW_MEMORY_TRUNCATED_MARKER}`.length;
  let currentLength = renderReviewMemoryContextHeader().length;
  let truncated = false;

  for (const slice of plan.slices) {
    const reviewers = plan.selectedReviewers[slice.slice_id] ?? [];
    for (const reviewer of reviewers) {
      const contextPack = retrieveMemoryContext({
        repoRoot,
        reviewer,
        slicePaths: slice.files,
        diffSummary,
        userGuidance,
        memoryConfig: config.memory,
        withMemory: flags.isWithMemory,
        noMemory: flags.isNoMemory,
        logger,
      });

      if (contextPack === undefined || contextPack.includedIds.length === 0 || contextPack.text.trim().length === 0) {
        continue;
      }

      // encodeUntrustedMemoryField() already JSON-encodes each untrusted memory field,
      // neutralizing structural delimiters at the field level. The fixed START/END
      // wrapper added by buildPerReviewerMemorySection therefore needs no extra
      // delimiter neutralization.
      let text = buildPerReviewerMemorySection(reviewer, slice.slice_id, contextPack);
      let additionLength = `\n\n${text}`.length;
      if (currentLength + additionLength > MAX_REVIEW_MEMORY_CONTEXT_LENGTH - markerReserve) {
        const maxSectionLength = MAX_REVIEW_MEMORY_CONTEXT_LENGTH - markerReserve - currentLength - "\n\n".length;
        const truncatedText = truncateMemorySectionToLength(reviewer, slice.slice_id, contextPack, maxSectionLength);
        if (truncatedText === undefined) {
          truncated = true;
          break;
        }

        text = truncatedText;
        additionLength = `\n\n${text}`.length;
        truncated = true;
      }

      currentLength += additionLength;
      sections.push({
        reviewer,
        sliceId: slice.slice_id,
        text,
        sectionChars: text.length,
        allowedMemoryIds: contextPack.includedIds,
        regressionCandidateIds: contextPack.regressionCandidateIds,
        totalMatched: contextPack.totalMatched,
      });

      if (truncated) {
        break;
      }
    }
    if (truncated) {
      break;
    }
  }

  return { attempted: true, sections, truncated };
}

export function truncateMemorySectionToLength(
  reviewer: ReviewDimensionType,
  sliceId: string,
  contextPack: MemoryContextPack,
  maxSectionLength: number,
): string | undefined {
  const emptySection = buildPerReviewerMemorySection(reviewer, sliceId, { ...contextPack, text: "" });
  const availableContextLength = maxSectionLength - emptySection.length - REVIEW_MEMORY_TRUNCATED_MARKER.length - 1;
  if (availableContextLength <= 0) {
    return undefined;
  }

  const truncatedPack: MemoryContextPack = {
    ...contextPack,
    text: `${contextPack.text.slice(0, availableContextLength)}\n${REVIEW_MEMORY_TRUNCATED_MARKER}`,
  };
  const truncatedSection = buildPerReviewerMemorySection(reviewer, sliceId, truncatedPack);

  return truncatedSection.length <= maxSectionLength ? truncatedSection : undefined;
}

export function renderReviewMemoryContext(collection: ReviewMemorySectionCollection): string {
  if (collection.sections.length === 0) {
    return "";
  }

  const chunks = [
    renderReviewMemoryContextHeader(),
    ...collection.sections.map((section) => section.text),
  ];

  if (collection.truncated) {
    chunks.push(REVIEW_MEMORY_TRUNCATED_MARKER);
  }

  return chunks.join("\n\n");
}

export function hasMaterializedMemoryState(cwd: string, config: OmreConfig): boolean {
  try {
    const paths = resolveMemoryPaths(path.resolve(cwd), config.memory.directory);
    return readMaterializedState(paths) !== null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function renderMemoryDryRunPreview(collection: ReviewMemorySectionCollection, hasMemoryState: boolean): string {
  if (!collection.attempted) {
    return "";
  }

  if (collection.sections.length === 0) {
    return hasMemoryState
      ? "Memory retrieval preview: no matching memories found"
      : "Memory retrieval preview: no memory state found";
  }

  const lines = ["Memory retrieval preview"];
  for (const section of collection.sections) {
    lines.push(
      `  slice: ${section.sliceId}`,
      `  reviewer: ${section.reviewer}`,
      `  matched memories: ${section.allowedMemoryIds.length}/${section.totalMatched}`,
      `  section chars: ${section.sectionChars}`,
      section.text,
    );
  }

  if (collection.truncated) {
    lines.push(REVIEW_MEMORY_TRUNCATED_MARKER);
  }

  return lines.join("\n");
}

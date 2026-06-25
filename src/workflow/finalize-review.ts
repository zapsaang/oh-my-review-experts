import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { writeReport, type DegradedSlice } from "../tools/report.js";
import { assertSafePath } from "../tools/fs-utils.js";
import { runIndexLatest } from "../memory/indexing.js";
import { checkAutoCompactThreshold } from "../memory/pipeline.js";
import { readRunMeta } from "./run-meta.js";
import {
  HANDOFF_FILENAME_PATTERN,
  mergeHandoffs,
  parseHandoffFile,
  type MergedResult,
  type ParsedHandoff,
} from "./finalize-handoff-parse.js";
import {
  buildReportJson,
  renderMarkdownReport,
} from "./finalize-report-render.js";

/**
 * Server-side report finalization for the review-code workflow.
 *
 * Reads every reviewer handoff under `.omre/handoffs/{runId}/`, merges them
 * deterministically into a single review report, and persists the result via
 * `writeReport`. This is the destination of the `omre_finalize_review` plugin
 * tool: the omre-report-writer subagent calls the tool with a runId, and this
 * module assembles canonical Markdown and JSON from the handoff files —
 * keeping report assembly out of LLM hands while still reusing the existing
 * `writeReport` validation, atomic-write, and history pipeline.
 */

import { resolveLogger, type OmreLogger } from "../memory/logger.js";

export interface FinalizeReviewInput {
  runId: string;
  cwd: string;
  withMemory?: boolean;
  output?: OmreLogger;
}

export interface FinalizeReviewResult {
  written: string[];
  handoffsConsumed: number;
  degradedSlices: DegradedSlice[];
  missingDimensionsGlobal: string[];
  memoryIndexResult?: {
    success: boolean;
    error?: string;
  };
}

function summarizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}

export function finalizeReview(input: FinalizeReviewInput): FinalizeReviewResult {
  const output = resolveLogger(input.output);
  const config = loadConfig(input.cwd);

  const resolvedCwd = path.resolve(input.cwd);
  const handoffBase = path.resolve(resolvedCwd, config.handoff.directory);
  const handoffDir = path.resolve(handoffBase, input.runId);

  assertSafePath(handoffDir, handoffBase, "finalizeReview.handoffDir");

  if (!fs.existsSync(handoffDir)) {
    throw new Error(
      `finalizeReview: handoff directory does not exist for runId "${input.runId}" (looked under ${path.relative(resolvedCwd, handoffDir) || handoffDir})`,
    );
  }

  const stat = fs.statSync(handoffDir);
  if (!stat.isDirectory()) {
    throw new Error(`finalizeReview: handoff path is not a directory: ${handoffDir}`);
  }

  const entries = fs.readdirSync(handoffDir);
  const handoffFiles = entries.filter((entry) => HANDOFF_FILENAME_PATTERN.test(entry)).sort();
  if (handoffFiles.length === 0) {
    throw new Error(
      `finalizeReview: no handoff files found in ${path.relative(resolvedCwd, handoffDir) || handoffDir} for runId "${input.runId}"`,
    );
  }

  const parsed: ParsedHandoff[] = [];
  for (const filename of handoffFiles) {
    const filePath = path.join(handoffDir, filename);
    const lstat = fs.lstatSync(filePath);
    if (!lstat.isFile() || lstat.isSymbolicLink()) continue;
    parsed.push(parseHandoffFile(filePath, filename));
  }

  const merged: MergedResult = mergeHandoffs(parsed);
  const marker = readRunMeta(handoffDir);
  const withMemoryResolved = input.withMemory ?? marker?.withMemory ?? false;
  const noMemoryResolved = marker?.noMemory ?? false;
  const retrievalActive = config.memory.enabled && (config.memory.retrieval.enabled || withMemoryResolved) && !noMemoryResolved;
  const markdown = renderMarkdownReport(merged, input.runId, retrievalActive);
  const json = buildReportJson(merged, input.runId);

  const written = writeReport(
    config,
    {
      target: "current-change",
      markdown,
      json,
      degradedSlices: merged.degradedSlices,
      missingDimensionsGlobal: merged.missingDimensionsGlobal,
      runId: input.runId,
    },
    input.cwd,
  );

  let memoryIndexResult: FinalizeReviewResult["memoryIndexResult"];
  if (config.memory.enabled) {
    if (config.memory.indexing?.autoIndexAfterReview !== false) {
      try {
        runIndexLatest({ cwd: input.cwd, output });
        memoryIndexResult = { success: true };
      } catch (err) {
        memoryIndexResult = {
          success: false,
          error: summarizeError(err),
        };
      }
    }

    const compactCheck = checkAutoCompactThreshold(input.cwd, config.memory, output);
    if (compactCheck.needsCompaction) {
      output.log(`Review memory threshold exceeded (${compactCheck.reason}). Run \`omre memory compact\` to merge segments.`);
    }
  }

  return {
    written,
    handoffsConsumed: merged.handoffs.length,
    degradedSlices: merged.degradedSlices,
    missingDimensionsGlobal: merged.missingDimensionsGlobal,
    memoryIndexResult,
  };
}

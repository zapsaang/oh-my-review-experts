import { extractFromHandoffs } from "./handoff-extractor.js";
import { extractFromReport } from "./report-extractor.js";
import type { OmreLogger } from "../logger.js";
import type { RawFinding } from "./types.js";

type ExtractSource = "reports" | "handoffs";

const DEFAULT_SOURCES: ExtractSource[] = ["reports", "handoffs"];

export interface ExtractStructuredFindingsInput {
  reportPath?: string;
  handoffDir?: string;
  sources?: ExtractSource[];
  logger?: OmreLogger;
}

export interface ExtractRawFindingsInput {
  reportPath?: string;
  handoffDir?: string;
  sources: ExtractSource[];
  logger?: OmreLogger;
}

export interface StructuredRawFindings {
  report: RawFinding[];
  handoffs: RawFinding[];
}

export function extractRawFindings(input: ExtractRawFindingsInput): RawFinding[] {
  const findings = extractStructuredFindings(input);

  return [...findings.report, ...findings.handoffs];
}

export function extractStructuredFindings(input: ExtractStructuredFindingsInput): StructuredRawFindings {
  const sources = input.sources ?? DEFAULT_SOURCES;

  const report = sources.includes("reports") && input.reportPath !== undefined
    ? extractFromReport(input.reportPath, input.logger)
    : [];

  const handoffs = sources.includes("handoffs") && input.handoffDir !== undefined
    ? extractFromHandoffs(input.handoffDir, input.logger)
    : [];

  return { report, handoffs };
}

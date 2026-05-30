import { extractFromHandoffs } from "./handoff-extractor.js";
import { extractFromReport } from "./report-extractor.js";
import type { RawFinding } from "./types.js";

export interface ExtractRawFindingsInput {
  reportPath?: string;
  handoffDir?: string;
  sources: ("reports" | "handoffs")[];
}

export function extractRawFindings(input: ExtractRawFindingsInput): RawFinding[] {
  const findings: RawFinding[] = [];

  if (input.sources.includes("reports") && input.reportPath !== undefined) {
    findings.push(...extractFromReport(input.reportPath));
  }

  if (input.sources.includes("handoffs") && input.handoffDir !== undefined) {
    findings.push(...extractFromHandoffs(input.handoffDir));
  }

  return findings;
}

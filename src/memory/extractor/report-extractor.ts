import { readFileSync } from "node:fs";
import { MemoryExtractionError, type RawFinding, type RawLocation } from "./types.js";

type JsonObject = Record<string, unknown>;

export function extractFromReport(reportPath: string): RawFinding[] {
  const report = parseReportJson(reportPath);

  if (!isObject(report) || !Array.isArray(report.slices)) {
    console.warn(`Report ${reportPath} has missing or invalid slices; skipping extraction.`);
    return [];
  }

  const rawFindings: RawFinding[] = [];

  for (const slice of report.slices) {
    if (!isObject(slice) || !Array.isArray(slice.findings)) {
      continue;
    }

    const sliceReviewer = reviewerFromSlice(slice);

    for (const finding of slice.findings) {
      if (!isObject(finding)) {
        continue;
      }

      const title = stringValue(finding.title);
      if (title === undefined) {
        continue;
      }

      rawFindings.push(toRawFinding(finding, sliceReviewer, title));
    }
  }

  return rawFindings;
}

function parseReportJson(reportPath: string): unknown {
  const raw = readFileSync(reportPath, "utf-8");

  try {
    return JSON.parse(raw);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new MemoryExtractionError(`Failed to parse JSON report: ${cause.message}`, reportPath, cause);
  }
}

function toRawFinding(finding: JsonObject, sliceReviewer: string, title: string): RawFinding {
  const rawFinding: RawFinding = {
    reviewer: stringValue(finding.source) ?? sliceReviewer,
    severity: stringValue(finding.severity) ?? "unknown",
    category: stringValue(finding.category) ?? stringValue(finding.classification) ?? "unknown",
    title,
    problem: stringValue(finding.description) ?? "",
    locations: locationsFromFinding(finding),
  };

  const evidence = stringValue(finding.evidence);
  if (evidence !== undefined) {
    rawFinding.evidence = evidence;
  }

  const recommendation = stringValue(finding.recommendation);
  if (recommendation !== undefined) {
    rawFinding.recommendation = recommendation;
  }

  return rawFinding;
}

function locationsFromFinding(finding: JsonObject): RawLocation[] {
  const file = stringValue(finding.file);
  if (file === undefined || file === "N/A") {
    return [];
  }

  const location: RawLocation = { path: file };
  if (typeof finding.line === "number" || (typeof finding.line === "string" && finding.line !== "N/A")) {
    location.line = finding.line;
  }

  return [location];
}

function reviewerFromSlice(slice: JsonObject): string {
  return (
    stringValue(slice.source) ??
    stringValue(slice.reviewer) ??
    stringValue(slice.agent) ??
    stringValue(slice.dimension) ??
    stringValue(slice.slice_id) ??
    "unknown"
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import fs from "node:fs";
import path from "node:path";
import type { OmreConfig } from "../config/schema.js";
import { assertSafePath, writeFileAtomic, writeFileAtomicOverwrite, formatTimestamp } from "./fs-utils.js";

export interface DegradedSlice {
  slice_id: string;
  missing_dimensions: string[];
}

export function renderCoverageWarning(degradedSlices: DegradedSlice[], missingDimensionsGlobal: string[]): string {
  const lines: string[] = [];
  lines.push("## Coverage warning");
  lines.push("");
  lines.push("Coverage is degraded for this review. Some dimensions could not be reviewed due to validation failures after retry.");
  lines.push("");

  if (degradedSlices.length > 0) {
    lines.push("### Degraded slices");
    lines.push("");
    for (const slice of degradedSlices) {
      lines.push(`- **${slice.slice_id}**: missing dimensions: ${slice.missing_dimensions.join(", ")}`);
    }
    lines.push("");
  }

  if (missingDimensionsGlobal.length > 0) {
    lines.push("### Missing dimensions globally");
    lines.push("");
    lines.push(`- ${missingDimensionsGlobal.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

export interface ContentValidationResult {
  ok: boolean;
  reason?: "empty" | "too-short" | "too-few-lines" | "no-heading" | "reference-only";
}

const MIN_REPORT_LENGTH = 200;
const MIN_REPORT_LINES = 5;

const REFERENCE_ONLY_PATTERNS: readonly RegExp[] = [
  /^\s*Report persisted to\s+\S+\.?\s*$/i,
  /^\s*Saved to\s+\S+\.?\s*$/i,
  /^\s*See (?:file|report)\s*[:\-]?\s*\S+\.?\s*$/i,
  /^\s*报告(?:已)?(?:保存|写入)(?:到|至)?\s*\S+\.?\s*$/i,
  /^\s*The full report (?:is|can be found) at\s+\S+\.?\s*$/i,
];

export function validateReportMarkdown(md: string): ContentValidationResult {
  const trimmed = md.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }

  for (const pattern of REFERENCE_ONLY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: "reference-only" };
    }
  }

  if (trimmed.length < MIN_REPORT_LENGTH) {
    return { ok: false, reason: "too-short" };
  }

  const nonBlankLines = trimmed.split("\n").filter((line) => line.trim().length > 0).length;
  if (nonBlankLines < MIN_REPORT_LINES) {
    return { ok: false, reason: "too-few-lines" };
  }

  if (!trimmed.startsWith("#")) {
    return { ok: false, reason: "no-heading" };
  }

  return { ok: true };
}

export interface ReportPayload {
  target: string;
  markdown: string;
  json: unknown;
  degradedSlices?: DegradedSlice[];
  missingDimensionsGlobal?: string[];
  runId?: string;
}

export function writeReport(config: OmreConfig, payload: ReportPayload, cwd = process.cwd()) {
  const validation = validateReportMarkdown(payload.markdown);
  if (!validation.ok) {
    throw new Error(`writeReport rejected markdown: reason=${validation.reason}`);
  }

  const resolvedCwd = path.resolve(cwd);
  const dir = path.resolve(resolvedCwd, config.report.directory);
  assertSafePath(dir, resolvedCwd, "report.directory");
  fs.mkdirSync(dir, { recursive: true });

  const hasDegradedSlices = payload.degradedSlices && payload.degradedSlices.length > 0;
  const hasMissingGlobal = payload.missingDimensionsGlobal && payload.missingDimensionsGlobal.length > 0;
  let markdown = payload.markdown;
  if (hasDegradedSlices || hasMissingGlobal) {
    const warning = renderCoverageWarning(
      payload.degradedSlices ?? [],
      payload.missingDimensionsGlobal ?? []
    );
    markdown = warning + "\n\n" + markdown;
    if (markdown.includes("No issues found")) {
      markdown = markdown.replace(/No issues found/g, "No confirmed issues found in covered dimensions");
    }
  }

  const latestMd = path.join(dir, config.report.latestMarkdown);
  const latestJson = path.join(dir, config.report.latestJson);
  writeFileAtomicOverwrite(latestMd, markdown);
  writeFileAtomicOverwrite(latestJson, JSON.stringify(payload.json, null, 2));
  const written = [latestMd, latestJson];
  if (config.report.timestamped) {
    const stamp = payload.runId ?? formatTimestamp();
    const histDir = path.join(dir, "history");
    fs.mkdirSync(histDir, { recursive: true });
    const md = path.join(histDir, `${stamp}-review.md`);
    const js = path.join(histDir, `${stamp}-review.json`);
    assertSafePath(md, histDir, "report.history");
    assertSafePath(js, histDir, "report.history");
    const writtenMd = writeFileAtomic(md, markdown);
    const writtenJs = writeFileAtomic(js, JSON.stringify(payload.json, null, 2));
    written.push(writtenMd, writtenJs);
  }
  return written;
}

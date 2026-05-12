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

export interface ReportPayload {
  target: string;
  markdown: string;
  json: unknown;
  degradedSlices?: DegradedSlice[];
  missingDimensionsGlobal?: string[];
}

export function writeReport(config: OmreConfig, payload: ReportPayload, cwd = process.cwd()) {
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
    const t = formatTimestamp();
    const histDir = path.join(dir, "history");
    fs.mkdirSync(histDir, { recursive: true });
    const md = path.join(histDir, `${t}-review.md`);
    const js = path.join(histDir, `${t}-review.json`);
    const writtenMd = writeFileAtomic(md, markdown);
    const writtenJs = writeFileAtomic(js, JSON.stringify(payload.json, null, 2));
    written.push(writtenMd, writtenJs);
  }
  return written;
}

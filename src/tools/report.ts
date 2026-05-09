import fs from "node:fs";
import path from "node:path";
import type { OmreConfig } from "../config/schema.js";
import { assertSafePath, writeFileAtomic, writeFileAtomicOverwrite, formatTimestamp } from "./fs-utils.js";

export interface ReportPayload {
  target: string;
  markdown: string;
  json: unknown;
}

export function writeReport(config: OmreConfig, payload: ReportPayload, cwd = process.cwd()) {
  const resolvedCwd = path.resolve(cwd);
  const dir = path.resolve(resolvedCwd, config.report.directory);
  assertSafePath(dir, resolvedCwd, "report.directory");
  fs.mkdirSync(dir, { recursive: true });
  const latestMd = path.join(dir, config.report.latestMarkdown);
  const latestJson = path.join(dir, config.report.latestJson);
  writeFileAtomicOverwrite(latestMd, payload.markdown);
  writeFileAtomicOverwrite(latestJson, JSON.stringify(payload.json, null, 2));
  const written = [latestMd, latestJson];
  if (config.report.timestamped) {
    const t = formatTimestamp();
    const histDir = path.join(dir, "history");
    fs.mkdirSync(histDir, { recursive: true });
    const md = path.join(histDir, `${t}-review.md`);
    const js = path.join(histDir, `${t}-review.json`);
    const writtenMd = writeFileAtomic(md, payload.markdown);
    const writtenJs = writeFileAtomic(js, JSON.stringify(payload.json, null, 2));
    written.push(writtenMd, writtenJs);
  }
  return written;
}

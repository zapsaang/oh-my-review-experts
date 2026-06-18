import fs from "node:fs";
import path from "node:path";
import { assertSafePath } from "../tools/fs-utils.js";
import type { MemoryFinding } from "./schema.js";

export interface SuggestionOptions {
  repoRoot: string;
  timeDecayDays?: number;
  skipImportSourceForFileDeletion?: boolean;
  now?: Date;
}

export interface StatusSuggestion {
  findingId: string;
  suggestedStatus: "stale";
  confidence: "high" | "medium";
  triggeredBy: "file-deleted" | "time-decay";
  reason: string;
}

export interface SuggestionsResult {
  suggestions: StatusSuggestion[];
  processedCount: number;
  skippedCount: number;
}

export function generateSuggestions(
  findings: MemoryFinding[],
  options: SuggestionOptions,
): SuggestionsResult {
  const { repoRoot, timeDecayDays = 90, skipImportSourceForFileDeletion = true, now = new Date() } = options;
  const suggestions: StatusSuggestion[] = [];
  let skippedCount = 0;

  for (const finding of findings) {
    if (finding.status !== "open" && finding.status !== "confirmed") {
      skippedCount++;
      continue;
    }

    const fileDeleted = checkFileDeleted(finding, repoRoot, skipImportSourceForFileDeletion);
    if (fileDeleted) {
      suggestions.push(fileDeleted);
      continue;
    }

    const timeDecay = checkTimeDecay(finding, timeDecayDays, now);
    if (timeDecay) {
      suggestions.push(timeDecay);
    }
  }

  return {
    suggestions,
    processedCount: findings.length,
    skippedCount,
  };
}

function checkFileDeleted(
  finding: MemoryFinding,
  repoRoot: string,
  skipImport: boolean,
): StatusSuggestion | null {
  if (skipImport && finding.origin.sourceType === "import") {
    return null;
  }
  if (finding.locations.length === 0) {
    return null;
  }
  let anyExists = false;
  for (const loc of finding.locations) {
    const absPath = path.resolve(repoRoot, loc.path);
    assertSafePath(absPath, repoRoot, "suggestions.fileDeletion");
    if (fs.existsSync(absPath)) {
      anyExists = true;
    }
  }
  if (anyExists) {
    return null;
  }
  return {
    findingId: finding.id,
    suggestedStatus: "stale",
    confidence: "high",
    triggeredBy: "file-deleted",
    reason: `all referenced files deleted: ${finding.locations.map((l) => l.path).join(", ")}`,
  };
}

function checkTimeDecay(
  finding: MemoryFinding,
  timeDecayDays: number,
  now: Date,
): StatusSuggestion | null {
  const lastSeen = new Date(finding.occurrence.lastSeenAt);
  const ageDays = (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60 * 24);
  if (Number.isNaN(ageDays) || ageDays < timeDecayDays) {
    return null;
  }
  return {
    findingId: finding.id,
    suggestedStatus: "stale",
    confidence: "medium",
    triggeredBy: "time-decay",
    reason: `last seen ${Math.floor(ageDays)} days ago (threshold: ${timeDecayDays} days)`,
  };
}

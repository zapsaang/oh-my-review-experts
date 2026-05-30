import { createHash } from "node:crypto";
import type { MemoryFinding } from "./schema.js";
import { tokenizeForSimilarity } from "./similarity.js";

const PROBLEM_KEY_MAX_TOKENS = 32;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

export function simhashLikeKey(text: string, opts: { maxTokens: number }): string {
  const tokens = tokenizeForSimilarity(text).slice(0, opts.maxTokens).sort();

  return sha256(tokens.join("\n")).slice(0, 16);
}

export function buildStrongFingerprint(finding: MemoryFinding): string {
  const primaryLocation = finding.locations[0];
  const parts = [
    "omre-memory-v1",
    finding.reviewer,
    finding.category,
    primaryLocation?.path ?? "",
    normalizeTitleKey(finding.title),
    simhashLikeKey(finding.problem, { maxTokens: PROBLEM_KEY_MAX_TOKENS }),
  ];

  if (typeof primaryLocation?.line === "number") {
    parts.push(`line:${primaryLocation.line}`);
  }

  return sha256(parts.join("\n"));
}

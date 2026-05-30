import { createHash } from "node:crypto";
import { buildStrongFingerprint } from "./fingerprint.js";
import { generateMemoryFindingId } from "./ids.js";
import { resolvePackageIdentity } from "./package-resolver.js";
import type { RedactedRawFinding } from "./redaction.js";
import type { MemoryFinding } from "./schema.js";
import { tokenizeForSimilarity } from "./similarity.js";
import type { SeverityLevel } from "../shared/severity.js";

export interface NormalizeContext {
  runId: string;
  sourceType: "report" | "manual" | "import";
  sourcePath: string;
  createdAt: string;
  repoRoot: string;
  repoRootHash: string;
}

const MAX_TITLE_LENGTH = 240;
const MAX_TEXT_LENGTH = 4_000;
const EVIDENCE_MISSING = "[EVIDENCE_MISSING]";

interface NormalizedText {
  text: string;
  truncated: boolean;
  malformed: boolean;
}

type NormalizedLocation = MemoryFinding["locations"][number];

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function normalizeSeverity(severity: string): SeverityLevel {
  switch (severity.trim().toLowerCase()) {
    case "blocker":
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "info":
    case "low":
      return "low";
    default:
      return "medium";
  }
}

export function normalizeMemoryFinding(raw: RedactedRawFinding, ctx: NormalizeContext): MemoryFinding {
  const reviewer = normalizeRequiredText(raw.reviewer, "[REVIEWER_MISSING]");
  const category = normalizeRequiredText(raw.category, "[CATEGORY_MISSING]");
  const title = normalizeRequiredText(raw.title, "[TITLE_MISSING]", MAX_TITLE_LENGTH);
  const problem = normalizeRequiredText(raw.problem, "[PROBLEM_MISSING]", MAX_TEXT_LENGTH);
  const evidence = normalizeEvidence(raw.evidence);
  const recommendation = normalizeOptionalText(raw.recommendation, MAX_TEXT_LENGTH);
  const locations = raw.locations.slice(0, 16).map(normalizeLocation);
  const primaryLocationPath = locations[0]?.path ?? ctx.repoRoot;
  const packageIdentity = resolvePackageIdentity(primaryLocationPath, ctx.repoRoot);
  const sourceMalformed = reviewer.malformed || category.malformed || title.malformed || problem.malformed || evidence.malformed;

  const contentHash = sha256(JSON.stringify({
    reviewer: reviewer.text,
    category: category.text,
    title: title.text,
    problem: problem.text,
    paths: locations.map((location) => location.path),
  }));

  const finding: MemoryFinding = {
    schemaVersion: 1,
    id: generateMemoryFindingId(),
    fingerprint: "pending-fingerprint",
    repo: {
      rootHash: ctx.repoRootHash,
      packagePath: packageIdentity.packagePath,
    },
    origin: {
      runId: ctx.runId,
      sourceType: ctx.sourceType,
      sourcePath: ctx.sourcePath,
      createdAt: ctx.createdAt,
    },
    reviewer: reviewer.text,
    severity: normalizeSeverity(raw.severity),
    status: evidence.malformed ? "acknowledged" : "open",
    category: category.text,
    title: title.text,
    problem: problem.text,
    evidence: evidence.text,
    locations,
    occurrence: {
      firstSeenAt: ctx.createdAt,
      lastSeenAt: ctx.createdAt,
      count: 1,
      runIds: [ctx.runId],
    },
    searchable: {
      redactedText: buildSearchableText(title.text, problem.text, evidence.text, recommendation.text, locations),
      tokens: tokenizeForSimilarity(`${title.text} ${problem.text} ${evidence.text}`),
    },
    metadata: {
      evidenceTruncated: evidence.truncated,
      problemTruncated: problem.truncated,
      recommendationTruncated: recommendation.truncated,
      sourceMalformed,
    },
    contentHash,
  };

  finding.fingerprint = buildStrongFingerprint(finding);
  return finding;
}

function normalizeRequiredText(value: string, fallback: string, maxLength = Number.POSITIVE_INFINITY): NormalizedText {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { text: fallback, truncated: false, malformed: true };
  }

  return truncateText(trimmed, maxLength);
}

function normalizeEvidence(value: string | undefined): NormalizedText {
  if (value === undefined || value.trim().length === 0) {
    return { text: EVIDENCE_MISSING, truncated: false, malformed: true };
  }

  return truncateText(value.trim(), MAX_TEXT_LENGTH);
}

function normalizeOptionalText(value: string | undefined, maxLength: number): NormalizedText {
  if (value === undefined || value.trim().length === 0) {
    return { text: "", truncated: false, malformed: false };
  }

  const trimmed = value.trim();
  return {
    text: trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed,
    truncated: value.length > maxLength || trimmed.length > maxLength,
    malformed: false,
  };
}

function truncateText(value: string, maxLength: number): NormalizedText {
  if (value.length <= maxLength) {
    return { text: value, truncated: false, malformed: false };
  }

  return { text: value.slice(0, maxLength), truncated: true, malformed: false };
}

function normalizeLocation(location: RedactedRawFinding["locations"][number]): NormalizedLocation {
  const normalized: NormalizedLocation = { path: location.path };
  const line = normalizeLine(location.line);

  if (line !== undefined) {
    normalized.line = line;
  }

  return normalized;
}

function normalizeLine(line: number | string | undefined): number | string | undefined {
  if (typeof line === "number") {
    return Number.isFinite(line) ? line : undefined;
  }

  if (typeof line !== "string") {
    return undefined;
  }

  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed;
}

function buildSearchableText(
  title: string,
  problem: string,
  evidence: string,
  recommendation: string,
  locations: NormalizedLocation[],
): string {
  return [
    title,
    problem,
    evidence,
    recommendation,
    ...locations.map((location) => location.path),
  ].filter((part) => part.length > 0).join("\n");
}

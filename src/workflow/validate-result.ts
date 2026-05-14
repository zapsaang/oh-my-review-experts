import fs from "node:fs";
import { z } from "zod";
import {
  CONCURRENCY_CLASSIFICATION_VALUES,
  CONFIDENCE_VALUES,
  PERFORMANCE_CLASSIFICATION_VALUES,
  SCHEMA_VERSION,
  SEVERITY_VALUES,
  type ConcurrencyClassification,
  type PerformanceClassification,
} from "../agents/schemas.js";
import { parseHandoffJsonHeader } from "../tools/handoff.js";

export const ReviewerFindingSchema = z.object({
  id: z.string(),
  severity: z.enum(SEVERITY_VALUES),
  file: z.string().default("N/A"),
  line: z.union([z.number(), z.string()]).default("N/A"),
  title: z.string(),
  description: z.string(),
  evidence: z.string(),
  confidence: z.enum(CONFIDENCE_VALUES),
  classification: z.string(),
});

export const ReviewerHandoffSchema = z.object({
  schema_version: z.string(),
  task_id: z.string(),
  agent: z.string(),
  dimension: z.string(),
  status: z.enum(["completed", "blocked"]),
  target: z.object({ kind: z.string(), value: z.string() }),
  slice_id: z.string(),
  findings: z.array(z.unknown()),
  meta: z.object({ total_findings: z.number(), notes: z.string() }),
});

export const NormalizedReviewerHandoffSchema = ReviewerHandoffSchema.extend({
  findings: z.array(ReviewerFindingSchema),
});

export type ReviewerFinding = z.infer<typeof ReviewerFindingSchema>;
export type ReviewerHandoff = z.infer<typeof NormalizedReviewerHandoffSchema>;

export interface ValidationResult {
  valid: boolean;
  failureReason?: string;
}

export interface ExpectedValues {
  dimension?: string;
  target?: { kind: string; value: string };
  sliceId?: string;
}

export type FailureReason =
  | "missing-output"
  | "invalid-json"
  | "partial-output"
  | "wrong-dimension"
  | "wrong-target"
  | "wrong-slice"
  | "invalid-schema"
  | "prose-outside-json"
  | "missing-fence";

export type ValidationOutcome =
  | { isValid: true; normalized: ReviewerHandoff }
  | { isValid: false; failureReason: FailureReason; retryRecommended: boolean };

export function validateSchemaVersion(parsed: unknown): ValidationResult {
  if (typeof parsed !== "object" || parsed === null) {
    return { valid: true };
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.schema_version;
  if (version === undefined) {
    return { valid: true };
  }
  if (version !== SCHEMA_VERSION) {
    return { valid: false, failureReason: "schema-version-mismatch" };
  }
  return { valid: true };
}

function isRetryRecommended(reason: FailureReason): boolean {
  switch (reason) {
    case "missing-output":
    case "invalid-json":
    case "partial-output":
    case "missing-fence":
      return true;
    default:
      return false;
  }
}

function hasProseOutsideJson(content: string): boolean {
  const stripped = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const normalized = stripped.replace(/\r\n/g, "\n");
  const trimmed = normalized.trimStart();

  const fenceIndex = trimmed.indexOf("```json");
  if (fenceIndex > 0) {
    const beforeFence = trimmed.slice(0, fenceIndex).trim();
    if (beforeFence.length > 0) {
      return true;
    }
  }

  return false;
}

function isValidClassificationForDimension(value: string, dimension: string): boolean {
  if (dimension === "performance") {
    return PERFORMANCE_CLASSIFICATION_VALUES.includes(value as PerformanceClassification);
  }
  if (dimension === "concurrency") {
    return CONCURRENCY_CLASSIFICATION_VALUES.includes(value as ConcurrencyClassification);
  }
  return true;
}

function validateFindings(findings: unknown[], dimension: string): { valid: boolean; partial: boolean } {
  let hasValid = false;
  let hasInvalid = false;

  for (const finding of findings) {
    const result = ReviewerFindingSchema.safeParse(finding);
    if (result.success && isValidClassificationForDimension(result.data.classification, dimension)) {
      hasValid = true;
    } else {
      hasInvalid = true;
    }
  }

  if (hasInvalid && hasValid) {
    return { valid: false, partial: true };
  }
  if (hasInvalid && !hasValid) {
    return { valid: false, partial: false };
  }
  return { valid: true, partial: false };
}

function validateSchemaShape(data: unknown): { valid: boolean; partial: boolean; reason?: string } {
  const topLevelResult = ReviewerHandoffSchema.safeParse(data);
  if (!topLevelResult.success) {
    return { valid: false, partial: false, reason: "invalid-schema" };
  }

  const validated = topLevelResult.data;
  const findingsResult = validateFindings(validated.findings, validated.dimension);
  if (!findingsResult.valid) {
    return {
      valid: false,
      partial: findingsResult.partial,
      reason: findingsResult.partial ? "partial-output" : "invalid-schema",
    };
  }

  return { valid: true, partial: false };
}

function normalizeHandoff(data: unknown): ReviewerHandoff {
  return NormalizedReviewerHandoffSchema.parse(data);
}

export function validateReviewerHandoff(filePath: string, expected?: ExpectedValues): ValidationOutcome {
  if (!fs.existsSync(filePath)) {
    return { isValid: false, failureReason: "missing-output", retryRecommended: true };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { isValid: false, failureReason: "missing-output", retryRecommended: true };
  }

  if (hasProseOutsideJson(content)) {
    return { isValid: false, failureReason: "prose-outside-json", retryRecommended: false };
  }

  const parseResult = parseHandoffJsonHeader(content);

  if (!parseResult.success) {
    const error = parseResult.error ?? "";
    if (error.includes("JSON header missing") || error.includes("JSON header malformed") || error.includes("JSON header empty")) {
      return { isValid: false, failureReason: "missing-fence", retryRecommended: true };
    }
    if (error.includes("JSON parse error")) {
      return { isValid: false, failureReason: "invalid-json", retryRecommended: true };
    }
    return { isValid: false, failureReason: "invalid-json", retryRecommended: true };
  }

  const versionResult = validateSchemaVersion(parseResult.data);
  if (!versionResult.valid) {
    return { isValid: false, failureReason: "invalid-schema", retryRecommended: false };
  }

  const shapeCheck = validateSchemaShape(parseResult.data);
  if (!shapeCheck.valid) {
    const reason = shapeCheck.partial ? "partial-output" : (shapeCheck.reason as FailureReason);
    return { isValid: false, failureReason: reason, retryRecommended: isRetryRecommended(reason) };
  }

  const normalized = normalizeHandoff(parseResult.data);

  if (expected) {
    if (expected.dimension !== undefined && normalized.dimension !== expected.dimension) {
      return { isValid: false, failureReason: "wrong-dimension", retryRecommended: false };
    }
    if (expected.target !== undefined) {
      if (normalized.target.kind !== expected.target.kind || normalized.target.value !== expected.target.value) {
        return { isValid: false, failureReason: "wrong-target", retryRecommended: false };
      }
    }
    if (expected.sliceId !== undefined && normalized.slice_id !== expected.sliceId) {
      return { isValid: false, failureReason: "wrong-slice", retryRecommended: false };
    }
  }

  return { isValid: true, normalized };
}
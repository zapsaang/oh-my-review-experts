import fs from "node:fs";
import { z } from "zod";
import {
  CONCURRENCY_CLASSIFICATION_VALUES,
  CONFIDENCE_VALUES,
  PERFORMANCE_CLASSIFICATION_VALUES,
  SCHEMA_VERSION_PATTERN,
  SEVERITY_VALUES,
  UnifiedFindingSchema,
  UnifiedHandoffSchema,
  NormalizedUnifiedHandoffSchema,
  type ConcurrencyClassification,
  type PerformanceClassification,
} from "../agents/schemas.js";
import { parseHandoffJsonHeader } from "../tools/handoff.js";


/**
 * @deprecated Use `UnifiedHandoffSchema`. Same removal policy as
 * `ReviewerFindingSchema` above (remove by v1.0).
 */
export const ReviewerHandoffSchema = UnifiedHandoffSchema;

/**
 * @deprecated Use `NormalizedUnifiedHandoffSchema`. Same removal policy as
 * `ReviewerFindingSchema` above (remove by v1.0).
 */
export const NormalizedReviewerHandoffSchema = NormalizedUnifiedHandoffSchema;

export type ReviewerFinding = z.infer<typeof UnifiedFindingSchema>;
export type ReviewerHandoff = z.infer<typeof NormalizedUnifiedHandoffSchema>;

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
  | { isValid: true; normalized: ReviewerHandoff; warnings: string[] }
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
  if (typeof version === "string" && SCHEMA_VERSION_PATTERN.test(version)) {
    return { valid: true };
  }
  return { valid: false, failureReason: "schema-version-mismatch" };
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

const SEVERITY_SET: ReadonlySet<string> = new Set(SEVERITY_VALUES);
const CONFIDENCE_SET: ReadonlySet<string> = new Set(CONFIDENCE_VALUES);

/**
 * Strict per-finding schema used ONLY for required-field presence detection.
 *
 * Differs from `UnifiedFindingSchema` by checking severity/confidence as
 * plain strings (not enums) so present-but-non-enum values pass this check
 * — those are handled separately by `preCheckEnumFields` which records
 * warnings and lets `.catch()` downgrade. A finding that LACKS severity or
 * confidence entirely fails this parse, surfacing as partial-output / invalid.
 * Never used to produce normalized output.
 */
const StrictFindingShape = z.object({
  id: z.string(),
  severity: z.string(),
  file: z.string().default("N/A"),
  line: z.union([z.number(), z.string()]).default("N/A"),
  title: z.string(),
  description: z.string(),
  evidence: z.string(),
  confidence: z.string(),
  classification: z.string(),
}).loose();

/**
 * Distinguish "field absent" from "field present but invalid enum value".
 * Zod's `.catch()` collapses both cases into a silent downgrade, which masks
 * real reviewer errors. We pre-check raw findings before letting the schema
 * apply its catch behavior, then surface present-but-invalid as a warning.
 *
 * Returns warnings only for findings whose enum fields are present-but-invalid.
 * Missing-field detection is left to the strict per-finding `safeParse` in
 * `validateFindings`, which produces partial-output diagnosis when mixed.
 */
function preCheckEnumFields(findings: unknown[]): string[] {
  const warnings: string[] = [];
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    if (!f || typeof f !== "object" || Array.isArray(f)) continue;
    const obj = f as Record<string, unknown>;

    const sev = obj.severity;
    if (typeof sev === "string" && !SEVERITY_SET.has(sev)) {
      warnings.push(`finding[${i}].severity "${sev}" is not a known value; downgraded to "medium"`);
    }
    const conf = obj.confidence;
    if (typeof conf === "string" && !CONFIDENCE_SET.has(conf)) {
      warnings.push(`finding[${i}].confidence "${conf}" is not a known value; downgraded to "low"`);
    }
  }
  return warnings;
}

function validateFindings(findings: unknown[]): { valid: boolean; partial: boolean } {
  let hasValid = false;
  let hasInvalid = false;

  for (const finding of findings) {
    const result = StrictFindingShape.safeParse(finding);
    if (result.success) {
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
  const findingsResult = validateFindings(validated.findings);
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

/**
 * Apply post-validation advisory adjustments:
 * - Append warnings to meta.notes when classifications fall outside the
 *   dimension's standard taxonomy (advisory only, not a failure).
 * - Auto-correct meta.total_findings to match findings.length if the LLM
 *   miscounted, recording the original value in meta.notes.
 *
 * Returns a new normalized handoff; does not mutate the input.
 */
/**
 * Compute advisory adjustments without mutating user-controlled fields.
 *
 * Returns a copy with `meta.total_findings` corrected if it diverged from
 * `findings.length`, plus a list of warnings describing every adjustment
 * (classification taxonomy mismatches, total_findings corrections).
 *
 * `meta.notes` is intentionally NOT modified: that field is reviewer free
 * text and downstream consumers may parse it for specific markers. Warnings
 * flow through `ValidationOutcome.warnings` instead.
 */
function applyAdvisories(normalized: ReviewerHandoff): {
  normalized: ReviewerHandoff;
  warnings: string[];
} {
  const warnings: string[] = [];

  for (const finding of normalized.findings) {
    if (!isValidClassificationForDimension(finding.classification, normalized.dimension)) {
      warnings.push(
        `classification "${finding.classification}" is not in standard taxonomy for dimension "${normalized.dimension}"`,
      );
    }
  }

  const originalTotal = normalized.meta.total_findings;
  if (originalTotal !== normalized.findings.length) {
    warnings.push(
      `total_findings auto-corrected from ${originalTotal} to ${normalized.findings.length}`,
    );
    return {
      normalized: {
        ...normalized,
        meta: { ...normalized.meta, total_findings: normalized.findings.length },
      },
      warnings,
    };
  }

  return { normalized, warnings };
}

function validateExpected(
  normalized: ReviewerHandoff,
  expected: ExpectedValues
): ValidationOutcome | undefined {
  if (expected.dimension !== undefined && normalized.dimension !== expected.dimension) {
    return { isValid: false, failureReason: "wrong-dimension", retryRecommended: false };
  }
  if (expected.target !== undefined) {
    if (
      normalized.target.kind !== expected.target.kind ||
      normalized.target.value !== expected.target.value
    ) {
      return { isValid: false, failureReason: "wrong-target", retryRecommended: false };
    }
  }
  if (expected.sliceId !== undefined && normalized.slice_id !== expected.sliceId) {
    return { isValid: false, failureReason: "wrong-slice", retryRecommended: false };
  }
  return undefined;
}

function validateParsedHandoff(
  data: unknown,
  expected?: ExpectedValues
): ValidationOutcome {
  const versionResult = validateSchemaVersion(data);
  if (!versionResult.valid) {
    return { isValid: false, failureReason: "invalid-schema", retryRecommended: false };
  }

  const topLevelResult = ReviewerHandoffSchema.safeParse(data);
  if (!topLevelResult.success) {
    return { isValid: false, failureReason: "invalid-schema", retryRecommended: false };
  }

  const enumWarnings = preCheckEnumFields(topLevelResult.data.findings);

  const shapeCheck = validateSchemaShape(data);
  if (!shapeCheck.valid) {
    const reason = shapeCheck.partial ? "partial-output" : (shapeCheck.reason as FailureReason);
    return { isValid: false, failureReason: reason, retryRecommended: isRetryRecommended(reason) };
  }

  const advisories = applyAdvisories(normalizeHandoff(data));
  const allWarnings = [...enumWarnings, ...advisories.warnings];

  if (expected) {
    const expectedFailure = validateExpected(advisories.normalized, expected);
    if (expectedFailure) return expectedFailure;
  }

  return { isValid: true, normalized: advisories.normalized, warnings: allWarnings };
}

function classifyParseError(error: string | null | undefined): FailureReason {
  const msg = error ?? "";
  if (
    msg.includes("JSON header missing") ||
    msg.includes("JSON header malformed") ||
    msg.includes("JSON header empty")
  ) {
    return "missing-fence";
  }
  return "invalid-json";
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
    const reason = classifyParseError(parseResult.error);
    return { isValid: false, failureReason: reason, retryRecommended: true };
  }

  return validateParsedHandoff(parseResult.data, expected);
}

/**
 * Recover a handoff from a chat message body when the file-based handoff
 * is missing or invalid. Reuses parseHandoffJsonHeader so the chat fence
 * grammar matches the file fence grammar exactly.
 *
 * Unlike validateReviewerHandoff, this does not enforce prose-outside-json:
 * chat replies legitimately contain prose around the JSON fence. We iterate
 * every \`\`\`json fence in the message and return the first one that
 * passes schema validation. This handles cases where the reviewer includes
 * a template/example fence before the real handoff fence.
 *
 * Returns the LAST encountered failure (the most informative diagnostic
 * the chat ever produced) when no fence yields a valid handoff.
 */
export function validateHandoffFromChat(
  content: string,
  expected?: ExpectedValues
): ValidationOutcome {
  let cursor = 0;
  let lastFailure: ValidationOutcome | undefined;

  while (cursor < content.length) {
    const fenceStart = content.indexOf("```json", cursor);
    if (fenceStart === -1) break;

    const slice = content.slice(fenceStart);
    const parseResult = parseHandoffJsonHeader(slice);

    if (parseResult.success) {
      const outcome = validateParsedHandoff(parseResult.data, expected);
      if (outcome.isValid) return outcome;
      lastFailure = outcome;
    } else {
      const reason = classifyParseError(parseResult.error);
      lastFailure = { isValid: false, failureReason: reason, retryRecommended: true };
    }

    const fenceClose = slice.indexOf("\n```", "```json".length);
    if (fenceClose === -1) break;
    cursor = fenceStart + fenceClose + "\n```".length;
  }

  return lastFailure ?? { isValid: false, failureReason: "missing-fence", retryRecommended: true };
}

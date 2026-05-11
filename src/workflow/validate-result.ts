import fs from "node:fs";
import { SCHEMA_VERSION } from "../agents/schemas.js";
import { parseHandoffJsonHeader } from "../tools/handoff.js";

export interface ValidationResult {
  valid: boolean;
  failureReason?: string;
}

export interface ExpectedValues {
  dimension?: string;
  target?: { kind: string; value: string };
  sliceId?: string;
}

export interface ReviewerHandoff {
  schema_version: string;
  task_id: string;
  agent: string;
  dimension: string;
  status: "completed" | "blocked";
  target: { kind: string; value: string };
  slice_id: string;
  findings: Array<{
    id: string;
    severity: "critical" | "high" | "medium" | "low";
    file: string;
    line: number | string;
    title: string;
    description: string;
    evidence: string;
    confidence: "high" | "medium" | "low";
    classification: string;
  }>;
  meta: { total_findings: number; notes: string };
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

function isValidSeverity(value: unknown): value is "critical" | "high" | "medium" | "low" {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}

function isValidConfidence(value: unknown): value is "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low";
}

function isValidStatus(value: unknown): value is "completed" | "blocked" {
  return value === "completed" || value === "blocked";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumberOrString(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSchemaShape(data: unknown): { valid: boolean; partial: boolean; reason?: string } {
  if (!isObject(data)) {
    return { valid: false, partial: false, reason: "invalid-schema" };
  }

  const requiredFields = [
    "schema_version",
    "task_id",
    "agent",
    "dimension",
    "status",
    "target",
    "slice_id",
    "findings",
    "meta",
  ];

  for (const field of requiredFields) {
    if (!(field in data)) {
      return { valid: false, partial: false, reason: "invalid-schema" };
    }
  }

  if (!isValidStatus(data.status)) {
    return { valid: false, partial: false, reason: "invalid-schema" };
  }

  if (!isObject(data.target)) {
    return { valid: false, partial: false, reason: "invalid-schema" };
  }
  if (!("kind" in data.target) || !("value" in data.target)) {
    return { valid: false, partial: false, reason: "invalid-schema" };
  }
  if (!isString(data.target.kind) || !isString(data.target.value)) {
    return { valid: false, partial: false, reason: "invalid-schema" };
  }

  if (!Array.isArray(data.findings)) {
    return { valid: false, partial: false, reason: "invalid-schema" };
  }

  const findingRequiredFields = ["id", "severity", "title", "description", "evidence", "confidence", "classification"];
  let hasValidFindings = false;
  let hasInvalidFindings = false;

  for (const finding of data.findings) {
    if (!isObject(finding)) {
      hasInvalidFindings = true;
      continue;
    }

    let findingValid = true;
    for (const field of findingRequiredFields) {
      if (!(field in finding)) {
        findingValid = false;
        break;
      }
    }

    if (findingValid) {
      if (!isValidSeverity(finding.severity)) {
        findingValid = false;
      }
      if (!isValidConfidence(finding.confidence)) {
        findingValid = false;
      }
    }

    if (findingValid) {
      hasValidFindings = true;
    } else {
      hasInvalidFindings = true;
    }
  }

  if (hasInvalidFindings && hasValidFindings) {
    return { valid: false, partial: true, reason: "partial-output" };
  }

  if (hasInvalidFindings && !hasValidFindings) {
    return { valid: false, partial: false, reason: "invalid-schema" };
  }

  if (!isObject(data.meta)) {
    return { valid: false, partial: false, reason: "invalid-schema" };
  }
  if (!("total_findings" in data.meta) || !("notes" in data.meta)) {
    return { valid: false, partial: false, reason: "invalid-schema" };
  }

  return { valid: true, partial: false };
}

function normalizeHandoff(data: unknown): ReviewerHandoff {
  const obj = data as Record<string, unknown>;
  return {
    schema_version: String(obj.schema_version),
    task_id: String(obj.task_id),
    agent: String(obj.agent),
    dimension: String(obj.dimension),
    status: obj.status as "completed" | "blocked",
    target: obj.target as { kind: string; value: string },
    slice_id: String(obj.slice_id),
    findings: (obj.findings as unknown[]).map((f) => {
      const finding = f as Record<string, unknown>;
      return {
        id: String(finding.id),
        severity: finding.severity as "critical" | "high" | "medium" | "low",
        file: finding.file !== undefined ? String(finding.file) : "N/A",
        line: finding.line !== undefined ? (isNumberOrString(finding.line) ? finding.line : "N/A") : "N/A",
        title: String(finding.title),
        description: String(finding.description),
        evidence: String(finding.evidence),
        confidence: finding.confidence as "high" | "medium" | "low",
        classification: String(finding.classification),
      };
    }),
    meta: {
      total_findings: Number((obj.meta as Record<string, unknown>).total_findings),
      notes: String((obj.meta as Record<string, unknown>).notes),
    },
  };
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
    if (error.includes("Schema version mismatch")) {
      return { isValid: false, failureReason: "invalid-schema", retryRecommended: false };
    }
    return { isValid: false, failureReason: "invalid-json", retryRecommended: true };
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

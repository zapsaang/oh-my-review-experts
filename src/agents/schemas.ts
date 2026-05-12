/**
 * JSON schema examples for review-code workflow prompts.
 *
 * Centralizing these schemas eliminates DRY violations in prompts.ts.
 * Any schema evolution only requires updating this file.
 */

/**
 * Current schema version for handoff contracts.
 *
 * Version policy:
 * - Bump MAJOR version on breaking schema changes (removed fields, changed types, new required fields).
 * - MINOR version bumps are informational (new optional fields, documentation changes).
 * - When bumping: update this constant, update all JSON schema templates, update handoff protocol builders,
 *   and ensure the validator accepts the new version.
 * - Old versions are rejected by validateSchemaVersion() with failureReason "schema-version-mismatch".
 */
export const SCHEMA_VERSION = "1";

export const SEVERITY_VALUES = ["critical", "high", "medium", "low"] as const;
export type SeverityLevel = (typeof SEVERITY_VALUES)[number];

export const CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_VALUES)[number];

export const PERFORMANCE_CLASSIFICATION_VALUES = [
  "provable-regression",
  "likely-regression",
  "benchmark-needed",
] as const;
export type PerformanceClassification = (typeof PERFORMANCE_CLASSIFICATION_VALUES)[number];

export const CONCURRENCY_CLASSIFICATION_VALUES = [
  "race-condition",
  "atomicity-violation",
  "ordering-issue",
  "idempotency-gap",
  "retry-amplification",
  "deadlock",
  "stale-read",
  "distributed-inconsistency",
] as const;
export type ConcurrencyClassification = (typeof CONCURRENCY_CLASSIFICATION_VALUES)[number];

export const REJECTION_REASON_VALUES = [
  "duplicate",
  "weak-evidence",
  "speculative",
  "out-of-scope",
  "contradicted-by-code",
] as const;
export type RejectionReason = (typeof REJECTION_REASON_VALUES)[number];

/** Expected JSON output for a single reviewer finding. */
export const REVIEWER_FINDING_JSON = `{
  "id": "sec-1",
  "severity": "critical|high|medium|low",
  "file": "src/foo.ts",
  "line": 42,
  "title": "…",
  "description": "…",
  "evidence": "…",
  "confidence": "high|medium|low",
  "classification": "injection|race-condition|provable-regression"
}`;

/** Expected JSON output for a reviewer handoff header (machine-readable contract). */
export const REVIEWER_HANDOFF_JSON = `{
  "schema_version": "${SCHEMA_VERSION}",
  "task_id": "<subagent task id>",
  "agent": "reviewer-security",
  "dimension": "security",
  "status": "completed",
  "target": { "kind": "working-tree", "value": "<summary>" },
  "slice_id": "slice-1",
  "findings": [
    ${REVIEWER_FINDING_JSON}
  ],
  "meta": { "total_findings": 1, "notes": "" }
}`;

/** Expected JSON output for the slice planner. */
export const SLICE_PLANNER_JSON = `{
  "schema_version": "${SCHEMA_VERSION}",
  "status": "completed",
  "slicing_mode": "none|module-based|risk-based|hybrid",
  "should_slice": true,
  "reason": "short explanation",
  "slices": [{ "slice_id": "slice-1", "slice_type": "business-module", "title": "...", "files": ["path"] }]
}`;

/** Expected JSON output for the slice plan validator. */
export const SLICE_PLAN_VALIDATOR_JSON = `{"schema_version": "${SCHEMA_VERSION}", "status":"completed","is_valid":true,"failure_reason":"","retry_recommended":false,"normalized_result":null}`;

/** Expected JSON output for the review result validator. */
export const RESULT_VALIDATOR_JSON = `{"schema_version": "${SCHEMA_VERSION}", "status":"completed","assigned_dimension":"spec","slice_id":"","is_valid":true,"failure_reason":"","retry_recommended":false}`;

/** Expected JSON output for the slice arbiter. */
export const SLICE_ARBITER_JSON = `{"schema_version": "${SCHEMA_VERSION}", "status":"completed","slice_id":"slice-1","confirmed":[],"needs_validation":[],"rejected":[{"id":"finding-1","reason":"${REJECTION_REASON_VALUES.join("|")}"}],"degraded":false,"missing_dimensions":[]}`;

/** Expected JSON output for the global arbiter. */
export const GLOBAL_ARBITER_JSON = `{"schema_version": "${SCHEMA_VERSION}", "status":"completed","confirmed":[],"needs_validation":[],"rejected":[{"id":"finding-1","reason":"${REJECTION_REASON_VALUES.join("|")}"}],"degraded_slices":[],"missing_dimensions_global":[],"summary":{"total_slices":0,"total_confirmed":0}}`;

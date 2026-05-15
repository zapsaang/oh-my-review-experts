/**
 * JSON schema examples for review-code workflow prompts.
 *
 * Centralizing these schemas eliminates DRY violations in prompts.ts.
 * Any schema evolution only requires updating this file.
 */

import { z } from "zod";

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

/**
 * Regex matching accepted schema_version values for the current major.
 *
 * Accepts "1" and "1.<minor>" so MINOR bumps remain backward compatible.
 * Update this when bumping the MAJOR version (e.g. /^2(\.\d+)?$/ for v2).
 */
export const SCHEMA_VERSION_PATTERN = /^1(\.\d+)?$/;

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

/**
 * Single source of truth for finding shape. Used by both write side
 * (omre_write_handoff input schema) and read side (handoff validator).
 *
 * Relaxed-but-safe rules:
 * - file/line default to "N/A" so omitting them is non-fatal.
 * - severity/confidence use .catch() to downgrade unknown values instead of failing.
 * - .loose() preserves extra fields (recommendation, impact, category, ...) the LLM may add.
 * - Extra-field warnings are emitted by validate-result.ts, not enforced here.
 */
export const UnifiedFindingSchema = z.looseObject({
  id: z.string(),
  severity: z.enum(SEVERITY_VALUES).catch("medium"),
  file: z.string().default("N/A"),
  line: z.union([z.number(), z.string()]).default("N/A"),
  title: z.string(),
  description: z.string(),
  evidence: z.string(),
  confidence: z.enum(CONFIDENCE_VALUES).catch("low"),
  classification: z.string(),
});
export type UnifiedFinding = z.infer<typeof UnifiedFindingSchema>;

/**
 * Top-level handoff envelope. findings is z.unknown() at this level so
 * partial-output diagnosis (some valid, some invalid) can run before
 * the strict per-finding parse in NormalizedUnifiedHandoffSchema.
 */
export const UnifiedHandoffSchema = z.object({
  schema_version: z.string().regex(SCHEMA_VERSION_PATTERN),
  task_id: z.string(),
  agent: z.string(),
  dimension: z.string(),
  status: z.enum(["completed", "blocked"]),
  target: z.object({ kind: z.string(), value: z.string() }),
  slice_id: z.string(),
  findings: z.array(z.unknown()),
  meta: z.object({
    total_findings: z.number(),
    notes: z.string().default(""),
  }),
});
export type UnifiedHandoff = z.infer<typeof UnifiedHandoffSchema>;

/**
 * Same shape as UnifiedHandoffSchema, but findings are fully validated
 * against UnifiedFindingSchema. Use this for the final normalized output
 * after partial-output diagnosis has passed.
 */
export const NormalizedUnifiedHandoffSchema = UnifiedHandoffSchema.extend({
  findings: z.array(UnifiedFindingSchema),
});
export type NormalizedUnifiedHandoff = z.infer<typeof NormalizedUnifiedHandoffSchema>;

/**
 * Generates a representative example object from a Zod schema for use in prompts.
 *
 * Rendering rules:
 * - object → recursively expanded; loose objects render same as strict (extras invisible).
 * - enum   → "value1|value2|..." pipe-separated string.
 * - union  → first option's example.
 * - default/catch/optional → unwrapped to inner type's example.
 * - array  → single-element array containing element example.
 * - string → "string", number → 0, boolean → true.
 *
 * Depth-limited at 10 to defend against accidental cyclic schemas.
 */
export function zodToExample(schema: unknown, depth = 0): unknown {
  if (depth > 10) return "...";
  if (!schema || typeof schema !== "object") return "unknown";

  const def = (schema as { _zod?: { def?: { type?: string; innerType?: unknown } } })._zod?.def;
  const type = def?.type;

  if (type === "object") {
    const shape = (schema as { shape?: Record<string, unknown> }).shape ?? {};
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(shape)) {
      result[key] = zodToExample(value, depth + 1);
    }
    return result;
  }

  if (type === "enum") {
    const options = (schema as { options?: readonly string[] }).options ?? [];
    return options.join("|");
  }

  if (type === "union") {
    const options = (schema as { options?: readonly unknown[] }).options ?? [];
    return options.length > 0 ? zodToExample(options[0], depth + 1) : "unknown";
  }

  if (type === "default" || type === "catch" || type === "optional" || type === "nullable") {
    return zodToExample(def?.innerType, depth + 1);
  }

  if (type === "array") {
    const element = (schema as { element?: unknown }).element;
    return [zodToExample(element, depth + 1)];
  }

  if (type === "string") return "string";
  if (type === "number") return 0;
  if (type === "boolean") return true;

  return "unknown";
}

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

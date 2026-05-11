/**
 * JSON schema examples for review-code workflow prompts.
 *
 * Centralizing these schemas eliminates DRY violations in prompts.ts.
 * Any schema evolution only requires updating this file.
 */

/** Current schema version for handoff contracts. Bump on breaking changes. */
export const SCHEMA_VERSION = "1";

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
  "classification": "injection"
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
  "status": "completed",
  "slicing_mode": "none|module-based|risk-based|hybrid",
  "should_slice": true,
  "reason": "short explanation",
  "slices": [{ "slice_id": "slice-1", "slice_type": "business-module", "title": "...", "files": ["path"] }]
}`;

/** Expected JSON output for the slice plan validator. */
export const SLICE_PLAN_VALIDATOR_JSON = `{"status":"completed","is_valid":true,"failure_reason":"","retry_recommended":false,"normalized_result":null}`;

/** Expected JSON output for the review result validator. */
export const RESULT_VALIDATOR_JSON = `{"status":"completed","assigned_dimension":"spec","slice_id":"","is_valid":true,"failure_reason":"","retry_recommended":false}`;

/** Expected JSON output for the slice arbiter. */
export const SLICE_ARBITER_JSON = `{"status":"completed","slice_id":"slice-1","confirmed":[],"needs_validation":[],"rejected":[],"degraded":false,"missing_dimensions":[]}`;

/** Expected JSON output for the global arbiter. */
export const GLOBAL_ARBITER_JSON = `{"status":"completed","confirmed":[],"needs_validation":[],"rejected":[],"degraded_slices":[],"summary":{"total_slices":0,"total_confirmed":0}}`;

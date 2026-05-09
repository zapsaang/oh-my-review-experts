/**
 * JSON schema examples for review-code workflow prompts.
 *
 * Centralizing these schemas eliminates DRY violations in prompts.ts.
 * Any schema evolution only requires updating this file.
 */

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

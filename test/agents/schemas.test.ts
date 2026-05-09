import { describe, it, expect } from "vitest";
import {
  GLOBAL_ARBITER_JSON,
  RESULT_VALIDATOR_JSON,
  SLICE_ARBITER_JSON,
  SLICE_PLANNER_JSON,
  SLICE_PLAN_VALIDATOR_JSON,
} from "../../src/agents/schemas.js";

describe("JSON schema constants", () => {
  it("SLICE_PLANNER_JSON contains expected fields", () => {
    expect(SLICE_PLANNER_JSON).toContain('"status": "completed"');
    expect(SLICE_PLANNER_JSON).toContain('"slicing_mode"');
    expect(SLICE_PLANNER_JSON).toContain('"should_slice"');
    expect(SLICE_PLANNER_JSON).toContain('"reason"');
    expect(SLICE_PLANNER_JSON).toContain('"slices"');
    expect(SLICE_PLANNER_JSON).toContain('"slice_id"');
    expect(SLICE_PLANNER_JSON).toContain('"slice_type"');
    expect(SLICE_PLANNER_JSON).toContain('"title"');
    expect(SLICE_PLANNER_JSON).toContain('"files"');
  });

  it("SLICE_PLAN_VALIDATOR_JSON is valid compact JSON", () => {
    const parsed = JSON.parse(SLICE_PLAN_VALIDATOR_JSON);
    expect(parsed.status).toBe("completed");
    expect(parsed.is_valid).toBe(true);
    expect(parsed.retry_recommended).toBe(false);
    expect(parsed.normalized_result).toBeNull();
  });

  it("RESULT_VALIDATOR_JSON is valid compact JSON", () => {
    const parsed = JSON.parse(RESULT_VALIDATOR_JSON);
    expect(parsed.status).toBe("completed");
    expect(parsed.assigned_dimension).toBe("spec");
    expect(parsed.is_valid).toBe(true);
    expect(parsed.retry_recommended).toBe(false);
  });

  it("SLICE_ARBITER_JSON is valid compact JSON", () => {
    const parsed = JSON.parse(SLICE_ARBITER_JSON);
    expect(parsed.status).toBe("completed");
    expect(parsed.slice_id).toBe("slice-1");
    expect(parsed.confirmed).toEqual([]);
    expect(parsed.degraded).toBe(false);
    expect(parsed.missing_dimensions).toEqual([]);
  });

  it("GLOBAL_ARBITER_JSON is valid compact JSON", () => {
    const parsed = JSON.parse(GLOBAL_ARBITER_JSON);
    expect(parsed.status).toBe("completed");
    expect(parsed.confirmed).toEqual([]);
    expect(parsed.degraded_slices).toEqual([]);
    expect(parsed.summary).toEqual({ total_slices: 0, total_confirmed: 0 });
  });

  it("all JSON constants are non-empty strings", () => {
    expect(SLICE_PLANNER_JSON.length).toBeGreaterThan(0);
    expect(SLICE_PLAN_VALIDATOR_JSON.length).toBeGreaterThan(0);
    expect(RESULT_VALIDATOR_JSON.length).toBeGreaterThan(0);
    expect(SLICE_ARBITER_JSON.length).toBeGreaterThan(0);
    expect(GLOBAL_ARBITER_JSON.length).toBeGreaterThan(0);
  });
});

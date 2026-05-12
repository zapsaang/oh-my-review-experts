import { describe, it, expect } from "vitest";
import {
  CONCURRENCY_CLASSIFICATION_VALUES,
  CONFIDENCE_VALUES,
  GLOBAL_ARBITER_JSON,
  PERFORMANCE_CLASSIFICATION_VALUES,
  REJECTION_REASON_VALUES,
  RESULT_VALIDATOR_JSON,
  REVIEWER_FINDING_JSON,
  REVIEWER_HANDOFF_JSON,
  SCHEMA_VERSION,
  SEVERITY_VALUES,
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
    expect(parsed.rejected).toEqual([
      { id: "finding-1", reason: "duplicate|weak-evidence|speculative|out-of-scope|contradicted-by-code" },
    ]);
    expect(parsed.degraded).toBe(false);
    expect(parsed.missing_dimensions).toEqual([]);
  });

  it("GLOBAL_ARBITER_JSON is valid compact JSON", () => {
    const parsed = JSON.parse(GLOBAL_ARBITER_JSON);
    expect(parsed.status).toBe("completed");
    expect(parsed.confirmed).toEqual([]);
    expect(parsed.rejected).toEqual([
      { id: "finding-1", reason: "duplicate|weak-evidence|speculative|out-of-scope|contradicted-by-code" },
    ]);
    expect(parsed.degraded_slices).toEqual([]);
    expect(parsed.missing_dimensions_global).toEqual([]);
    expect(parsed.summary).toEqual({ total_slices: 0, total_confirmed: 0 });
  });

  it("exports closed vocabulary arrays", () => {
    expect(SEVERITY_VALUES).toEqual(["critical", "high", "medium", "low"]);
    expect(CONFIDENCE_VALUES).toEqual(["high", "medium", "low"]);
    expect(PERFORMANCE_CLASSIFICATION_VALUES).toEqual([
      "provable-regression",
      "likely-regression",
      "benchmark-needed",
    ]);
    expect(CONCURRENCY_CLASSIFICATION_VALUES).toEqual([
      "race-condition",
      "atomicity-violation",
      "ordering-issue",
      "idempotency-gap",
      "retry-amplification",
      "deadlock",
      "stale-read",
      "distributed-inconsistency",
    ]);
    expect(REJECTION_REASON_VALUES).toEqual([
      "duplicate",
      "weak-evidence",
      "speculative",
      "out-of-scope",
      "contradicted-by-code",
    ]);
  });

  it("arbiter JSON examples use the rejection reason vocabulary", () => {
    const expectedReason = REJECTION_REASON_VALUES.join("|");
    expect(JSON.parse(SLICE_ARBITER_JSON).rejected[0].reason).toBe(expectedReason);
    expect(JSON.parse(GLOBAL_ARBITER_JSON).rejected[0].reason).toBe(expectedReason);
  });

  it("excludes free-form arbiter rejection reasons", () => {
    const reasons: readonly string[] = REJECTION_REASON_VALUES;

    expect(reasons).toContain("duplicate");
    expect(reasons).not.toContain("not-enough-evidence");
  });

  it("all JSON constants are non-empty strings", () => {
    expect(SLICE_PLANNER_JSON.length).toBeGreaterThan(0);
    expect(SLICE_PLAN_VALIDATOR_JSON.length).toBeGreaterThan(0);
    expect(RESULT_VALIDATOR_JSON.length).toBeGreaterThan(0);
    expect(SLICE_ARBITER_JSON.length).toBeGreaterThan(0);
    expect(GLOBAL_ARBITER_JSON.length).toBeGreaterThan(0);
    expect(REVIEWER_FINDING_JSON.length).toBeGreaterThan(0);
    expect(REVIEWER_HANDOFF_JSON.length).toBeGreaterThan(0);
  });

  it("SCHEMA_VERSION is '1'", () => {
    expect(SCHEMA_VERSION).toBe("1");
  });

  it("REVIEWER_FINDING_JSON is valid JSON with expected fields", () => {
    const parsed = JSON.parse(REVIEWER_FINDING_JSON);
    expect(parsed.id).toBe("sec-1");
    expect(parsed.severity).toBe("critical|high|medium|low");
    expect(parsed.file).toBe("src/foo.ts");
    expect(parsed.line).toBe(42);
    expect(parsed.title).toBe("…");
    expect(parsed.description).toBe("…");
    expect(parsed.evidence).toBe("…");
    expect(parsed.confidence).toBe("high|medium|low");
    expect(parsed.classification).toBe("injection|race-condition|provable-regression");
  });

  it("REVIEWER_HANDOFF_JSON is valid JSON with expected structure", () => {
    const parsed = JSON.parse(REVIEWER_HANDOFF_JSON);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.task_id).toBe("<subagent task id>");
    expect(parsed.agent).toBe("reviewer-security");
    expect(parsed.dimension).toBe("security");
    expect(parsed.status).toBe("completed");
    expect(parsed.target).toEqual({ kind: "working-tree", value: "<summary>" });
    expect(parsed.slice_id).toBe("slice-1");
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.findings.length).toBe(1);
    expect(parsed.meta).toEqual({ total_findings: 1, notes: "" });
  });

  it("REVIEWER_HANDOFF_JSON references the current SCHEMA_VERSION", () => {
    expect(REVIEWER_HANDOFF_JSON).toContain(`"schema_version": "${SCHEMA_VERSION}"`);
  });
});

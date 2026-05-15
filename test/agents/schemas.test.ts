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
  UnifiedFindingSchema,
  UnifiedHandoffSchema,
  NormalizedUnifiedHandoffSchema,
  zodToExample,
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

describe("UnifiedFindingSchema", () => {
  const baseFinding = {
    id: "sec-1",
    severity: "critical" as const,
    file: "src/auth.ts",
    line: 42,
    title: "Hardcoded secret",
    description: "API key is hardcoded",
    evidence: "const API_KEY = 'sk-...'",
    confidence: "high" as const,
    classification: "injection",
  };

  it("accepts all required fields", () => {
    const result = UnifiedFindingSchema.safeParse(baseFinding);
    expect(result.success).toBe(true);
  });

  it("defaults file to 'N/A' when omitted", () => {
    const { file: _file, ...withoutFile } = baseFinding;
    const result = UnifiedFindingSchema.safeParse(withoutFile);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.file).toBe("N/A");
    }
  });

  it("defaults line to 'N/A' when omitted", () => {
    const { line: _line, ...withoutLine } = baseFinding;
    const result = UnifiedFindingSchema.safeParse(withoutLine);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.line).toBe("N/A");
    }
  });

  it("allows extra fields via loose passthrough", () => {
    const result = UnifiedFindingSchema.safeParse({
      ...baseFinding,
      recommendation: "Use environment variables",
      impact: "high",
      category: "security",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as typeof result.data & {
        recommendation?: string;
        impact?: string;
        category?: string;
      };
      expect(data.recommendation).toBe("Use environment variables");
      expect(data.impact).toBe("high");
      expect(data.category).toBe("security");
    }
  });

  it("downgrades invalid severity to 'medium' via .catch()", () => {
    const result = UnifiedFindingSchema.safeParse({
      ...baseFinding,
      severity: "blocker",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.severity).toBe("medium");
    }
  });

  it("downgrades invalid confidence to 'low' via .catch()", () => {
    const result = UnifiedFindingSchema.safeParse({
      ...baseFinding,
      confidence: "certain",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confidence).toBe("low");
    }
  });

  it("preserves all valid severity values without downgrade", () => {
    for (const severity of SEVERITY_VALUES) {
      const result = UnifiedFindingSchema.safeParse({ ...baseFinding, severity });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.severity).toBe(severity);
      }
    }
  });

  it("preserves all valid confidence values without downgrade", () => {
    for (const confidence of CONFIDENCE_VALUES) {
      const result = UnifiedFindingSchema.safeParse({ ...baseFinding, confidence });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.confidence).toBe(confidence);
      }
    }
  });

  it("rejects when required string fields are missing", () => {
    const result = UnifiedFindingSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts numeric line value", () => {
    const result = UnifiedFindingSchema.safeParse({ ...baseFinding, line: 100 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.line).toBe(100);
    }
  });

  it("accepts string line value (e.g. range)", () => {
    const result = UnifiedFindingSchema.safeParse({ ...baseFinding, line: "100-105" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.line).toBe("100-105");
    }
  });
});

describe("UnifiedHandoffSchema", () => {
  const baseHandoff = {
    schema_version: "1",
    task_id: "task-123",
    agent: "reviewer-security",
    dimension: "security",
    status: "completed" as const,
    target: { kind: "working-tree", value: "src/auth.ts" },
    slice_id: "slice-1",
    findings: [],
    meta: { total_findings: 0, notes: "" },
  };

  it("accepts schema_version '1'", () => {
    const result = UnifiedHandoffSchema.safeParse(baseHandoff);
    expect(result.success).toBe(true);
  });

  it("accepts schema_version '1.0' (relaxed regex)", () => {
    const result = UnifiedHandoffSchema.safeParse({ ...baseHandoff, schema_version: "1.0" });
    expect(result.success).toBe(true);
  });

  it("accepts schema_version '1.5' (relaxed regex)", () => {
    const result = UnifiedHandoffSchema.safeParse({ ...baseHandoff, schema_version: "1.5" });
    expect(result.success).toBe(true);
  });

  it("rejects schema_version '2'", () => {
    const result = UnifiedHandoffSchema.safeParse({ ...baseHandoff, schema_version: "2" });
    expect(result.success).toBe(false);
  });

  it("rejects schema_version '0'", () => {
    const result = UnifiedHandoffSchema.safeParse({ ...baseHandoff, schema_version: "0" });
    expect(result.success).toBe(false);
  });

  it("rejects empty schema_version", () => {
    const result = UnifiedHandoffSchema.safeParse({ ...baseHandoff, schema_version: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing required top-level fields", () => {
    const { agent: _agent, ...withoutAgent } = baseHandoff;
    const result = UnifiedHandoffSchema.safeParse(withoutAgent);
    expect(result.success).toBe(false);
  });

  it("defaults meta.notes to empty string when omitted", () => {
    const result = UnifiedHandoffSchema.safeParse({
      ...baseHandoff,
      meta: { total_findings: 0 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.meta.notes).toBe("");
    }
  });
});

describe("NormalizedUnifiedHandoffSchema", () => {
  it("normalizes findings array with UnifiedFindingSchema", () => {
    const result = NormalizedUnifiedHandoffSchema.safeParse({
      schema_version: "1",
      task_id: "task-123",
      agent: "reviewer-security",
      dimension: "security",
      status: "completed",
      target: { kind: "working-tree", value: "src/auth.ts" },
      slice_id: "slice-1",
      findings: [
        {
          id: "sec-1",
          severity: "critical",
          file: "src/auth.ts",
          line: 42,
          title: "Hardcoded secret",
          description: "API key is hardcoded",
          evidence: "const API_KEY = 'sk-...'",
          confidence: "high",
          classification: "injection",
        },
      ],
      meta: { total_findings: 1, notes: "" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.findings).toHaveLength(1);
      expect(result.data.findings[0].severity).toBe("critical");
    }
  });

  it("downgrades invalid severity inside findings array", () => {
    const result = NormalizedUnifiedHandoffSchema.safeParse({
      schema_version: "1",
      task_id: "task-123",
      agent: "reviewer-security",
      dimension: "security",
      status: "completed",
      target: { kind: "working-tree", value: "src/auth.ts" },
      slice_id: "slice-1",
      findings: [
        {
          id: "sec-1",
          severity: "blocker",
          title: "X",
          description: "Y",
          evidence: "Z",
          confidence: "high",
          classification: "injection",
        },
      ],
      meta: { total_findings: 1, notes: "" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.findings[0].severity).toBe("medium");
    }
  });
});

describe("zodToExample", () => {
  it("generates an object example for UnifiedFindingSchema", () => {
    const example = zodToExample(UnifiedFindingSchema);
    expect(example).toBeTypeOf("object");
    expect(example).not.toBeNull();
  });

  it("includes all UnifiedFindingSchema keys", () => {
    const example = zodToExample(UnifiedFindingSchema) as Record<string, unknown>;
    expect(example).toHaveProperty("id");
    expect(example).toHaveProperty("severity");
    expect(example).toHaveProperty("file");
    expect(example).toHaveProperty("line");
    expect(example).toHaveProperty("title");
    expect(example).toHaveProperty("description");
    expect(example).toHaveProperty("evidence");
    expect(example).toHaveProperty("confidence");
    expect(example).toHaveProperty("classification");
  });

  it("renders enum values as pipe-separated string", () => {
    const example = zodToExample(UnifiedFindingSchema) as Record<string, unknown>;
    expect(example.severity).toBe("critical|high|medium|low");
    expect(example.confidence).toBe("high|medium|low");
  });

  it("renders strings as 'string' placeholder", () => {
    const example = zodToExample(UnifiedFindingSchema) as Record<string, unknown>;
    expect(example.id).toBe("string");
    expect(example.title).toBe("string");
  });

  it("renders unions by picking the first option", () => {
    const example = zodToExample(UnifiedFindingSchema) as Record<string, unknown>;
    expect(example.line).toBe(0);
  });

  it("unwraps default to inner type representation", () => {
    const example = zodToExample(UnifiedFindingSchema) as Record<string, unknown>;
    expect(example.file).toBe("string");
  });

  it("unwraps catch to inner type representation", () => {
    const example = zodToExample(UnifiedFindingSchema) as Record<string, unknown>;
    expect(example.severity).toBe("critical|high|medium|low");
  });

  it("renders array as single-element array of element example", () => {
    const example = zodToExample(UnifiedHandoffSchema) as Record<string, unknown>;
    expect(Array.isArray(example.findings)).toBe(true);
    expect((example.findings as unknown[]).length).toBe(1);
  });

  it("renders nested objects recursively", () => {
    const example = zodToExample(UnifiedHandoffSchema) as Record<string, unknown>;
    expect(example.target).toBeTypeOf("object");
    expect(example.meta).toBeTypeOf("object");
    expect((example.meta as Record<string, unknown>).total_findings).toBe(0);
  });

  it("returns the produced example as a JSON-serializable structure", () => {
    const example = zodToExample(UnifiedFindingSchema);
    expect(() => JSON.stringify(example)).not.toThrow();
  });

  it("matches the canonical UnifiedFindingSchema example shape (snapshot)", () => {
    const example = zodToExample(UnifiedFindingSchema);
    expect(example).toEqual({
      id: "string",
      severity: "critical|high|medium|low",
      file: "string",
      line: 0,
      title: "string",
      description: "string",
      evidence: "string",
      confidence: "high|medium|low",
      classification: "string",
    });
  });
});

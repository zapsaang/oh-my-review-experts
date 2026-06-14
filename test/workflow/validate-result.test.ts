import { describe, expect, it, expectTypeOf } from "vitest";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  validateSchemaVersion,
  validateReviewerHandoff,
  validateHandoffFromChat,
  type ReviewerHandoff,
  type ReviewerFinding,
  type ExpectedValues,
} from "../../src/workflow/validate-result.js";
import { SCHEMA_VERSION, UnifiedFindingSchema, UnifiedHandoffSchema, NormalizedUnifiedHandoffSchema } from "../../src/agents/schemas.js";

function createMockHandoffFile(content: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-test-"));
  const filePath = path.join(tmpDir, "handoff.md");
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function createValidHandoff(): ReviewerHandoff {
  return {
    schema_version: SCHEMA_VERSION,
    task_id: "task-123",
    agent: "omre-reviewer-security",
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
        description: "API key is hardcoded in source",
        evidence: "const API_KEY = 'sk-...'",
        confidence: "high",
        classification: "injection",
        memoryRefs: [],
        isRegression: false,
      },
    ],
    meta: { total_findings: 1, notes: "" },
  };
}

describe("validateSchemaVersion", () => {
  it("returns valid=true when schema_version matches", () => {
    const result = validateSchemaVersion({ schema_version: SCHEMA_VERSION });
    expect(result.valid).toBe(true);
    expect(result.failureReason).toBeUndefined();
  });

  it("returns valid=false with schema-version-mismatch when version differs", () => {
    const result = validateSchemaVersion({ schema_version: "0" });
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("schema-version-mismatch");
  });

  it("returns valid=true when schema_version is missing (backward compat)", () => {
    const result = validateSchemaVersion({ status: "completed" });
    expect(result.valid).toBe(true);
    expect(result.failureReason).toBeUndefined();
  });

  it("returns valid=true for non-object input (graceful)", () => {
    expect(validateSchemaVersion(null).valid).toBe(true);
    expect(validateSchemaVersion(undefined).valid).toBe(true);
    expect(validateSchemaVersion("string").valid).toBe(true);
    expect(validateSchemaVersion(123).valid).toBe(true);
    expect(validateSchemaVersion([]).valid).toBe(true);
  });

  it("returns valid=false for future version mismatch", () => {
    const result = validateSchemaVersion({ schema_version: "999" });
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("schema-version-mismatch");
  });

  it("handles empty string version as mismatch", () => {
    const result = validateSchemaVersion({ schema_version: "" });
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("schema-version-mismatch");
  });

  it("accepts schema_version '1.0' (relaxed minor)", () => {
    const result = validateSchemaVersion({ schema_version: "1.0" });
    expect(result.valid).toBe(true);
    expect(result.failureReason).toBeUndefined();
  });

  it("accepts schema_version '1.5' (relaxed minor)", () => {
    const result = validateSchemaVersion({ schema_version: "1.5" });
    expect(result.valid).toBe(true);
    expect(result.failureReason).toBeUndefined();
  });

  it("rejects schema_version '2'", () => {
    const result = validateSchemaVersion({ schema_version: "2" });
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("schema-version-mismatch");
  });

  it("rejects schema_version '0.1'", () => {
    const result = validateSchemaVersion({ schema_version: "0.1" });
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("schema-version-mismatch");
  });
});

describe("validateReviewerHandoff", () => {
  it("returns isValid=true for valid handoff", () => {
    const handoff = createValidHandoff();
    const content = formatHandoff(handoff);
    const filePath = createMockHandoffFile(content);

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.normalized.schema_version).toBe(SCHEMA_VERSION);
      expect(result.normalized.findings).toHaveLength(1);
    }
  });

  it("keeps legacy handoffs valid and defaults memory regression fields", () => {
    const handoff = createValidHandoff();
    const legacyFinding: Record<string, unknown> = { ...handoff.findings[0] };
    delete legacyFinding.memoryRefs;
    delete legacyFinding.isRegression;
    delete legacyFinding.regressionReason;
    const legacyHandoff = { ...handoff, findings: [legacyFinding] };
    const filePath = createMockHandoffFile(formatHandoff(legacyHandoff));

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.normalized.findings[0].memoryRefs).toEqual([]);
      expect(result.normalized.findings[0].isRegression).toBe(false);
      expect(result.normalized.findings[0].regressionReason).toBeUndefined();
    }
  });

  it("returns missing-output for non-existent file", () => {
    const result = validateReviewerHandoff("/nonexistent/path/handoff.md");

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("missing-output");
      expect(result.retryRecommended).toBe(true);
    }
  });

  it("returns missing-fence for file without json fence", () => {
    const filePath = createMockHandoffFile("plain text without fence");

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("missing-fence");
      expect(result.retryRecommended).toBe(true);
    }
  });

  it("returns missing-fence for malformed fence", () => {
    const filePath = createMockHandoffFile("```json\n{\"incomplete\": ");

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("missing-fence");
      expect(result.retryRecommended).toBe(true);
    }
  });

  it("returns invalid-json for malformed JSON inside fence", () => {
    const filePath = createMockHandoffFile("```json\n{\"broken\": }\n```");

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("invalid-json");
      expect(result.retryRecommended).toBe(true);
    }
  });

  it("returns invalid-schema for missing required fields", () => {
    const filePath = createMockHandoffFile("```json\n{\"schema_version\": \"1\"}\n```");

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("invalid-schema");
      expect(result.retryRecommended).toBe(false);
    }
  });

  it("returns invalid-schema for schema version mismatch", () => {
    const handoff = createValidHandoff();
    handoff.schema_version = "0";
    const content = formatHandoff(handoff);
    const filePath = createMockHandoffFile(content);

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("invalid-schema");
      expect(result.retryRecommended).toBe(false);
    }
  });

  it("accepts valid performance classifications", () => {
    const handoff = createValidHandoff();
    handoff.agent = "omre-reviewer-performance";
    handoff.dimension = "performance";
    handoff.findings[0].classification = "provable-regression";
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath, { dimension: "performance" });

    expect(result.isValid).toBe(true);
  });

  it("accepts unknown performance classification with advisory warning", () => {
    const handoff = createValidHandoff();
    handoff.agent = "omre-reviewer-performance";
    handoff.dimension = "performance";
    handoff.findings[0].classification = "provable regression";
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath, { dimension: "performance" });

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.normalized.findings[0].classification).toBe("provable regression");
      expect(result.warnings.some((w) => /classification.*not in standard taxonomy.*performance/i.test(w))).toBe(true);
      expect(result.normalized.meta.notes).not.toMatch(/advisory/i);
    }
  });

  it("accepts valid concurrency classifications", () => {
    const handoff = createValidHandoff();
    handoff.agent = "omre-reviewer-concurrency";
    handoff.dimension = "concurrency";
    handoff.findings[0].classification = "race-condition";
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath, { dimension: "concurrency" });

    expect(result.isValid).toBe(true);
  });

  it("accepts unknown concurrency classification with advisory warning", () => {
    const handoff = createValidHandoff();
    handoff.agent = "omre-reviewer-concurrency";
    handoff.dimension = "concurrency";
    handoff.findings[0].classification = "lost-update";
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath, { dimension: "concurrency" });

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.normalized.findings[0].classification).toBe("lost-update");
      expect(result.warnings.some((w) => /classification.*not in standard taxonomy.*concurrency/i.test(w))).toBe(true);
      expect(result.normalized.meta.notes).not.toMatch(/advisory/i);
    }
  });

  it("auto-corrects meta.total_findings when it does not match findings.length", () => {
    const handoff = createValidHandoff();
    handoff.meta.total_findings = 99;
    const userNotes = "Reviewer notes from author";
    handoff.meta.notes = userNotes;
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.normalized.meta.total_findings).toBe(handoff.findings.length);
      expect(result.warnings.some((w) => /total_findings.*corrected.*99/i.test(w))).toBe(true);
      expect(result.normalized.meta.notes).toBe(userNotes);
    }
  });

  it("warns when memoryRefs contains an id outside allowedMemoryIds", () => {
    const handoff = createValidHandoff();
    handoff.findings[0].memoryRefs = ["mem_auth_1", "mem_unknown"];
    const filePath = createMockHandoffFile(formatHandoff(handoff));
    const expected: ExpectedValues = {
      memoryContext: {
        allowedMemoryIds: ["mem_auth_1"],
        regressionCandidateIds: [],
      },
    };

    const result = validateReviewerHandoff(filePath, expected);

    expect(result.isValid).toBe(true);
    expect(result).not.toHaveProperty("failureReason");
    if (result.isValid) {
      expect(result.warnings).toContain(
        'memoryRefs contains id "mem_unknown" not present in allowedMemoryIds',
      );
    }
  });

  it("warns when isRegression lacks a regressionCandidateIds memory ref", () => {
    const handoff = createValidHandoff();
    handoff.findings[0].isRegression = true;
    handoff.findings[0].memoryRefs = [];
    const filePath = createMockHandoffFile(formatHandoff(handoff));
    const expected: ExpectedValues = {
      memoryContext: {
        allowedMemoryIds: ["mem_fixed_1"],
        regressionCandidateIds: ["mem_fixed_1"],
      },
    };

    const result = validateReviewerHandoff(filePath, expected);

    expect(result.isValid).toBe(true);
    expect(result).not.toHaveProperty("failureReason");
    if (result.isValid) {
      expect(result.warnings).toContain(
        "isRegression=true but memoryRefs do not include any regressionCandidateIds",
      );
    }
  });

  it("skips memoryContext advisories when memoryContext is absent", () => {
    const handoff = createValidHandoff();
    handoff.findings[0].isRegression = true;
    handoff.findings[0].memoryRefs = ["mem_unknown"];
    const filePath = createMockHandoffFile(formatHandoff(handoff));
    const expected: ExpectedValues = {
      dimension: "security",
      target: { kind: "working-tree", value: "src/auth.ts" },
      sliceId: "slice-1",
    };

    const result = validateReviewerHandoff(filePath, expected);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.warnings).not.toContain(
        'memoryRefs contains id "mem_unknown" not present in allowedMemoryIds',
      );
      expect(result.warnings).not.toContain(
        "isRegression=true but memoryRefs do not include any regressionCandidateIds",
      );
    }
  });

  it("emits no warnings when count already matches and classification is standard", () => {
    const handoff = createValidHandoff();
    handoff.meta.total_findings = handoff.findings.length;
    handoff.meta.notes = "";
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.warnings).toEqual([]);
      expect(result.normalized.meta.notes).toBe("");
    }
  });

  it("downgrades non-enum severity with warning (does NOT silently coerce missing field)", () => {
    const handoff = createValidHandoff();
    handoff.findings[0].severity = "blocker" as ReviewerHandoff["findings"][0]["severity"];
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.normalized.findings[0].severity).toBe("medium");
      expect(result.warnings.some((w) => /severity.*blocker.*downgraded.*medium/i.test(w))).toBe(true);
    }
  });

  it("rejects (does not silently downgrade) handoff where severity field is entirely missing", () => {
    const handoff = createValidHandoff();
    delete (handoff.findings[0] as Partial<ReviewerHandoff["findings"][0]>).severity;
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toMatch(/invalid-schema|partial-output/);
    }
  });

  it("still accepts valid severity and confidence values", () => {
    const handoff = createValidHandoff();
    handoff.findings[0].severity = "high";
    handoff.findings[0].confidence = "medium";
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(true);
  });

  it("downgrades invalid severity to 'medium' via .catch() and remains valid", () => {
    const handoff = createValidHandoff();
    handoff.findings[0].severity = "blocker" as ReviewerHandoff["findings"][0]["severity"];
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.normalized.findings[0].severity).toBe("medium");
    }
  });

  it("downgrades invalid confidence to 'low' via .catch() and remains valid", () => {
    const handoff = createValidHandoff();
    handoff.findings[0].confidence = "certain" as ReviewerHandoff["findings"][0]["confidence"];
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.normalized.findings[0].confidence).toBe("low");
    }
  });

  it("returns partial-output for some findings missing required fields", () => {
    const handoff = createValidHandoff();
    handoff.findings = [
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
        memoryRefs: [],
        isRegression: false,
      },
      { id: "sec-2", severity: "high" } as unknown as ReviewerHandoff["findings"][0],
    ];
    const content = formatHandoff(handoff);
    const filePath = createMockHandoffFile(content);

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("partial-output");
      expect(result.retryRecommended).toBe(true);
    }
  });

  it("returns wrong-dimension when dimension mismatches expected", () => {
    const handoff = createValidHandoff();
    const content = formatHandoff(handoff);
    const filePath = createMockHandoffFile(content);
    const expected: ExpectedValues = { dimension: "performance" };

    const result = validateReviewerHandoff(filePath, expected);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("wrong-dimension");
      expect(result.retryRecommended).toBe(false);
    }
  });

  it("returns wrong-target when target mismatches expected", () => {
    const handoff = createValidHandoff();
    const content = formatHandoff(handoff);
    const filePath = createMockHandoffFile(content);
    const expected: ExpectedValues = { target: { kind: "commit", value: "abc123" } };

    const result = validateReviewerHandoff(filePath, expected);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("wrong-target");
      expect(result.retryRecommended).toBe(false);
    }
  });

  it("returns wrong-slice when slice_id mismatches expected", () => {
    const handoff = createValidHandoff();
    const content = formatHandoff(handoff);
    const filePath = createMockHandoffFile(content);
    const expected: ExpectedValues = { sliceId: "slice-2" };

    const result = validateReviewerHandoff(filePath, expected);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("wrong-slice");
      expect(result.retryRecommended).toBe(false);
    }
  });

  it("returns prose-outside-json for text before json fence", () => {
    const handoff = createValidHandoff();
    const content = "This is prose before the fence.\n" + formatHandoff(handoff);
    const filePath = createMockHandoffFile(content);

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("prose-outside-json");
      expect(result.retryRecommended).toBe(false);
    }
  });

  it("accepts valid markdown after json fence", () => {
    const handoff = createValidHandoff();
    const jsonBlock = "```json\n" + JSON.stringify(handoff, null, 2) + "\n```";
    const markdownBody = "\n\n## Findings\n\nSome markdown content here.\n";
    const filePath = createMockHandoffFile(jsonBlock + markdownBody);

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(true);
  });

  it("returns missing-fence for empty json fence", () => {
    const filePath = createMockHandoffFile("```json\n\n```");

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("missing-fence");
      expect(result.retryRecommended).toBe(true);
    }
  });
});

describe("UnifiedFindingSchema defaults", () => {
  it("applies default 'N/A' to omitted file field", () => {
    const raw = {
      id: "sec-1",
      severity: "critical",
      line: 42,
      title: "Hardcoded secret",
      description: "API key is hardcoded",
      evidence: "const API_KEY = 'sk-...'",
      confidence: "high",
      classification: "injection",
    };
    const result = UnifiedFindingSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.file).toBe("N/A");
    }
  });

  it("applies default 'N/A' to omitted line field", () => {
    const raw = {
      id: "sec-1",
      severity: "critical",
      title: "Hardcoded secret",
      description: "API key is hardcoded",
      evidence: "const API_KEY = 'sk-...'",
      confidence: "high",
      classification: "injection",
    };
    const result = UnifiedFindingSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.line).toBe("N/A");
    }
  });
});

describe("NormalizedUnifiedHandoffSchema validation", () => {
  it("reports invalid_type for missing meta.total_findings", () => {
    const raw: Record<string, unknown> = {
      schema_version: SCHEMA_VERSION,
      task_id: "task-123",
    agent: "omre-reviewer-security",
    dimension: "security",
      status: "completed",
      target: { kind: "working-tree", value: "src/auth.ts" },
      slice_id: "slice-1",
      findings: [],
      meta: { notes: "no findings" },
    };
    const result = NormalizedUnifiedHandoffSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue.path).toContain("meta");
      expect(issue.path).toContain("total_findings");
      expect(issue.code).toBe("invalid_type");
    }
  });
});

describe("UnifiedFindingSchema direct validation", () => {
  const validFinding = {
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

  it("safeParse succeeds for valid input and preserves severity/confidence", () => {
    const result = UnifiedFindingSchema.safeParse(validFinding);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.severity).toBe("critical");
      expect(result.data.confidence).toBe("high");
      expect(result.data.id).toBe("sec-1");
    }
  });

  it("safeParse({}) fails for missing required string fields but tolerates enum fields via .catch()", () => {
    const result = UnifiedFindingSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const stringPaths = ["id", "title", "description", "evidence", "classification"];
      for (const path of stringPaths) {
        const issue = result.error.issues.find((i) => i.path.length === 1 && i.path[0] === path);
        expect(issue).toBeDefined();
        expect(issue!.code).toBe("invalid_type");
      }
      for (const path of ["severity", "confidence"]) {
        const issue = result.error.issues.find((i) => i.path.length === 1 && i.path[0] === path);
        expect(issue).toBeUndefined();
      }
    }
  });

  it("safeParse downgrades bogus severity to 'medium' via .catch()", () => {
    const result = UnifiedFindingSchema.safeParse({ ...validFinding, severity: "BOGUS" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.severity).toBe("medium");
    }
  });

  it("safeParse fails when regressionReason exceeds 2000 characters", () => {
    const result = UnifiedFindingSchema.safeParse({
      ...validFinding,
      regressionReason: "x".repeat(2001),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.length === 1 && i.path[0] === "regressionReason");
      expect(issue).toBeDefined();
      expect(issue!.code).toBe("too_big");
    }
  });
});

describe("UnifiedHandoffSchema direct validation", () => {
  const validHandoff = {
    schema_version: SCHEMA_VERSION,
    task_id: "task-123",
    agent: "omre-reviewer-security",
    dimension: "security",
    status: "completed" as const,
    target: { kind: "working-tree", value: "src/auth.ts" },
    slice_id: "slice-1",
    findings: [],
    meta: { total_findings: 1, notes: "" },
  };

  it("safeParse fails with invalid_type for missing meta", () => {
    const { meta: _meta, ...missingMeta } = validHandoff;
    const result = UnifiedHandoffSchema.safeParse(missingMeta);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "meta");
      expect(issue).toBeDefined();
      expect(issue!.path).toEqual(["meta"]);
      expect(issue!.code).toBe("invalid_type");
    }
  });
});

describe("NormalizedUnifiedHandoffSchema direct validation", () => {
  const validHandoff = {
    schema_version: SCHEMA_VERSION,
    task_id: "task-123",
    agent: "omre-reviewer-security",
    dimension: "security",
    status: "completed" as const,
    target: { kind: "working-tree", value: "src/auth.ts" },
    slice_id: "slice-1",
    findings: [
      {
        id: "sec-1",
        severity: "critical" as const,
        file: "src/auth.ts",
        line: 42,
        title: "Hardcoded secret",
        description: "API key is hardcoded",
        evidence: "const API_KEY = 'sk-...'",
        confidence: "high" as const,
        classification: "injection",
      },
    ],
    meta: { total_findings: 1, notes: "" },
  };

  it("safeParse succeeds for valid handoff and returns typed findings", () => {
    const result = NormalizedUnifiedHandoffSchema.safeParse(validHandoff);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.findings).toHaveLength(1);
      expect(result.data.findings[0].severity).toBe("critical");
      expect(result.data.findings[0].confidence).toBe("high");
    }
  });
});

describe("Type equivalence", () => {
  it("ReviewerFinding equals z.infer of UnifiedFindingSchema", () => {
    expectTypeOf<ReviewerFinding>().toEqualTypeOf<z.infer<typeof UnifiedFindingSchema>>();
  });

  it("ReviewerHandoff equals z.infer of NormalizedUnifiedHandoffSchema", () => {
    expectTypeOf<ReviewerHandoff>().toEqualTypeOf<z.infer<typeof NormalizedUnifiedHandoffSchema>>();
  });
});

function formatHandoff(handoff: unknown): string {
  return "```json\n" + JSON.stringify(handoff, null, 2) + "\n```";
}

describe("validateHandoffFromChat", () => {
  it("returns isValid=true for chat content with valid handoff JSON fence", () => {
    const handoff = createValidHandoff();
    const result = validateHandoffFromChat(formatHandoff(handoff));

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.normalized.task_id).toBe("task-123");
      expect(result.normalized.findings).toHaveLength(1);
    }
  });

  it("returns missing-fence when chat content has no json fence", () => {
    const result = validateHandoffFromChat("just some prose without a fence");
    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("missing-fence");
      expect(result.retryRecommended).toBe(true);
    }
  });

  it("returns invalid-json for malformed JSON inside fence", () => {
    const result = validateHandoffFromChat("```json\n{ broken }\n```");
    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("invalid-json");
      expect(result.retryRecommended).toBe(true);
    }
  });

  it("returns invalid-schema for valid JSON missing required fields", () => {
    const result = validateHandoffFromChat('```json\n{"schema_version": "1"}\n```');
    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("invalid-schema");
      expect(result.retryRecommended).toBe(false);
    }
  });

  it("locates a JSON fence even when prose precedes it", () => {
    const handoff = createValidHandoff();
    const content = "Here is my reply with reasoning.\n\n" + formatHandoff(handoff);

    const result = validateHandoffFromChat(content);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.normalized.task_id).toBe("task-123");
    }
  });

  it("respects expected.dimension in chat fallback", () => {
    const handoff = createValidHandoff();
    const content = formatHandoff(handoff);
    const expected: ExpectedValues = { dimension: "performance" };

    const result = validateHandoffFromChat(content, expected);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("wrong-dimension");
    }
  });

  it("iterates multiple json fences and returns the first schema-valid one", () => {
    const handoff = createValidHandoff();
    const decoyFence = "```json\n{\n  \"unrelated\": \"example\"\n}\n```";
    const realFence = formatHandoff(handoff);
    const content = `Here is an example template I considered:\n\n${decoyFence}\n\nHere is the real handoff:\n\n${realFence}\n`;

    const result = validateHandoffFromChat(content);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.normalized.task_id).toBe("task-123");
    }
  });

  it("returns the first valid handoff even when later fences exist", () => {
    const handoff = createValidHandoff();
    const realFence = formatHandoff(handoff);
    const trailingDecoy = "```json\n{ \"junk\": true }\n```";
    const content = `${realFence}\n\nAlso for reference:\n\n${trailingDecoy}\n`;

    const result = validateHandoffFromChat(content);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.normalized.task_id).toBe("task-123");
    }
  });
});

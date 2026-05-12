import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  validateSchemaVersion,
  validateReviewerHandoff,
  type ReviewerHandoff,
  type ExpectedValues,
} from "../../src/workflow/validate-result.js";
import { SCHEMA_VERSION } from "../../src/agents/schemas.js";

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
        description: "API key is hardcoded in source",
        evidence: "const API_KEY = 'sk-...'",
        confidence: "high",
        classification: "injection",
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
    handoff.agent = "reviewer-performance";
    handoff.dimension = "performance";
    handoff.findings[0].classification = "provable-regression";
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath, { dimension: "performance" });

    expect(result.isValid).toBe(true);
  });

  it("returns invalid-schema for invalid performance classifications", () => {
    const handoff = createValidHandoff();
    handoff.agent = "reviewer-performance";
    handoff.dimension = "performance";
    handoff.findings[0].classification = "provable regression";
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath, { dimension: "performance" });

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("invalid-schema");
      expect(result.retryRecommended).toBe(false);
    }
  });

  it("accepts valid concurrency classifications", () => {
    const handoff = createValidHandoff();
    handoff.agent = "reviewer-concurrency";
    handoff.dimension = "concurrency";
    handoff.findings[0].classification = "race-condition";
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath, { dimension: "concurrency" });

    expect(result.isValid).toBe(true);
  });

  it("returns invalid-schema for invalid concurrency classifications", () => {
    const handoff = createValidHandoff();
    handoff.agent = "reviewer-concurrency";
    handoff.dimension = "concurrency";
    handoff.findings[0].classification = "lost-update";
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath, { dimension: "concurrency" });

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("invalid-schema");
      expect(result.retryRecommended).toBe(false);
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

  it("returns invalid-schema for invalid severity values", () => {
    const handoff = createValidHandoff();
    handoff.findings[0].severity = "blocker" as ReviewerHandoff["findings"][0]["severity"];
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("invalid-schema");
      expect(result.retryRecommended).toBe(false);
    }
  });

  it("returns invalid-schema for invalid confidence values", () => {
    const handoff = createValidHandoff();
    handoff.findings[0].confidence = "certain" as ReviewerHandoff["findings"][0]["confidence"];
    const filePath = createMockHandoffFile(formatHandoff(handoff));

    const result = validateReviewerHandoff(filePath);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.failureReason).toBe("invalid-schema");
      expect(result.retryRecommended).toBe(false);
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

function formatHandoff(handoff: ReviewerHandoff): string {
  return "```json\n" + JSON.stringify(handoff, null, 2) + "\n```";
}

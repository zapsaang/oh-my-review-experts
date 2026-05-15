import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeHandoff, type HandoffPayload } from "../../src/tools/handoff.js";
import { validateReviewerHandoff, validateHandoffFromChat } from "../../src/workflow/validate-result.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { SCHEMA_VERSION } from "../../src/agents/schemas.js";

function withTempCwd<T>(fn: (cwd: string) => T): T {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omre-roundtrip-"));
  try {
    return fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function basePayload(overrides: Partial<HandoffPayload> = {}): HandoffPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    taskId: "task-rt-1",
    agent: "reviewer-security",
    dimension: "security",
    status: "completed",
    target: { kind: "working-tree", value: "src/auth.ts" },
    sliceId: "slice-1",
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
    ...overrides,
  };
}

describe("handoff roundtrip", () => {
  it("write then validate succeeds for a canonical handoff", () => {
    withTempCwd((cwd) => {
      const filePath = writeHandoff(DEFAULT_CONFIG, basePayload(), cwd, "run-1");
      const result = validateReviewerHandoff(filePath);

      expect(result.isValid).toBe(true);
      if (result.isValid) {
        expect(result.normalized.findings).toHaveLength(1);
        expect(result.normalized.findings[0].severity).toBe("critical");
      }
    });
  });

  it("validate accepts a handoff written with extra fields on findings", () => {
    withTempCwd((cwd) => {
      const payload = basePayload({
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
            recommendation: "Move to env var",
            impact: "Credential leak via repo",
            category: "security",
          } as HandoffPayload["findings"][number],
        ],
      });
      const filePath = writeHandoff(DEFAULT_CONFIG, payload, cwd, "run-2");
      const result = validateReviewerHandoff(filePath);

      expect(result.isValid).toBe(true);
      if (result.isValid) {
        const finding = result.normalized.findings[0] as typeof result.normalized.findings[number] & {
          recommendation?: string;
          impact?: string;
        };
        expect(finding.recommendation).toBe("Move to env var");
        expect(finding.impact).toBe("Credential leak via repo");
      }
    });
  });

  it("validate emits classification advisory for non-standard performance value", () => {
    withTempCwd((cwd) => {
      const payload = basePayload({
        agent: "reviewer-performance",
        dimension: "performance",
        findings: [
          {
            id: "perf-1",
            severity: "high",
            file: "src/hot.ts",
            line: 10,
            title: "N+1 query",
            description: "Loop fires DB query per row",
            evidence: "for (const x of rows) { db.query(x.id) }",
            confidence: "high",
            classification: "memory-leak",
          },
        ],
      });
      const filePath = writeHandoff(DEFAULT_CONFIG, payload, cwd, "run-3");
      const result = validateReviewerHandoff(filePath, { dimension: "performance" });

      expect(result.isValid).toBe(true);
      if (result.isValid) {
        expect(result.normalized.findings[0].classification).toBe("memory-leak");
        expect(result.warnings.some((w) => /classification.*not in standard taxonomy.*performance/i.test(w))).toBe(true);
      }
    });
  });

  it("validate auto-corrects total_findings when written count diverges", () => {
    withTempCwd((cwd) => {
      const payload = basePayload();
      const filePath = writeHandoff(DEFAULT_CONFIG, payload, cwd, "run-4");

      const original = fs.readFileSync(filePath, "utf-8");
      const tampered = original.replace(/"total_findings":\s*\d+/, '"total_findings": 99');
      fs.writeFileSync(filePath, tampered, "utf-8");

      const result = validateReviewerHandoff(filePath);

      expect(result.isValid).toBe(true);
      if (result.isValid) {
        expect(result.normalized.meta.total_findings).toBe(payload.findings.length);
        expect(result.warnings.some((w) => /total_findings.*corrected.*99/i.test(w))).toBe(true);
      }
    });
  });

  it("validate accepts schema_version 1.0 (relaxed minor)", () => {
    withTempCwd((cwd) => {
      const filePath = writeHandoff(DEFAULT_CONFIG, basePayload(), cwd, "run-5");

      const original = fs.readFileSync(filePath, "utf-8");
      const tampered = original.replace(/"schema_version":\s*"1"/, '"schema_version": "1.0"');
      fs.writeFileSync(filePath, tampered, "utf-8");

      const result = validateReviewerHandoff(filePath);

      expect(result.isValid).toBe(true);
    });
  });

  it("chat fallback recovers a handoff embedded in a prose-rich reply", () => {
    withTempCwd((cwd) => {
      const filePath = writeHandoff(DEFAULT_CONFIG, basePayload(), cwd, "run-6");
      const writtenContent = fs.readFileSync(filePath, "utf-8");

      const chatBody = [
        "Here is my review summary:",
        "",
        "STATUS: completed",
        "SUMMARY:",
        "- Found 1 critical issue",
        "",
        writtenContent,
        "",
        "Let me know if you need clarification.",
      ].join("\n");

      const result = validateHandoffFromChat(chatBody);

      expect(result.isValid).toBe(true);
      if (result.isValid) {
        expect(result.normalized.task_id).toBe("task-rt-1");
        expect(result.normalized.findings).toHaveLength(1);
      }
    });
  });

  it("downgrades invalid severity end-to-end via .catch()", () => {
    withTempCwd((cwd) => {
      const payload = basePayload({
        findings: [
          {
            id: "sec-1",
            severity: "blocker" as HandoffPayload["findings"][number]["severity"],
            file: "src/auth.ts",
            line: 42,
            title: "Hardcoded secret",
            description: "API key is hardcoded",
            evidence: "const API_KEY = 'sk-...'",
            confidence: "high",
            classification: "injection",
          },
        ],
      });
      const filePath = writeHandoff(DEFAULT_CONFIG, payload, cwd, "run-7");
      const result = validateReviewerHandoff(filePath);

      expect(result.isValid).toBe(true);
      if (result.isValid) {
        expect(result.normalized.findings[0].severity).toBe("medium");
      }
    });
  });
});

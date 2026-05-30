import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractFromReport } from "../../../src/memory/extractor/report-extractor.js";
import { MemoryExtractionError } from "../../../src/memory/extractor/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../fixtures/latest.json");
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();

  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeTempFile(fileName: string, contents: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-extractor-"));
  tempDirs.push(tempDir);

  const reportPath = path.join(tempDir, fileName);
  fs.writeFileSync(reportPath, contents, "utf-8");
  return reportPath;
}

function writeTempReport(report: unknown): string {
  return writeTempFile("report.json", JSON.stringify(report));
}

describe("extractFromReport", () => {
  it("extracts all fixture findings and maps UnifiedFinding fields to RawFinding", () => {
    const findings = extractFromReport(fixturePath);

    expect(findings).toHaveLength(3);
    expect(findings[0]).toEqual({
      reviewer: "auth-module",
      severity: "high",
      category: "secret-leak",
      title: "Hardcoded JWT secret in source",
      problem:
        "The JWT secret is embedded directly in the source code, making it visible in version control.",
      evidence: "const SECRET = 'bearer abcdefghijklmnopqrstuvwxyz12345';",
      recommendation: "Move the secret to an environment variable and inject it at runtime.",
      locations: [{ path: "src/auth.ts", line: 42 }],
    });
  });

  it("preserves string line values and leaves missing evidence undefined", () => {
    const findings = extractFromReport(fixturePath);
    const missingEvidenceFinding = findings.find(
      (finding) => finding.title === "Missing rate limit on login endpoint",
    );

    expect(missingEvidenceFinding).toBeDefined();
    expect(missingEvidenceFinding).toMatchObject({
      reviewer: "auth-module",
      severity: "medium",
      category: "authz-gap",
      problem:
        "The login route does not enforce any rate limiting, leaving it open to brute-force attacks.",
      locations: [{ path: "src/middleware.ts", line: "87-92" }],
    });
    expect(missingEvidenceFinding?.evidence).toBeUndefined();
  });

  it("throws MemoryExtractionError with the report path and parse cause for invalid JSON", () => {
    const reportPath = writeTempFile("broken.json", "{ not valid json");

    let thrown: unknown;
    try {
      extractFromReport(reportPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MemoryExtractionError);
    expect((thrown as MemoryExtractionError).sourcePath).toBe(reportPath);
    expect((thrown as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it("returns an empty list and warns when slices is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reportPath = writeTempReport({ findings: [{ title: "top-level finding must be ignored" }] });

    expect(extractFromReport(reportPath)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("missing or invalid slices"));
  });

  it("skips malformed findings without a title and keeps processing the slice", () => {
    const reportPath = writeTempReport({
      slices: [
        {
          slice_id: "quality-slice",
          findings: [
            {
              severity: "high",
              file: "src/bad.ts",
              line: 10,
              description: "This finding is malformed because it has no title.",
              classification: "malformed",
            },
            {
              severity: "low",
              file: "src/good.ts",
              line: 12,
              title: "Valid finding survives",
              description: "The extractor should continue after skipping the malformed finding.",
              classification: "quality",
            },
          ],
        },
      ],
    });

    expect(extractFromReport(reportPath)).toEqual([
      {
        reviewer: "quality-slice",
        severity: "low",
        category: "quality",
        title: "Valid finding survives",
        problem: "The extractor should continue after skipping the malformed finding.",
        locations: [{ path: "src/good.ts", line: 12 }],
      },
    ]);
  });

  it("prefers finding source for reviewer and skips N/A locations", () => {
    const reportPath = writeTempReport({
      slices: [
        {
          slice_id: "fallback-reviewer",
          findings: [
            {
              source: "security-reviewer",
              severity: "medium",
              file: "N/A",
              line: "N/A",
              title: "Global configuration issue",
              description: "This finding applies to generated configuration rather than a file.",
              classification: "configuration",
              recommendation: "Document the generated configuration source.",
            },
          ],
        },
      ],
    });

    expect(extractFromReport(reportPath)).toEqual([
      {
        reviewer: "security-reviewer",
        severity: "medium",
        category: "configuration",
        title: "Global configuration issue",
        problem: "This finding applies to generated configuration rather than a file.",
        recommendation: "Document the generated configuration source.",
        locations: [],
      },
    ]);
  });
});

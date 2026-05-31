import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { extractRawFindings, extractStructuredFindings } from "../../../src/memory/extractor/index.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const reportFixturePath = join(testDir, "../fixtures/latest.json");
const handoffFixturePath = join(testDir, "../fixtures/handoff-sample.md");
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `omre-extractor-index-${process.pid}-${tempDirs.length}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

describe("extractRawFindings", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("concatenates findings from both reports and handoffs when sources includes both", () => {
    const handoffDir = makeTempDir();
    copyFileSync(handoffFixturePath, join(handoffDir, "security.md"));

    const findings = extractRawFindings({
      reportPath: reportFixturePath,
      handoffDir,
      sources: ["reports", "handoffs"],
    });

    expect(findings.length).toBeGreaterThan(0);
    // latest.json has 3 findings; handoff-sample.md has 2 findings
    expect(findings).toHaveLength(5);

    // Verify report findings are present
    const reportTitles = findings
      .filter((f) => f.reviewer === "auth-module" || f.reviewer === "queue-worker")
      .map((f) => f.title);
    expect(reportTitles).toContain("Hardcoded JWT secret in source");
    expect(reportTitles).toContain("O(n²) loop in job deduplication");

    // Verify handoff findings are present
    const handoffTitles = findings
      .filter((f) => f.reviewer === "omre-reviewer-security")
      .map((f) => f.title);
    expect(handoffTitles).toContain("Hardcoded JWT secret in source");
    expect(handoffTitles).toContain("Missing rate limit on login endpoint");
  });

  it("returns report and handoff findings separately while preserving flat compat order", () => {
    const handoffDir = makeTempDir();
    copyFileSync(handoffFixturePath, join(handoffDir, "security.md"));

    const structured = extractStructuredFindings({
      reportPath: reportFixturePath,
      handoffDir,
    });
    const flat = extractRawFindings({
      reportPath: reportFixturePath,
      handoffDir,
      sources: ["reports", "handoffs"],
    });

    expect(structured.report).toHaveLength(3);
    expect(structured.handoffs).toHaveLength(2);
    expect(structured.report.every((f) => f.reviewer === "auth-module" || f.reviewer === "queue-worker")).toBe(true);
    expect(structured.handoffs.every((f) => f.reviewer === "omre-reviewer-security")).toBe(true);
    expect(flat).toEqual([...structured.report, ...structured.handoffs]);
  });

  it("structured extraction prevents position-slicing fragility", () => {
    const handoffDir = makeTempDir();
    copyFileSync(handoffFixturePath, join(handoffDir, "security.md"));

    const rawFindings = extractRawFindings({
      reportPath: reportFixturePath,
      handoffDir,
      sources: ["reports", "handoffs"],
    });
    const structured = extractStructuredFindings({
      reportPath: reportFixturePath,
      handoffDir,
      sources: ["reports", "handoffs"],
    });

    expect(extractStructuredFindings).toBeTypeOf("function");
    expect(rawFindings).toEqual([...structured.report, ...structured.handoffs]);

    const reportFindingCount = structured.report.length;
    const sameFlatFindingsWithDifferentInternalOrder = [
      ...structured.handoffs,
      ...structured.report,
    ];

    // Mirrors the HEAD~1 cli.ts split: rawFindings.slice(0, reportFindingCount).
    const positionSlicedReportFindings = sameFlatFindingsWithDifferentInternalOrder.slice(0, reportFindingCount);
    const positionSlicedHandoffFindings = sameFlatFindingsWithDifferentInternalOrder.slice(reportFindingCount);

    expect(positionSlicedReportFindings).not.toEqual(structured.report);
    expect(positionSlicedHandoffFindings).not.toEqual(structured.handoffs);
    expect(positionSlicedReportFindings.some((f) => f.reviewer === "omre-reviewer-security")).toBe(true);
    expect(positionSlicedHandoffFindings.some((f) => f.reviewer === "auth-module" || f.reviewer === "queue-worker")).toBe(true);
    expect(structured.report).toHaveLength(3);
    expect(structured.handoffs).toHaveLength(2);
    expect(structured.report.every((f) => f.reviewer === "auth-module" || f.reviewer === "queue-worker")).toBe(true);
    expect(structured.handoffs.every((f) => f.reviewer === "omre-reviewer-security")).toBe(true);
  });

  it("returns only report findings when sources is ['reports']", () => {
    const findings = extractRawFindings({
      reportPath: reportFixturePath,
      sources: ["reports"],
    });

    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.reviewer === "auth-module" || f.reviewer === "queue-worker")).toBe(true);
  });

  it("returns only handoff findings when sources is ['handoffs']", () => {
    const handoffDir = makeTempDir();
    copyFileSync(handoffFixturePath, join(handoffDir, "security.md"));

    const findings = extractRawFindings({
      handoffDir,
      sources: ["handoffs"],
    });

    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.reviewer === "omre-reviewer-security")).toBe(true);
  });

  it("returns an empty array when sources is empty", () => {
    const findings = extractRawFindings({
      reportPath: reportFixturePath,
      handoffDir: makeTempDir(),
      sources: [],
    });

    expect(findings).toEqual([]);
  });

  it("ignores reportPath when sources does not include 'reports'", () => {
    const handoffDir = makeTempDir();
    copyFileSync(handoffFixturePath, join(handoffDir, "security.md"));

    const findings = extractRawFindings({
      reportPath: reportFixturePath,
      handoffDir,
      sources: ["handoffs"],
    });

    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.reviewer === "omre-reviewer-security")).toBe(true);
  });

  it("ignores handoffDir when sources does not include 'handoffs'", () => {
    const handoffDir = makeTempDir();
    copyFileSync(handoffFixturePath, join(handoffDir, "security.md"));

    const findings = extractRawFindings({
      reportPath: reportFixturePath,
      handoffDir,
      sources: ["reports"],
    });

    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.reviewer === "auth-module" || f.reviewer === "queue-worker")).toBe(true);
  });
});

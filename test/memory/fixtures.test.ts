import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

describe("fixture smoke tests", () => {
  it("latest.json parses and has the expected report shape", () => {
    const raw = fs.readFileSync(path.join(fixturesDir, "latest.json"), "utf-8");
    const report = JSON.parse(raw);

    expect(report).toHaveProperty("run_id");
    expect(report).toHaveProperty("status");
    expect(report).toHaveProperty("slices");
    expect(Array.isArray(report.slices)).toBe(true);
    expect(report.slices.length).toBeGreaterThan(0);

    expect(report.slices[0]).toHaveProperty("slice_id");
    expect(report.slices[0]).toHaveProperty("findings");
    expect(Array.isArray(report.slices[0].findings)).toBe(true);

    expect(report).toHaveProperty("summary");
    expect(report).toHaveProperty("degraded_slices");
    expect(report).toHaveProperty("missing_dimensions_global");

    // Verify 3 findings across 2 slices
    const totalFindings = report.slices.reduce(
      (acc: number, s: { findings: unknown[] }) => acc + s.findings.length,
      0,
    );
    expect(totalFindings).toBe(3);
    expect(report.slices.length).toBe(2);

    // One finding missing evidence
    const allFindings = report.slices.flatMap(
      (s: { findings: Record<string, unknown>[] }) => s.findings,
    );
    const missingEvidence = allFindings.find((f: Record<string, unknown>) => !("evidence" in f));
    expect(missingEvidence).toBeDefined();

    // One finding with line as string
    const stringLine = allFindings.find(
      (f: Record<string, unknown>) => typeof f.line === "string",
    );
    expect(stringLine).toBeDefined();
  });

  it("handoff-sample.md has a parseable JSON header block", () => {
    const raw = fs.readFileSync(path.join(fixturesDir, "handoff-sample.md"), "utf-8");

    const jsonBlockMatch = raw.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonBlockMatch).toBeTruthy();

    const header = JSON.parse(jsonBlockMatch![1]);

    expect(header).toHaveProperty("agent");
    expect(header).toHaveProperty("findings");
    expect(Array.isArray(header.findings)).toBe(true);
    expect(header.findings.length).toBeGreaterThan(0);

    // Verify expected UnifiedHandoffSchema fields
    expect(header).toHaveProperty("schema_version");
    expect(header).toHaveProperty("task_id");
    expect(header).toHaveProperty("dimension");
    expect(header).toHaveProperty("status");
    expect(header).toHaveProperty("target");
    expect(header).toHaveProperty("slice_id");
    expect(header).toHaveProperty("meta");
  });

  it("handoff-sample.md has the expected markdown body structure", () => {
    const raw = fs.readFileSync(path.join(fixturesDir, "handoff-sample.md"), "utf-8");

    expect(raw).toContain("# Review Handoff");
    expect(raw).toContain("## Metadata");
    expect(raw).toContain("## Findings");

    // Finding headers are "### Finding N" with no title in header
    expect(raw).toMatch(/### Finding 1\n/);
    expect(raw).toMatch(/### Finding 2\n/);

    // Fields are hyphen lists, not bold blocks
    expect(raw).toMatch(/\n- Severity: /);
    expect(raw).toMatch(/\n- Category: /);
    expect(raw).toMatch(/\n- File: /);
    expect(raw).toMatch(/\n- Lines: /);
    expect(raw).toMatch(/\n- Evidence: /);
    expect(raw).toMatch(/\n- Impact: /);
    expect(raw).toMatch(/\n- Recommendation: /);

    // No YAML frontmatter
    expect(raw).not.toMatch(/^---\n/);

    // No bold blocks like **Severity:**
    expect(raw).not.toMatch(/\*\*Severity:\*\*/);
  });
});

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeMemoryFinding,
  normalizeSeverity,
  type NormalizeContext,
} from "../../src/memory/normalize.js";
import type { RedactedRawFinding } from "../../src/memory/redaction.js";
import { MemoryFindingSchema } from "../../src/memory/schema.js";
import { tokenizeForSimilarity } from "../../src/memory/similarity.js";

const timestamp = "2026-05-28T00:00:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function createRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omre-normalize-"));
  tempDirs.push(repoRoot);

  const packageDir = path.join(repoRoot, "packages", "api");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@app/api" }), "utf8");

  return repoRoot;
}

function context(repoRoot = createRepo()): NormalizeContext {
  return {
    runId: "run-20260528",
    sourceType: "report",
    sourcePath: ".omre/reports/latest.json",
    createdAt: timestamp,
    repoRoot,
    repoRootHash: "repo1234567890abcd",
  };
}

function rawFinding(overrides: Partial<RedactedRawFinding> = {}): RedactedRawFinding {
  return {
    reviewer: "security",
    severity: "high",
    category: "authz",
    title: "Missing tenant scope",
    problem: "Query fetches tenant records without filtering by tenant_id.",
    evidence: "db.query('select * from tenants')",
    recommendation: "Add tenant_id to the query predicate.",
    locations: [{ path: "packages/api/src/tenants.ts", line: 42 }],
    ...overrides,
  };
}

function expectValidMemoryFinding(finding: unknown): void {
  const result = MemoryFindingSchema.safeParse(finding);
  if (!result.success) {
    throw new Error(JSON.stringify(result.error.issues, null, 2));
  }

  expect(result.success).toBe(true);
}

describe("normalizeSeverity", () => {
  it.each([
    ["blocker", "critical"],
    ["critical", "critical"],
    ["high", "high"],
    ["info", "low"],
    ["low", "low"],
    ["unknown", "medium"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(normalizeSeverity(input)).toBe(expected);
  });
});

describe("normalizeMemoryFinding", () => {
  it("builds a strict MemoryFinding and resolves packagePath from the primary location", () => {
    const raw = rawFinding();
    const finding = normalizeMemoryFinding(raw, context());

    expectValidMemoryFinding(finding);
    expect(finding).toMatchObject({
      schemaVersion: 1,
      repo: {
        rootHash: "repo1234567890abcd",
        packagePath: path.join("packages", "api"),
      },
      origin: {
        runId: "run-20260528",
        sourceType: "report",
        sourcePath: ".omre/reports/latest.json",
        createdAt: timestamp,
      },
      reviewer: "security",
      severity: "high",
      status: "open",
      category: "authz",
      title: raw.title,
      problem: raw.problem,
      evidence: raw.evidence,
      locations: [{ path: "packages/api/src/tenants.ts", line: 42 }],
      occurrence: {
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        count: 1,
        runIds: ["run-20260528"],
      },
      metadata: {
        evidenceTruncated: false,
        problemTruncated: false,
        recommendationTruncated: false,
        sourceMalformed: false,
      },
    });
    expect(finding.id).toMatch(/^mem_[a-z0-9]{16,64}$/);
    expect(finding.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(finding.contentHash).toBe(
      sha256(JSON.stringify({
        reviewer: raw.reviewer,
        category: raw.category,
        title: raw.title,
        problem: raw.problem,
        paths: raw.locations.map((location) => location.path),
      })),
    );
    expect(finding.searchable.redactedText).toContain(raw.recommendation);
    expect(finding.searchable.tokens).toEqual(tokenizeForSimilarity(`${raw.title} ${raw.problem} ${raw.evidence}`));
    expect(finding.recommendation).toBe(raw.recommendation);
    expect(finding.tags).toEqual([]);
    expect(finding).not.toHaveProperty("confidence");
    expect(finding).not.toHaveProperty("sourceFindingId");
    expect(finding.repo.packageName).toBe("@app/api");
    expect(finding.repo.packageKind).toBe("standalone-package");
  });

  it("uses a placeholder evidence value, sourceMalformed, and confirmed status when evidence is missing", () => {
    const { evidence: _evidence, ...rawWithoutEvidence } = rawFinding();

    const finding = normalizeMemoryFinding(rawWithoutEvidence, context());

    expectValidMemoryFinding(finding);
    expect(finding.evidence).toBe("[EVIDENCE_MISSING]");
    expect(finding.metadata.sourceMalformed).toBe(true);
    expect(finding.status).toBe("confirmed");
  });

  it("treats empty evidence as malformed source data", () => {
    const finding = normalizeMemoryFinding(rawFinding({ evidence: "   " }), context());

    expectValidMemoryFinding(finding);
    expect(finding.evidence).toBe("[EVIDENCE_MISSING]");
    expect(finding.metadata.sourceMalformed).toBe(true);
    expect(finding.status).toBe("confirmed");
  });

  it("truncates oversized problem text and marks the problemTruncated flag", () => {
    const problem = "p".repeat(9_000);

    const finding = normalizeMemoryFinding(rawFinding({ problem }), context());

    expectValidMemoryFinding(finding);
    expect(finding.problem.length).toBeLessThan(problem.length);
    expect(finding.metadata.problemTruncated).toBe(true);
  });

  it("folds recommendation into searchable text and includes truncated recommendation field", () => {
    const recommendation = "r".repeat(9_000);

    const finding = normalizeMemoryFinding(rawFinding({ recommendation }), context());

    expectValidMemoryFinding(finding);
    expect(finding.searchable.redactedText).toContain("r".repeat(100));
    expect(finding.metadata.recommendationTruncated).toBe(true);
    expect(finding.recommendation).toBe("r".repeat(4_000));
  });

  it("normalizes locations to path and line only, numeric strings to numbers, and keeps at most 16", () => {
    const locations = [
      { path: "packages/api/src/numeric-string.ts", line: "42", lineText: "drop me", symbol: "dropMe" },
      { path: "packages/api/src/string-line.ts", line: "abc", lineText: "drop me", symbol: "dropMe" },
      ...Array.from({ length: 16 }, (_, index) => ({
        path: `packages/api/src/extra-${index}.ts`,
        line: index + 1,
        lineText: "drop me",
        symbol: "dropMe",
      })),
    ];

    const finding = normalizeMemoryFinding(
      rawFinding({ locations: locations as RedactedRawFinding["locations"] }),
      context(),
    );

    expectValidMemoryFinding(finding);
    expect(finding.locations).toHaveLength(16);
    expect(finding.locations[0]).toEqual({ path: "packages/api/src/numeric-string.ts", line: 42 });
    expect(finding.locations[1]).toEqual({ path: "packages/api/src/string-line.ts", line: "abc" });
    expect(finding.locations[0]).not.toHaveProperty("lineText");
    expect(finding.locations[0]).not.toHaveProperty("symbol");
  });

  describe("field mapping", () => {
    it("maps raw finding id to sourceFindingId", () => {
      const raw = { ...rawFinding(), id: "finding-123" } as RedactedRawFinding;
      const finding = normalizeMemoryFinding(raw, context());
      expect(finding.sourceFindingId).toBe("finding-123");
    });

    it("maps raw recommendation to recommendation field", () => {
      const raw = rawFinding({ recommendation: "Use parameterized queries" });
      const finding = normalizeMemoryFinding(raw, context());
      expect(finding.recommendation).toBe("Use parameterized queries");
    });

    it("normalizes raw confidence to high/medium/low", () => {
      const highRaw = { ...rawFinding(), confidence: "HIGH" } as RedactedRawFinding;
      expect(normalizeMemoryFinding(highRaw, context()).confidence).toBe("high");

      const mediumRaw = { ...rawFinding(), confidence: "Medium" } as RedactedRawFinding;
      expect(normalizeMemoryFinding(mediumRaw, context()).confidence).toBe("medium");

      const lowRaw = { ...rawFinding(), confidence: "low" } as RedactedRawFinding;
      expect(normalizeMemoryFinding(lowRaw, context()).confidence).toBe("low");
    });

    it("defaults tags to empty array when no reliable source", () => {
      const raw = rawFinding();
      const finding = normalizeMemoryFinding(raw, context());
      expect(finding.tags).toEqual([]);
    });

    it("includes packageName and packageKind from package resolver", () => {
      const raw = rawFinding({ locations: [{ path: "packages/api/src/tenants.ts", line: 42 }] });
      const finding = normalizeMemoryFinding(raw, context());
      expect(finding.repo.packageName).toBe("@app/api");
      expect(finding.repo.packageKind).toBe("standalone-package");
    });

    it("does not fabricate confidence when raw finding lacks it", () => {
      const raw = rawFinding();
      const finding = normalizeMemoryFinding(raw, context());
      expect(finding).not.toHaveProperty("confidence");
    });
  });
});

import { describe, expect, it } from "vitest";
import { buildStrongFingerprint, normalizeTitleKey, simhashLikeKey } from "../../src/memory/fingerprint.js";
import type { MemoryFinding } from "../../src/memory/schema.js";

const timestamp = "2026-05-28T00:00:00.000Z";

function validFinding(overrides: Partial<MemoryFinding> = {}): MemoryFinding {
  const finding = {
    schemaVersion: 1,
    id: "mem_abcdef1234567890",
    fingerprint: "fp1234567890abcdef",
    repo: {
      rootHash: "repo1234567890abcd",
      packagePath: ".",
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
    title: "Missing tenant_id",
    problem: "Queries fetch tenant records without scoping by tenant_id.",
    evidence: "db.query('select * from tenants')",
    locations: [{ path: "src/tenants.ts", line: 42 }],
    occurrence: {
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      count: 1,
      runIds: ["run-20260528"],
    },
    searchable: {
      redactedText: "tenant query missing tenant_id",
      tokens: ["tenant", "query", "tenant_id"],
    },
    metadata: {
      evidenceTruncated: false,
      problemTruncated: false,
      recommendationTruncated: false,
      sourceMalformed: false,
    },
    tags: [],
    contentHash: "ch1234567890abcdef",
  } satisfies MemoryFinding;

  return { ...finding, ...overrides };
}

describe("normalizeTitleKey", () => {
  it("lowercases, replaces punctuation with spaces, collapses whitespace, and slices to 80 chars", () => {
    const normalized = normalizeTitleKey(`  SQL!!! Injection??? ${"A".repeat(100)}  `);

    expect(normalized).toBe(`sql injection ${"a".repeat(66)}`);
    expect(normalized).toHaveLength(80);
  });

  it("normalizes punctuation variants of tenant_id titles to the same key", () => {
    expect(normalizeTitleKey("Missing tenant_id")).toBe(normalizeTitleKey("missing tenant id"));
  });
});

describe("simhashLikeKey", () => {
  it("hashes sorted first tokens into a deterministic 16-character hex key", () => {
    const first = simhashLikeKey("gamma alpha beta", { maxTokens: 3 });
    const second = simhashLikeKey("beta gamma alpha", { maxTokens: 3 });

    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(second).toBe(first);
  });

  it("uses maxTokens before hashing", () => {
    expect(simhashLikeKey("alpha beta gamma", { maxTokens: 2 })).not.toBe(
      simhashLikeKey("alpha beta gamma", { maxTokens: 3 }),
    );
  });
});

describe("buildStrongFingerprint", () => {
  it("returns the same full sha256 hex fingerprint for the same deterministic input", () => {
    const finding = validFinding();
    const first = buildStrongFingerprint(finding);
    const second = buildStrongFingerprint(validFinding({ id: "mem_1234567890abcdef" }));

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("changes when the primary location path changes", () => {
    const first = buildStrongFingerprint(validFinding({ locations: [{ path: "src/tenants.ts", line: 42 }] }));
    const second = buildStrongFingerprint(validFinding({ locations: [{ path: "src/accounts.ts", line: 42 }] }));

    expect(second).not.toBe(first);
  });

  it("includes numeric primary location lines", () => {
    const first = buildStrongFingerprint(validFinding({ locations: [{ path: "src/tenants.ts", line: 42 }] }));
    const second = buildStrongFingerprint(validFinding({ locations: [{ path: "src/tenants.ts", line: 43 }] }));

    expect(second).not.toBe(first);
  });

  it("excludes missing and string primary location lines without throwing", () => {
    const missingLine = buildStrongFingerprint(validFinding({ locations: [{ path: "src/tenants.ts" }] }));
    const stringLine = buildStrongFingerprint(validFinding({ locations: [{ path: "src/tenants.ts", line: "42" }] }));

    expect(stringLine).toBe(missingLine);
  });

  it("uses normalized title keys when building the fingerprint", () => {
    const underscoreTitle = buildStrongFingerprint(validFinding({ title: "Missing tenant_id" }));
    const spacedTitle = buildStrongFingerprint(validFinding({ title: "missing tenant id" }));

    expect(spacedTitle).toBe(underscoreTitle);
  });
});

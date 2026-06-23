import { MemoryFindingSchema, type MemoryFinding } from "../../../src/memory/schema.js";

export function makeFinding(overrides: Partial<MemoryFinding> = {}): MemoryFinding {
  const base = {
    schemaVersion: 1,
    id: "mem_0000000000000001",
    fingerprint: "fp1234567890abcdef",
    repo: {
      rootHash: "repo1234567890abcd",
      packagePath: ".",
    },
    origin: {
      runId: "run-search",
      sourceType: "report",
      sourcePath: ".omre/reports/latest.json",
      createdAt: "2026-05-28T00:00:00.000Z",
    },
    reviewer: "security",
    severity: "high",
    status: "open",
    category: "authz",
    title: "Missing tenant isolation",
    problem: "Tenant records are queried without tenant isolation checks.",
    evidence: "db.query('select * from tenants')",
    locations: [{ path: "src/tenants.ts", line: 42 }],
    occurrence: {
      firstSeenAt: "2026-05-28T00:00:00.000Z",
      lastSeenAt: "2026-05-28T00:00:00.000Z",
      count: 1,
      runIds: ["run-search"],
    },
    searchable: {
      redactedText: overrides.title ?? "placeholder finding",
      tokens: [`token${(overrides.id ?? "mem_0000000000000000").slice(-4)}`],
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

  const merged = { ...base, ...overrides };
  return MemoryFindingSchema.parse(merged) as MemoryFinding;
}

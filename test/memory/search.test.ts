import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { searchMemory } from "../../src/memory/search.js";
import { tokenizeForSimilarity } from "../../src/memory/similarity.js";
import type { MemoryFinding } from "../../src/memory/schema.js";

const timestamp = "2026-05-28T00:00:00.000Z";

function validFinding(overrides: Partial<MemoryFinding> = {}): MemoryFinding {
  const finding = {
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
      createdAt: timestamp,
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
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      count: 1,
      runIds: ["run-search"],
    },
    searchable: {
      redactedText: "tenant isolation",
      tokens: ["tenant", "isolation"],
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

function memoryId(index: number): string {
  return `mem_${index.toString(16).padStart(16, "0")}`;
}

describe("searchMemory", () => {
  it("keeps CJK-only queries on the existing ASCII-only tokenizer path", () => {
    const query = "租户隔离";
    const result = searchMemory({
      query,
      reviewer: "security",
      findings: [
        validFinding({
          id: "mem_000000000000c0de",
          reviewer: "security",
          searchable: { redactedText: "tenant isolation", tokens: ["tenant", "isolation"] },
        }),
      ],
    });

    expect(tokenizeForSimilarity(query)).toEqual([]);
    expect(result.queryTokens).toEqual([]);
    expect(result.hits).toEqual([]);
  });

  it("safely returns no hits for an explicit empty query", () => {
    const result = searchMemory({
      query: "",
      findings: [
        validFinding({
          id: "mem_0000000000000002",
          searchable: { redactedText: "tenant", tokens: ["tenant"] },
        }),
      ],
    });

    expect(result.queryTokens).toEqual([]);
    expect(result.hits).toEqual([]);
  });

  it("does not match findings with empty tokens and empty redactedText", () => {
    const result = searchMemory({
      query: "tenant",
      findings: [
        validFinding({
          id: "mem_0000000000000003",
          searchable: { redactedText: "", tokens: [] },
        }),
      ],
    });

    expect(result.hits.map((hit) => hit.finding.id)).not.toContain("mem_0000000000000003");
    expect(result.hits).toHaveLength(0);
  });

  it("falls back to the current reviewer when includeReviewers is omitted", () => {
    const result = searchMemory({
      query: "tenant",
      reviewer: "security",
      findings: [
        validFinding({
          id: "mem_0000000000000004",
          reviewer: "security",
          searchable: { redactedText: "tenant", tokens: ["tenant"] },
        }),
        validFinding({
          id: "mem_0000000000000005",
          reviewer: "quality",
          searchable: { redactedText: "tenant", tokens: ["tenant"] },
        }),
      ],
    });

    expect(result.effectiveReviewers).toEqual(["security"]);
    expect(result.hits.map((hit) => hit.finding.id)).toEqual(["mem_0000000000000004"]);
  });

  it("does not leak other reviewers when the fallback reviewer has no hits", () => {
    const result = searchMemory({
      query: "tenant",
      reviewer: "performance",
      findings: [
        validFinding({
          id: "mem_0000000000000006",
          reviewer: "security",
          searchable: { redactedText: "tenant", tokens: ["tenant"] },
        }),
      ],
    });

    expect(result.effectiveReviewers).toEqual(["performance"]);
    expect(result.hits).toEqual([]);
  });

  it("matches token overlap and reports matched tokens in query order", () => {
    const result = searchMemory({
      query: "tenant isolation",
      findings: [
        validFinding({
          id: "mem_0000000000000007",
          searchable: { redactedText: "tenant isolation", tokens: ["tenant", "isolation"] },
        }),
        validFinding({
          id: "mem_0000000000000008",
          searchable: { redactedText: "cache ttl", tokens: ["cache", "ttl"] },
        }),
      ],
    });

    expect(result.hits.map((hit) => hit.finding.id)).toEqual(["mem_0000000000000007"]);
    expect(result.hits[0]?.matchedTokens).toEqual(["tenant", "isolation"]);
    expect(result.hits[0]?.keywordScore).toBeGreaterThanOrEqual(0.75);
  });

  it("suppresses false-positive findings unless explicitly included", () => {
    const findings = [
      validFinding({
        id: "mem_0000000000000009",
        status: "false-positive",
        searchable: { redactedText: "tenant", tokens: ["tenant"] },
      }),
      validFinding({
        id: "mem_000000000000000a",
        status: "open",
        searchable: { redactedText: "tenant", tokens: ["tenant"] },
      }),
    ];

    expect(searchMemory({ query: "tenant", findings }).hits.map((hit) => hit.finding.id)).toEqual([
      "mem_000000000000000a",
    ]);
    expect(searchMemory({ query: "tenant", findings, includeFalsePositive: true }).hits.map((hit) => hit.finding.id)).toEqual([
      "mem_0000000000000009",
      "mem_000000000000000a",
    ]);
  });

  it("uses includeReviewers exactly, including the empty-array zero-hit policy", () => {
    const findings = [
      validFinding({
        id: "mem_000000000000000b",
        reviewer: "security",
        searchable: { redactedText: "tenant", tokens: ["tenant"] },
      }),
      validFinding({
        id: "mem_000000000000000c",
        reviewer: "quality",
        searchable: { redactedText: "tenant", tokens: ["tenant"] },
      }),
    ];

    const emptyReviewerResult = searchMemory({ query: "tenant", reviewer: "security", includeReviewers: [], findings });
    const qualityOnlyResult = searchMemory({ query: "tenant", reviewer: "security", includeReviewers: ["quality"], findings });

    expect(emptyReviewerResult.effectiveReviewers).toEqual([]);
    expect(emptyReviewerResult.hits).toEqual([]);
    expect(qualityOnlyResult.effectiveReviewers).toEqual(["quality"]);
    expect(qualityOnlyResult.hits.map((hit) => hit.finding.id)).toEqual(["mem_000000000000000c"]);
  });

  it("matches reviewer dimensions and full omre reviewer aliases interchangeably", () => {
    const storedFullNameResult = searchMemory({
      query: "tenant",
      reviewer: "security",
      findings: [
        validFinding({
          id: "mem_000000000000000d",
          reviewer: "omre-reviewer-security",
          searchable: { redactedText: "tenant", tokens: ["tenant"] },
        }),
      ],
    });
    const inputFullNameResult = searchMemory({
      query: "tenant",
      reviewer: "omre-reviewer-security",
      findings: [
        validFinding({
          id: "mem_000000000000000e",
          reviewer: "security",
          searchable: { redactedText: "tenant", tokens: ["tenant"] },
        }),
      ],
    });

    expect(storedFullNameResult.hits.map((hit) => hit.finding.id)).toEqual(["mem_000000000000000d"]);
    expect(inputFullNameResult.hits.map((hit) => hit.finding.id)).toEqual(["mem_000000000000000e"]);
  });

  it("falls back to tokenizing redactedText when searchable.tokens is empty", () => {
    const result = searchMemory({
      query: "tenant isolation",
      findings: [
        validFinding({
          id: "mem_000000000000000f",
          searchable: { redactedText: "tenant isolation", tokens: [] },
        }),
      ],
    });

    expect(result.hits.map((hit) => hit.finding.id)).toEqual(["mem_000000000000000f"]);
    expect(result.hits[0]?.matchedTokens).toEqual(["tenant", "isolation"]);
  });

  it("respects statuses and the similarity threshold", () => {
    const findings = [
      validFinding({
        id: "mem_0000000000000010",
        status: "open",
        searchable: { redactedText: "tenant", tokens: ["tenant"] },
      }),
      validFinding({
        id: "mem_0000000000000011",
        status: "fixed",
        searchable: { redactedText: "tenant", tokens: ["tenant"] },
      }),
      validFinding({
        id: "mem_0000000000000012",
        status: "confirmed",
        searchable: { redactedText: "tenant cache", tokens: ["tenant", "cache"] },
      }),
    ];

    expect(searchMemory({ query: "tenant", findings, statuses: ["fixed"] }).hits.map((hit) => hit.finding.id)).toEqual([
      "mem_0000000000000011",
    ]);
    expect(searchMemory({ query: "tenant isolation", findings }).hits.map((hit) => hit.finding.id)).toEqual([]);

    const lowerThresholdResult = searchMemory({ query: "tenant isolation", findings, similarityThreshold: 0.5 });
    expect(lowerThresholdResult.hits.map((hit) => hit.finding.id)).toEqual([
      "mem_0000000000000010",
      "mem_0000000000000011",
    ]);
    expect(lowerThresholdResult.hits[0]?.keywordScore).toBe(0.5);
  });

  it("computes set Jaccard scores and unique matchedTokens by query token order", () => {
    const result = searchMemory({
      query: "isolation tenant tenant cache",
      similarityThreshold: 0.3,
      findings: [
        validFinding({
          id: "mem_0000000000000013",
          searchable: { redactedText: "tenant tenant isolation", tokens: ["tenant", "tenant", "isolation"] },
        }),
      ],
    });

    expect(result.queryTokens).toEqual(["isolation", "tenant", "tenant", "cache"]);
    expect(result.hits[0]?.matchedTokens).toEqual(["isolation", "tenant"]);
    expect(result.hits[0]?.keywordScore).toBe(2 / 3);
  });

  it("computes pathOverlapRank using normalized POSIX paths", () => {
    const result = searchMemory({
      query: "tenant",
      paths: ["./src/auth/user.ts"],
      findings: [
        validFinding({
          id: "mem_0000000000000014",
          locations: [{ path: "src/auth/user.ts", line: 1 }],
          searchable: { redactedText: "tenant", tokens: ["tenant"] },
        }),
        validFinding({
          id: "mem_0000000000000015",
          locations: [{ path: "src/auth/session.ts", line: 1 }],
          searchable: { redactedText: "tenant", tokens: ["tenant"] },
        }),
        validFinding({
          id: "mem_0000000000000016",
          locations: [{ path: "src/payments/index.ts", line: 1 }],
          searchable: { redactedText: "tenant", tokens: ["tenant"] },
        }),
      ],
    });

    expect(result.hits.map((hit) => hit.pathOverlapRank)).toEqual([2, 1, 0]);
    expect(searchMemory({ query: "tenant isolation", findings: [validFinding({ id: "mem_0000000000000017" })] }).hits[0]?.pathOverlapRank).toBe(0);
  });

  it("limits hits after deterministic input-order filtering", () => {
    const result = searchMemory({
      query: "tenant",
      limit: 2,
      findings: [
        validFinding({ id: "mem_0000000000000018", searchable: { redactedText: "tenant", tokens: ["tenant"] } }),
        validFinding({ id: "mem_0000000000000019", searchable: { redactedText: "tenant", tokens: ["tenant"] } }),
        validFinding({ id: "mem_000000000000001a", searchable: { redactedText: "tenant", tokens: ["tenant"] } }),
      ],
    });

    expect(result.hits.map((hit) => hit.finding.id)).toEqual(["mem_0000000000000018", "mem_0000000000000019"]);
  });

  it("linear scan performance stays within the local v0.4 budget", () => {
    const makeFindings = (count: number): MemoryFinding[] => Array.from({ length: count }, (_unused, index) => validFinding({
      id: memoryId(index + 1),
      searchable: { redactedText: "tenant isolation", tokens: ["tenant", "isolation"] },
    }));
    const measureSearch = (findings: MemoryFinding[]): number => {
      const start = performance.now();
      const result = searchMemory({ query: "tenant isolation", findings });
      const elapsed = performance.now() - start;

      expect(result.hits).toHaveLength(findings.length);

      return elapsed;
    };

    const oneThousandMs = measureSearch(makeFindings(1_000));
    const fiveThousandMs = measureSearch(makeFindings(5_000));
    const tenThousandMs = measureSearch(makeFindings(10_000));

    expect(oneThousandMs).toBeLessThan(40);
    expect(fiveThousandMs).toBeLessThan(100);
    expect(tenThousandMs).toBeLessThan(200);
    expect(tenThousandMs).toBeLessThanOrEqual(Math.max(100, oneThousandMs * 15));
  });
});

import { describe, expect, it } from "vitest";
import { buildMemoryContextPack } from "../../src/memory/context-pack.js";
import type { RankedMemoryHit } from "../../src/memory/ranking.js";
import type { MemoryFinding, RelatedIndex } from "../../src/memory/schema.js";

const timestamp = "2026-05-28T00:00:00.000Z";

function validFinding(overrides: Partial<MemoryFinding> = {}): MemoryFinding {
  const finding = {
    schemaVersion: 1,
    id: "mem_1111111111111111",
    fingerprint: "fp1234567890abcdef",
    repo: {
      rootHash: "repo1234567890abcd",
      packagePath: ".",
    },
    origin: {
      runId: "run-context-pack",
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
      runIds: ["run-context-pack"],
    },
    searchable: {
      redactedText: "tenant isolation summary",
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

function hit(
  findingOverrides: Partial<MemoryFinding> = {},
  hitOverrides: Partial<Omit<RankedMemoryHit, "finding">> = {},
): RankedMemoryHit {
  return {
    finding: validFinding(findingOverrides),
    keywordScore: 0.9,
    matchedTokens: ["tenant", "isolation"],
    pathOverlapRank: 2,
    regressionCandidate: false,
    ...hitOverrides,
  };
}

function relatedIndex(byFindingId: RelatedIndex["byFindingId"] = {}): RelatedIndex {
  return {
    schemaVersion: 1,
    generatedAt: timestamp,
    relations: Object.values(byFindingId).flat(),
    byFindingId,
  };
}

function renderedItemIds(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("memory id: "))
    .map((line) => line.slice("memory id: ".length));
}

describe("buildMemoryContextPack", () => {
  it("excludes an entire item when its rendered text exceeds maxContextChars", () => {
    const pack = buildMemoryContextPack([
      hit({
        id: "mem_hugehugehugehuge",
        title: "T",
        searchable: { redactedText: "x".repeat(200), tokens: ["tenant"] },
        evidence: "x".repeat(200),
      }),
    ], relatedIndex(), { maxContextItems: 6, maxContextChars: 80 });

    expect(pack.text).not.toContain("mem_hugehugehugehuge");
    expect(pack.includedIds).toEqual([]);
    expect(pack.regressionCandidateIds).toEqual([]);
    expect(pack.truncated).toBe(true);
    expect(pack.totalMatched).toBe(1);
  });

  it("renders fixed fields in deterministic order with related IDs and regression candidates", () => {
    const expectedText = [
      "Memory Context Pack (totalMatched=1, included=1, truncated=false)",
      "--- memory item ---",
      "memory id: mem_2222222222222222",
      "reviewer: security",
      "severity: high",
      "status: fixed",
      "title: Missing tenant isolation",
      "primary paths: src/tenants.ts",
      "lastSeenAt: 2026-05-28T00:00:00.000Z",
      "occurrence count: 3",
      "safe summary: tenant isolation summary",
      "regressionCandidate: true",
      "related memory IDs: mem_external00000000 (same-root-cause)",
    ].join("\n");

    const pack = buildMemoryContextPack([
      hit({
        id: "mem_2222222222222222",
        status: "fixed",
        occurrence: {
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          count: 3,
          runIds: ["run-context-pack"],
        },
      }, { regressionCandidate: true }),
    ], relatedIndex({
      mem_2222222222222222: [
        {
          findingId: "mem_2222222222222222",
          relatedFindingId: "mem_external00000000",
          relationType: "same-root-cause",
        },
      ],
    }), { maxContextItems: 6, maxContextChars: expectedText.length });

    expect(pack).toEqual({
      text: expectedText,
      includedIds: ["mem_2222222222222222"],
      regressionCandidateIds: ["mem_2222222222222222"],
      truncated: false,
      totalMatched: 1,
    });
    expect(pack.text).not.toContain("similarity");
    expect(pack.text).not.toContain("reason");
    expect(pack.text).not.toContain("runIds");
  });

  it("applies maxContextItems before maxContextChars and omits later matches", () => {
    const pack = buildMemoryContextPack([
      hit({ id: "mem_3333333333333333", title: "First", searchable: { redactedText: "first", tokens: ["first"] } }),
      hit({ id: "mem_4444444444444444", title: "Second", searchable: { redactedText: "second", tokens: ["second"] } }),
      hit({ id: "mem_5555555555555555", title: "Third", searchable: { redactedText: "third", tokens: ["third"] } }),
    ], relatedIndex(), { maxContextItems: 2, maxContextChars: 1_000 });

    expect(pack.includedIds).toEqual(["mem_3333333333333333", "mem_4444444444444444"]);
    expect(renderedItemIds(pack.text)).toEqual(pack.includedIds);
    expect(pack.text).not.toContain("mem_5555555555555555");
    expect(pack.truncated).toBe(true);
    expect(pack.totalMatched).toBe(3);
  });

  it("stops before the next item would exceed maxContextChars and keeps includedIds aligned to item IDs", () => {
    const pack = buildMemoryContextPack([
      hit({ id: "mem_6666666666666666", title: "First", searchable: { redactedText: "first", tokens: ["first"] } }),
      hit({ id: "mem_7777777777777777", title: "Second", searchable: { redactedText: "second", tokens: ["second"] } }, { regressionCandidate: true }),
      hit({ id: "mem_8888888888888888", title: "Third", searchable: { redactedText: "third", tokens: ["third"] } }),
    ], relatedIndex({
      mem_6666666666666666: [
        {
          findingId: "mem_6666666666666666",
          relatedFindingId: "mem_related000000000",
          relationType: "duplicate",
        },
      ],
    }), { maxContextItems: 6, maxContextChars: 400 });

    expect(pack.includedIds).toEqual(["mem_6666666666666666"]);
    expect(renderedItemIds(pack.text)).toEqual(["mem_6666666666666666"]);
    expect(pack.regressionCandidateIds).toEqual([]);
    expect(pack.text).toContain("mem_related000000000 (duplicate)");
    expect(pack.includedIds).not.toContain("mem_related000000000");
    expect(pack.text).not.toContain("mem_7777777777777777");
    expect(pack.text).not.toContain("mem_8888888888888888");
    expect(pack.truncated).toBe(true);
    expect(pack.totalMatched).toBe(3);
  });
});

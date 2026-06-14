import { describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_CONFIG } from "../../src/memory/config.js";
import { buildMemoryContextPack, type MemoryContextPack } from "../../src/memory/context-pack.js";
import { buildSearchQuery, checkAutoCompactThreshold, retrieveMemoryContext, type RetrieveMemoryContextInput } from "../../src/memory/pipeline.js";
import { rankMemoryHits, type RankedMemoryHit, type RankMemoryInput } from "../../src/memory/ranking.js";
import { searchMemory, type MemorySearchHit, type SearchMemoryInput, type SearchMemoryResult } from "../../src/memory/search.js";

describe("Wave 0 memory contracts", () => {
  it("exposes the search contract", () => {
    const input: SearchMemoryInput = {
      findings: [],
      query: "tenant isolation",
      reviewer: "security",
      includeReviewers: ["security", "spec"],
      paths: ["src/auth.ts"],
      statuses: ["open", "confirmed"],
      includeFalsePositive: false,
      limit: 5,
      similarityThreshold: 0.75,
    };

    const result: SearchMemoryResult = searchMemory(input);
    const hits: MemorySearchHit[] = result.hits;

    expect(hits).toEqual([]);
    expect(result).toEqual({
      hits: [],
      queryTokens: ["tenant", "isolation"],
      effectiveReviewers: ["security", "spec"],
    });
  });

  it("exposes the ranking stub contract", () => {
    const input: RankMemoryInput = {
      hits: [],
      reviewer: "security",
      includeReviewers: ["security"],
      includeFixedAsRegressionCandidates: true,
    };

    const ranked: RankedMemoryHit[] = rankMemoryHits(input);

    expect(ranked).toEqual([]);
  });

  it("exposes the context pack stub contract", () => {
    const pack: MemoryContextPack = buildMemoryContextPack({
      hits: [],
      maxContextItems: 6,
      maxContextChars: 8000,
    });

    expect(pack).toEqual({
      text: "",
      includedIds: [],
      regressionCandidateIds: [],
      truncated: false,
      totalMatched: 0,
    });
  });

  it("exposes the pipeline contract", () => {
    const input: RetrieveMemoryContextInput = {
      repoRoot: "/tmp/repo",
      reviewer: "security",
      slicePaths: ["src/auth.ts"],
      diffSummary: "Auth middleware changed",
      userGuidance: "focus tenant isolation",
      memoryConfig: DEFAULT_MEMORY_CONFIG,
      withMemory: true,
      noMemory: false,
    };

    expect(buildSearchQuery(input)).toEqual(["auth", "middleware", "changed", "focus", "tenant", "isolation"]);
    expect(retrieveMemoryContext(input)).toBeUndefined();
    expect(checkAutoCompactThreshold(input.repoRoot, input.memoryConfig)).toEqual({ needsCompaction: false });
  });
});

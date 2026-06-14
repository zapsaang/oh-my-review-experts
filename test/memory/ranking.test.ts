import { describe, expect, it } from "vitest";
import { rankMemoryHits } from "../../src/memory/ranking.js";
import type { MemorySearchHit } from "../../src/memory/search.js";
import type { MemoryFinding } from "../../src/memory/schema.js";

const timestamp = "2026-05-28T00:00:00.000Z";
const laterTimestamp = "2026-05-29T00:00:00.000Z";

function validFinding(overrides: Partial<MemoryFinding> = {}): MemoryFinding {
  const finding = {
    schemaVersion: 1,
    id: "mem_aaaaaaaaaaaaaaaa",
    fingerprint: "fp1234567890abcdef",
    repo: {
      rootHash: "repo1234567890abcd",
      packagePath: "packages/core",
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
    category: "injection",
    title: "SQL injection risk",
    problem: "User input reaches a SQL query without parameterization.",
    evidence: "db.query(`SELECT * FROM users WHERE id = ${id}`)",
    locations: [{ path: "src/auth.ts", line: 1 }],
    occurrence: {
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      count: 1,
      runIds: ["run-20260528"],
    },
    searchable: {
      redactedText: "sql injection parameterized query",
      tokens: ["sql", "injection", "query"],
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
  hitOverrides: Partial<Omit<MemorySearchHit, "finding">> = {},
): MemorySearchHit {
  return {
    finding: validFinding(findingOverrides),
    keywordScore: 0.9,
    matchedTokens: ["tenant", "isolation"],
    pathOverlapRank: 2,
    ...hitOverrides,
  };
}

function ids(hits: MemorySearchHit[]): string[] {
  return hits.map((rankedHit) => rankedHit.finding.id);
}

describe("rankMemoryHits", () => {
  it("uses finding.id lexicographic order as the final tie-breaker", () => {
    const ranked = rankMemoryHits({
      hits: [
        hit({ id: "mem_bbbbbbbbbbbbbbbb" }),
        hit({ id: "mem_aaaaaaaaaaaaaaaa" }),
      ],
      reviewer: "security",
      includeReviewers: ["security"],
      includeFixedAsRegressionCandidates: false,
    });

    expect(ids(ranked)).toEqual(["mem_aaaaaaaaaaaaaaaa", "mem_bbbbbbbbbbbbbbbb"]);
    expect(ranked.map((rankedHit) => rankedHit.regressionCandidate)).toEqual([false, false]);
  });

  it("returns deterministic output when input order is reversed and ranking runs twice", () => {
    const forward = [
      hit({ id: "mem_aaaaaaaaaaaaaaaa" }),
      hit({ id: "mem_bbbbbbbbbbbbbbbb" }),
    ];
    const reversed = [...forward].reverse();

    const firstRun = rankMemoryHits({ hits: reversed, reviewer: "security" });
    const secondRun = rankMemoryHits({ hits: forward, reviewer: "security" });

    expect(ids(firstRun)).toEqual(["mem_aaaaaaaaaaaaaaaa", "mem_bbbbbbbbbbbbbbbb"]);
    expect(ids(secondRun)).toEqual(["mem_aaaaaaaaaaaaaaaa", "mem_bbbbbbbbbbbbbbbb"]);
    expect(ids(reversed)).toEqual(["mem_bbbbbbbbbbbbbbbb", "mem_aaaaaaaaaaaaaaaa"]);
    expect(Object.hasOwn(reversed[0], "regressionCandidate")).toBe(false);
  });

  it("orders ignored before stale before false-positive when other dimensions match", () => {
    const ranked = rankMemoryHits({
      hits: [
        hit({ id: "mem_falsepositive000", status: "false-positive" }),
        hit({ id: "mem_stalestalestale0", status: "stale" }),
        hit({ id: "mem_ignoredignored00", status: "ignored" }),
      ],
      reviewer: "security",
      includeReviewers: ["security"],
      includeFixedAsRegressionCandidates: false,
    });

    expect(ranked.map((rankedHit) => rankedHit.finding.status)).toEqual([
      "ignored",
      "stale",
      "false-positive",
    ]);
  });

  it("marks fixed hits as regression candidates and ranks them before equally scored open hits", () => {
    const ranked = rankMemoryHits({
      hits: [
        hit({ id: "mem_openopenopenopen", status: "open" }),
        hit({ id: "mem_fixedfixedfixed0", status: "fixed" }),
      ],
      reviewer: "security",
      includeReviewers: ["security"],
      includeFixedAsRegressionCandidates: true,
    });

    expect(ids(ranked)).toEqual(["mem_fixedfixedfixed0", "mem_openopenopenopen"]);
    expect(ranked[0]?.regressionCandidate).toBe(true);
    expect(ranked[1]?.regressionCandidate).toBe(false);
  });

  it("honors severity, path overlap, reviewer, keyword score, and recency before id fallback", () => {
    expect(ids(rankMemoryHits({
      hits: [
        hit({ id: "mem_1000000000000000", severity: "low" }),
        hit({ id: "mem_2000000000000000", severity: "high" }),
      ],
      includeFixedAsRegressionCandidates: false,
    }))[0]).toBe("mem_2000000000000000");

    expect(ids(rankMemoryHits({
      hits: [
        hit({ id: "mem_3000000000000000" }, { pathOverlapRank: 1 }),
        hit({ id: "mem_4000000000000000" }, { pathOverlapRank: 2 }),
      ],
      includeFixedAsRegressionCandidates: false,
    }))[0]).toBe("mem_4000000000000000");

    expect(ids(rankMemoryHits({
      hits: [
        hit({ id: "mem_5000000000000000", reviewer: "quality" }),
        hit({ id: "mem_6000000000000000", reviewer: "omre-reviewer-security" }),
      ],
      reviewer: "security",
      includeFixedAsRegressionCandidates: false,
    }))[0]).toBe("mem_6000000000000000");

    expect(ids(rankMemoryHits({
      hits: [
        hit({ id: "mem_7000000000000000" }, { keywordScore: 0.8 }),
        hit({ id: "mem_8000000000000000" }, { keywordScore: 0.9 }),
      ],
      includeFixedAsRegressionCandidates: false,
    }))[0]).toBe("mem_8000000000000000");

    expect(ids(rankMemoryHits({
      hits: [
        hit({ id: "mem_9000000000000000", occurrence: { firstSeenAt: timestamp, lastSeenAt: timestamp, count: 1, runIds: ["run-20260528"] } }),
        hit({ id: "mem_9999999999999999", occurrence: { firstSeenAt: timestamp, lastSeenAt: laterTimestamp, count: 1, runIds: ["run-20260529"] } }),
      ],
      includeFixedAsRegressionCandidates: false,
    }))[0]).toBe("mem_9999999999999999");
  });
});

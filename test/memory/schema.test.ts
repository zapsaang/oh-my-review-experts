import { describe, expect, it } from "vitest";
import {
  MemoryEventSchema,
  MemoryFindingSchema,
  MemoryManifestSchema,
  MemoryVersionSchema,
  RelatedIndexSchema,
} from "../../src/memory/schema.js";
import type {
  MemoryEvent,
  MemoryFinding,
  MemoryManifest,
  MemoryVersion,
  RelatedIndex,
} from "../../src/memory/schema.js";

const findingId = "mem_abcdef1234567890";
const relatedFindingId = "mem_1234567890abcdef";
const timestamp = "2026-05-28T00:00:00.000Z";

function validFinding(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: findingId,
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
    locations: [{ path: "src/users.ts", line: 42 }],
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
    contentHash: "ch1234567890abcdef",
    ...overrides,
  };
}

function discoveredEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "finding.discovered",
    eventId: "evt_discovered_001",
    at: timestamp,
    finding: validFinding(),
    ...overrides,
  };
}

function seenAgainEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "finding.seen_again",
    eventId: "evt_seen_again_001",
    at: timestamp,
    findingId,
    runId: "run-20260528-repeat",
    sourcePath: ".omre/reports/history/20260528.json",
    matchedBy: "fingerprint",
    ...overrides,
  };
}

function statusChangedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "finding.status_changed",
    eventId: "evt_status_changed_001",
    at: timestamp,
    findingId,
    from: "open",
    to: "acknowledged",
    markedBy: "reviewer@example.com",
    ...overrides,
  };
}

function regressedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "finding.regressed",
    eventId: "evt_regressed_001",
    at: timestamp,
    findingId,
    fromStatus: "fixed",
    toStatus: "open",
    runId: "run-20260528-regression",
    ...overrides,
  };
}

function relatedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "finding.related",
    eventId: "evt_related_001",
    at: timestamp,
    findingId,
    relatedFindingId,
    relationType: "same-root-cause",
    ...overrides,
  };
}

describe("MemoryFindingSchema", () => {
  it("accepts a valid finding", () => {
    const parsed: MemoryFinding = MemoryFindingSchema.parse(validFinding());

    expect(parsed.id).toBe(findingId);
    expect(parsed.fingerprint).toBe("fp1234567890abcdef");
    expect(parsed.contentHash).toBe("ch1234567890abcdef");
  });

  it("rejects a bad id format", () => {
    const result = MemoryFindingSchema.safeParse(validFinding({ id: "finding_abcdef1234567890" }));

    expect(result.success).toBe(false);
  });

  it("rejects empty evidence", () => {
    const result = MemoryFindingSchema.safeParse(validFinding({ evidence: "" }));

    expect(result.success).toBe(false);
  });

  it("rejects an oversized title", () => {
    const result = MemoryFindingSchema.safeParse(validFinding({ title: "x".repeat(241) }));

    expect(result.success).toBe(false);
  });

  it("accepts locations with line as number, string, or missing", () => {
    const result = MemoryFindingSchema.safeParse(validFinding({
      locations: [
        { path: "src/number.ts", line: 7 },
        { path: "src/string.ts", line: "L12" },
        { path: "src/missing.ts" },
      ],
    }));

    expect(result.success).toBe(true);
  });

  it("rejects more than 16 locations", () => {
    const result = MemoryFindingSchema.safeParse(validFinding({
      locations: Array.from({ length: 17 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        line: index + 1,
      })),
    }));

    expect(result.success).toBe(false);
  });

  it("defaults metadata flags to false", () => {
    const parsed = MemoryFindingSchema.parse(validFinding({ metadata: {} }));

    expect(parsed.metadata).toEqual({
      evidenceTruncated: false,
      problemTruncated: false,
      recommendationTruncated: false,
      sourceMalformed: false,
    });
  });

  it("defaults repo.packagePath to dot", () => {
    const parsed = MemoryFindingSchema.parse(validFinding({
      repo: { rootHash: "repo1234567890abcd" },
    }));

    expect(parsed.repo.packagePath).toBe(".");
  });

  it("normalizes legacy acknowledged status to confirmed", () => {
    const parsed = MemoryFindingSchema.parse(validFinding({ status: "acknowledged" }));
    expect(parsed.status).toBe("confirmed");
  });

  it("normalizes legacy false_positive status to false-positive", () => {
    const parsed = MemoryFindingSchema.parse(validFinding({ status: "false_positive" }));
    expect(parsed.status).toBe("false-positive");
  });

  it("normalizes legacy wont_fix status to ignored", () => {
    const parsed = MemoryFindingSchema.parse(validFinding({ status: "wont_fix" }));
    expect(parsed.status).toBe("ignored");
  });

  it("accepts canonical stale status", () => {
    const result = MemoryFindingSchema.safeParse(validFinding({ status: "stale" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("stale");
    }
  });

  it("defaults missing tags to empty array", () => {
    const parsed = MemoryFindingSchema.parse(validFinding());
    expect(parsed.tags).toEqual([]);
  });

  it("accepts missing optional new fields and defaults tags", () => {
    const parsed = MemoryFindingSchema.parse(validFinding());
    expect(parsed.sourceFindingId).toBeUndefined();
    expect(parsed.recommendation).toBeUndefined();
    expect(parsed.confidence).toBeUndefined();
    expect(parsed.repo.remoteHash).toBeUndefined();
    expect(parsed.repo.packageName).toBeUndefined();
    expect(parsed.repo.packageKind).toBeUndefined();
    expect(parsed.origin.commitSha).toBeUndefined();
    expect(parsed.origin.baseSha).toBeUndefined();
    expect(parsed.origin.headSha).toBeUndefined();
    expect(parsed.tags).toEqual([]);
  });

  it("accepts new optional fields when provided", () => {
    const parsed = MemoryFindingSchema.parse(validFinding({
      sourceFindingId: "sf123",
      recommendation: "Use prepared statements",
      confidence: "high",
      repo: {
        rootHash: "repo1234567890abcd",
        packagePath: "packages/core",
        remoteHash: "remote123",
        packageName: "core",
        packageKind: "lib",
      },
      origin: {
        runId: "run-20260528",
        sourceType: "report",
        sourcePath: ".omre/reports/latest.json",
        createdAt: timestamp,
        commitSha: "abc123",
        baseSha: "base456",
        headSha: "head789",
      },
      tags: ["sql", "injection"],
    }));
    expect(parsed.sourceFindingId).toBe("sf123");
    expect(parsed.recommendation).toBe("Use prepared statements");
    expect(parsed.confidence).toBe("high");
    expect(parsed.repo.remoteHash).toBe("remote123");
    expect(parsed.repo.packageName).toBe("core");
    expect(parsed.repo.packageKind).toBe("lib");
    expect(parsed.origin.commitSha).toBe("abc123");
    expect(parsed.origin.baseSha).toBe("base456");
    expect(parsed.origin.headSha).toBe("head789");
    expect(parsed.tags).toEqual(["sql", "injection"]);
  });
});

describe("MemoryEventSchema", () => {
  it("accepts finding.discovered events", () => {
    const parsed: MemoryEvent = MemoryEventSchema.parse(discoveredEvent());

    expect(parsed.type).toBe("finding.discovered");
  });

  it("accepts finding.seen_again events", () => {
    const parsed: MemoryEvent = MemoryEventSchema.parse(seenAgainEvent());

    expect(parsed.type).toBe("finding.seen_again");
  });

  it("accepts finding.status_changed events", () => {
    const parsed: MemoryEvent = MemoryEventSchema.parse(statusChangedEvent());

    expect(parsed.type).toBe("finding.status_changed");
  });

  it("accepts finding.regressed events", () => {
    const parsed: MemoryEvent = MemoryEventSchema.parse(regressedEvent());

    expect(parsed.type).toBe("finding.regressed");
  });

  it("accepts finding.related events", () => {
    const parsed: MemoryEvent = MemoryEventSchema.parse(relatedEvent());

    expect(parsed.type).toBe("finding.related");
  });

  it("rejects unknown event types", () => {
    const result = MemoryEventSchema.safeParse({
      type: "finding.unknown",
      eventId: "evt_unknown_001",
      at: timestamp,
    });

    expect(result.success).toBe(false);
  });

  it("rejects missing required fields per event variant", () => {
    const { finding: _finding, ...missingFinding } = discoveredEvent();
    const { matchedBy: _matchedBy, ...missingMatchedBy } = seenAgainEvent();
    const { markedBy: _markedBy, ...missingMarkedBy } = statusChangedEvent();
    const { runId: _runId, ...missingRunId } = regressedEvent();
    const { relationType: _relationType, ...missingRelationType } = relatedEvent();

    expect(MemoryEventSchema.safeParse(missingFinding).success).toBe(false);
    expect(MemoryEventSchema.safeParse(missingMatchedBy).success).toBe(false);
    expect(MemoryEventSchema.safeParse(missingMarkedBy).success).toBe(false);
    expect(MemoryEventSchema.safeParse(missingRunId).success).toBe(false);
    expect(MemoryEventSchema.safeParse(missingRelationType).success).toBe(false);
  });
});

describe("RelatedIndexSchema", () => {
  it("round-trips a related finding index", () => {
    const index = {
      schemaVersion: 1,
      generatedAt: timestamp,
      relations: [{ findingId, relatedFindingId, relationType: "same-root-cause" }],
      byFindingId: {
        [findingId]: [{ findingId, relatedFindingId, relationType: "same-root-cause" }],
      },
    };

    const parsed: RelatedIndex = RelatedIndexSchema.parse(index);

    expect(parsed).toEqual(index);
  });
});

describe("MemoryManifestSchema", () => {
  it("round-trips a memory manifest", () => {
    const manifest = {
      schemaVersion: 1,
      eventSchemaVersion: 1,
      viewSchemaVersion: 1,
      lastRebuiltAt: timestamp,
      materializedHash: "mat1234567890abcd",
      relatedIndexHash: "rel1234567890abcd",
      includedEventFiles: ["events/2026-05-28.jsonl"],
      compactedInputSegments: ["segments/2026-05-28.jsonl"],
      gcSummary: {
        deletedRawSegments: 0,
        deletedTmpFiles: 0,
        deletedQuarantineFiles: 0,
      },
      quarantine: ["quarantine/bad-segment.jsonl"],
    };

    const parsed: MemoryManifest = MemoryManifestSchema.parse(manifest);

    expect(parsed).toEqual(manifest);
  });
});

describe("MemoryVersionSchema", () => {
  it("round-trips memory schema versions", () => {
    const version = {
      schemaVersion: 1,
      eventSchemaVersion: 1,
      viewSchemaVersion: 1,
    };

    const parsed: MemoryVersion = MemoryVersionSchema.parse(version);

    expect(parsed).toEqual(version);
  });
});

import { describe, expect, it } from "vitest";
import { safeDateParse, selectStatusRunId, computeTrends, type RunBoundary } from "../../src/memory/trends.js";
import { MemoryEventSchema, type MemoryEvent, type MemoryFinding } from "../../src/memory/schema.js";

const findingId = "mem_abcdef1234567890";
const secondFindingId = "mem_1234567890abcdef";
const thirdFindingId = "mem_fedcba0987654321";
const firstAt = "2026-05-28T00:00:00.000Z";
const middleAt = "2026-05-29T00:00:00.000Z";
const afterMiddleAt = "2026-05-29T12:00:00.000Z";
const lastAt = "2026-05-30T00:00:00.000Z";
const laterAt = "2026-05-31T00:00:00.000Z";
const finalAt = "2026-06-01T00:00:00.000Z";

type DiscoveredEvent = Extract<MemoryEvent, { type: "finding.discovered" }>;
type SeenAgainEvent = Extract<MemoryEvent, { type: "finding.seen_again" }>;
type StatusChangedEvent = Extract<MemoryEvent, { type: "finding.status_changed" }>;
type RegressedEvent = Extract<MemoryEvent, { type: "finding.regressed" }>;
type RelatedEvent = Extract<MemoryEvent, { type: "finding.related" }>;

function validFinding(overrides: Partial<MemoryFinding> = {}): MemoryFinding {
  const finding = {
    schemaVersion: 1,
    id: findingId,
    fingerprint: "fp1234567890abcdef",
    repo: {
      rootHash: "repo1234567890abcd",
      packagePath: "packages/core",
    },
    origin: {
      runId: "run-origin",
      sourceType: "report",
      sourcePath: ".omre/reports/latest.json",
      createdAt: firstAt,
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
      firstSeenAt: firstAt,
      lastSeenAt: firstAt,
      count: 1,
      runIds: ["wrong-run"],
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

function discoveredEvent(overrides: Partial<DiscoveredEvent> = {}): DiscoveredEvent {
  const event = {
    type: "finding.discovered",
    eventId: "evt_discovered_001",
    at: firstAt,
    finding: validFinding(),
  } satisfies DiscoveredEvent;

  return { ...event, ...overrides };
}

function seenAgainEvent(overrides: Partial<SeenAgainEvent> = {}): SeenAgainEvent {
  const event = {
    type: "finding.seen_again",
    eventId: "evt_seen_again_001",
    at: lastAt,
    findingId,
    runId: "run-later",
    sourcePath: ".omre/reports/history/20260530.json",
    matchedBy: "fingerprint",
  } satisfies SeenAgainEvent;

  return { ...event, ...overrides };
}

function statusChangedEvent(overrides: Partial<StatusChangedEvent> = {}): StatusChangedEvent {
  const event = {
    type: "finding.status_changed",
    eventId: "evt_status_changed_001",
    at: middleAt,
    findingId,
    from: "open",
    to: "fixed",
    markedBy: "reviewer@example.com",
  } satisfies StatusChangedEvent;

  return { ...event, ...overrides };
}

function regressedEvent(overrides: Partial<RegressedEvent> = {}): RegressedEvent {
  const event = {
    type: "finding.regressed",
    eventId: "evt_regressed_001",
    at: lastAt,
    findingId,
    fromStatus: "fixed",
    toStatus: "open",
    runId: "run-regression",
  } satisfies RegressedEvent;

  return { ...event, ...overrides };
}

function relatedEvent(overrides: Partial<RelatedEvent> = {}): RelatedEvent {
  const event = {
    type: "finding.related",
    eventId: "evt_related_001",
    at: middleAt,
    findingId,
    relatedFindingId: secondFindingId,
    relationType: "same-root-cause",
  } satisfies RelatedEvent;

  return { ...event, ...overrides };
}

describe("computeTrends", () => {
  it("returns the complete TrendsReport shape", () => {
    const report = computeTrends([discoveredEvent()], { atBucket: finalAt });

    expect(report.moduleDistribution).toEqual([{ module: "users", count: 1, percentage: 100 }]);
    expect(report.recurringRegressions).toEqual([]);
    expect(report.fixSurvivalTime).toEqual([]);
    expect(report.perRunTimeline).toEqual([
      { runId: "run-origin", introduced: 1, seenAgain: 0, statusChanged: 0, regressed: 0, totalActive: 1 },
    ]);
  });

  it("sorts unsorted input defensively before computing survival", () => {
    const report = computeTrends([
      regressedEvent({ eventId: "evt_003" }),
      statusChangedEvent({ eventId: "evt_002" }),
      discoveredEvent({ eventId: "evt_001" }),
    ], { atBucket: finalAt });

    expect(report.fixSurvivalTime).toEqual([
      {
        findingId,
        title: "SQL injection risk",
        fixedAt: middleAt,
        regressedAt: lastAt,
        survivedMs: 86_400_000,
      },
    ]);
  });

  it("uses statuses already normalized by the event schema", () => {
    const parsedStatus = MemoryEventSchema.parse({
      type: "finding.status_changed",
      eventId: "evt_status_changed_legacy",
      at: middleAt,
      findingId,
      from: "acknowledged",
      to: "wont_fix",
      markedBy: "reviewer@example.com",
    });
    const report = computeTrends([discoveredEvent(), parsedStatus], { atBucket: finalAt });

    expect(report.perRunTimeline).toEqual([
      { runId: "run-origin", introduced: 1, seenAgain: 0, statusChanged: 1, regressed: 0, totalActive: 0 },
    ]);
  });

  it("uses origin.runId rather than occurrence.runIds for introduced counts", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({
          origin: {
            runId: "actual-origin-run",
            sourceType: "report",
            sourcePath: ".omre/reports/latest.json",
            createdAt: firstAt,
          },
          occurrence: {
            firstSeenAt: firstAt,
            lastSeenAt: firstAt,
            count: 1,
            runIds: ["wrong-intro-run"],
          },
        }),
      }),
    ], { atBucket: finalAt });

    expect(report.perRunTimeline[0]?.runId).toBe("actual-origin-run");
  });

  it("omits timeline rows when atBucket is before the first run", () => {
    const report = computeTrends([discoveredEvent()], { atBucket: "2026-05-27T00:00:00.000Z" });

    expect(report.perRunTimeline).toEqual([]);
  });

  it("includes only earlier run rows when atBucket is between runs", () => {
    const report = computeTrends([discoveredEvent(), seenAgainEvent()], { atBucket: middleAt });

    expect(report.perRunTimeline).toEqual([
      { runId: "run-origin", introduced: 1, seenAgain: 0, statusChanged: 0, regressed: 0, totalActive: 1 },
    ]);
  });

  it("includes all run rows when atBucket is after the last run", () => {
    const report = computeTrends([discoveredEvent(), seenAgainEvent()], { atBucket: "2026-05-31T00:00:00.000Z" });

    expect(report.perRunTimeline.map((row) => row.runId)).toEqual(["run-origin", "run-later"]);
  });

  it("includes events at exactly the atBucket timestamp", () => {
    const report = computeTrends([
      discoveredEvent(),
      seenAgainEvent({ at: middleAt }),
    ], { atBucket: middleAt });

    expect(report.perRunTimeline).toHaveLength(2);
    expect(report.perRunTimeline.map((row) => row.runId)).toEqual(["run-origin", "run-later"]);
  });

  it("uses event timestamps instead of parsing non-timestamp runIds", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({
          id: secondFindingId,
          origin: {
            runId: "manual-intro-run",
            sourceType: "report",
            sourcePath: ".omre/reports/latest.json",
            createdAt: firstAt,
          },
          occurrence: {
            firstSeenAt: firstAt,
            lastSeenAt: firstAt,
            count: 1,
            runIds: ["manual-intro-run"],
          },
        }),
      }),
      seenAgainEvent({ findingId: secondFindingId, runId: "manual-seen-run" }),
    ], { atBucket: middleAt });

    expect(report.perRunTimeline.map((row) => row.runId)).toEqual(["manual-intro-run"]);
  });

  it("returns empty trend sections when there are no events", () => {
    const report = computeTrends([], { atBucket: finalAt });

    expect(report).toEqual({
      moduleDistribution: [],
      recurringRegressions: [],
      fixSurvivalTime: [],
      perRunTimeline: [],
    });
  });

  it("counts module distribution across multiple findings", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({
          id: findingId,
          title: "User module issue",
          locations: [{ path: "src/users/create.ts", line: 12 }],
        }),
      }),
      discoveredEvent({
        eventId: "evt_discovered_auth",
        finding: validFinding({
          id: secondFindingId,
          title: "Auth module issue",
          locations: [{ path: "src/auth/login.ts", line: 9 }],
        }),
      }),
    ], { atBucket: finalAt });

    expect(report.moduleDistribution).toEqual([
      { module: "auth", count: 1, percentage: 50 },
      { module: "users", count: 1, percentage: 50 },
    ]);
  });

  it("uses unknown module when a finding has no locations", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({
          locations: [],
        }),
      }),
    ], { atBucket: finalAt });

    expect(report.moduleDistribution).toEqual([{ module: "unknown", count: 1, percentage: 100 }]);
  });

  it("extracts modules from absolute paths under the package path", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({
          repo: {
            rootHash: "repo1234567890abcd",
            packagePath: "packages/core",
          },
          locations: [{ path: "/home/dev/work/repo/packages/core/src/payments/charge.ts", line: 7 }],
        }),
      }),
    ], { atBucket: finalAt });

    expect(report.moduleDistribution).toEqual([{ module: "payments", count: 1, percentage: 100 }]);
  });

  it("calculates module percentages from distinct finding-module pairs", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({
          id: findingId,
          locations: [
            { path: "src/users/create.ts", line: 12 },
            { path: "src/users/update.ts", line: 21 },
          ],
        }),
      }),
      discoveredEvent({
        eventId: "evt_discovered_users_second",
        finding: validFinding({
          id: secondFindingId,
          locations: [{ path: "src/users/delete.ts", line: 31 }],
        }),
      }),
      discoveredEvent({
        eventId: "evt_discovered_auth_percentage",
        finding: validFinding({
          id: thirdFindingId,
          locations: [{ path: "src/auth/session.ts", line: 5 }],
        }),
      }),
    ], { atBucket: finalAt });

    expect(report.moduleDistribution).toHaveLength(2);
    expect(report.moduleDistribution[0]?.module).toBe("users");
    expect(report.moduleDistribution[0]?.count).toBe(2);
    expect(report.moduleDistribution[0]?.percentage).toBeCloseTo(66.6666666667);
    expect(report.moduleDistribution[1]?.module).toBe("auth");
    expect(report.moduleDistribution[1]?.count).toBe(1);
    expect(report.moduleDistribution[1]?.percentage).toBeCloseTo(33.3333333333);
  });

  it("extracts module from Windows absolute path", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({
          locations: [{ path: "C:\\Users\\dev\\repo\\src\\auth.ts", line: 1 }],
        }),
      }),
    ], { atBucket: finalAt });

    expect(report.moduleDistribution).toEqual([{ module: "auth", count: 1, percentage: 100 }]);
  });

  it("extracts module from nested src/src path", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({
          locations: [{ path: "src/src/utils.ts", line: 1 }],
        }),
      }),
    ], { atBucket: finalAt });

    expect(report.moduleDistribution).toEqual([{ module: "utils", count: 1, percentage: 100 }]);
  });

  it("extracts module from lib path without src", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({
          locations: [{ path: "lib/utils.ts", line: 1 }],
        }),
      }),
    ], { atBucket: finalAt });

    expect(report.moduleDistribution).toEqual([{ module: "utils", count: 1, percentage: 100 }]);
  });

  it("extracts module from single file index", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({
          locations: [{ path: "index.ts", line: 1 }],
        }),
      }),
    ], { atBucket: finalAt });

    expect(report.moduleDistribution).toEqual([{ module: "index", count: 1, percentage: 100 }]);
  });

  it("extracts module from path with extension", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({
          locations: [{ path: "src/users.ts", line: 1 }],
        }),
      }),
    ], { atBucket: finalAt });

    expect(report.moduleDistribution).toEqual([{ module: "users", count: 1, percentage: 100 }]);
  });

  it("uses unknown module for empty path", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({
          locations: [{ path: "", line: 1 }],
        }),
      }),
    ], { atBucket: finalAt });

    expect(report.moduleDistribution).toEqual([{ module: "unknown", count: 1, percentage: 100 }]);
  });

  it("reports recurring regressions for multiple findings", () => {
    const report = computeTrends([
      discoveredEvent({
        finding: validFinding({ id: findingId, title: "First regression" }),
      }),
      discoveredEvent({
        eventId: "evt_discovered_second_regression",
        finding: validFinding({ id: secondFindingId, title: "Second regression" }),
      }),
      regressedEvent({ eventId: "evt_regressed_second", at: middleAt, findingId: secondFindingId }),
      regressedEvent({ eventId: "evt_regressed_first", at: lastAt, findingId }),
    ], { atBucket: finalAt });

    expect(report.recurringRegressions).toEqual([
      { findingId, title: "First regression", regressionCount: 1, lastRegressionAt: lastAt },
      { findingId: secondFindingId, title: "Second regression", regressionCount: 1, lastRegressionAt: middleAt },
    ]);
  });

  it("counts multiple regressions for the same finding", () => {
    const report = computeTrends([
      discoveredEvent(),
      regressedEvent({ eventId: "evt_regressed_first_repeat", at: lastAt }),
      regressedEvent({ eventId: "evt_regressed_second_repeat", at: laterAt }),
    ], { atBucket: finalAt });

    expect(report.recurringRegressions).toEqual([
      { findingId, title: "SQL injection risk", regressionCount: 2, lastRegressionAt: laterAt },
    ]);
  });

  it("returns no recurring regressions when there are no regression events", () => {
    const report = computeTrends([
      discoveredEvent(),
      seenAgainEvent({ at: middleAt }),
      statusChangedEvent({ at: lastAt, to: "confirmed" }),
    ], { atBucket: finalAt });

    expect(report.recurringRegressions).toEqual([]);
  });

  it("throws when fix survival uses an invalid atBucket timestamp", () => {
    expect(() => computeTrends([discoveredEvent(), statusChangedEvent()], { atBucket: "not-a-date" })).toThrow(/Invalid atBucket timestamp/);
  });

  it("throws when fix survival uses an invalid event timestamp", () => {
    const invalidFixedEvent = {
      type: "finding.status_changed",
      eventId: "evt_status_changed_invalid_at",
      at: "not-a-date",
      findingId,
      from: "open",
      to: "fixed",
      markedBy: "reviewer@example.com",
    } satisfies StatusChangedEvent;

    expect(() => computeTrends([discoveredEvent(), invalidFixedEvent], { atBucket: finalAt })).toThrow(/Invalid event timestamp/);
  });

  it("reports fix survival through atBucket when fixed findings do not reappear", () => {
    const report = computeTrends([discoveredEvent(), statusChangedEvent()], { atBucket: lastAt });

    expect(report.fixSurvivalTime).toEqual([
      {
        findingId,
        title: "SQL injection risk",
        fixedAt: middleAt,
        survivedMs: 86_400_000,
      },
    ]);
  });

  it("ends fix survival when a fixed finding is seen again", () => {
    const report = computeTrends([
      discoveredEvent(),
      statusChangedEvent({ at: middleAt }),
      seenAgainEvent({ at: lastAt }),
    ], { atBucket: laterAt });

    expect(report.fixSurvivalTime).toEqual([
      {
        findingId,
        title: "SQL injection risk",
        fixedAt: middleAt,
        regressedAt: lastAt,
        survivedMs: 86_400_000,
      },
    ]);
  });

  it("records multiple fix survival intervals", () => {
    const report = computeTrends([
      discoveredEvent(),
      statusChangedEvent({ eventId: "evt_status_fixed_first", at: middleAt }),
      regressedEvent({ eventId: "evt_regressed_after_first_fix", at: lastAt }),
      statusChangedEvent({ eventId: "evt_status_fixed_second", at: laterAt, from: "open", to: "fixed" }),
    ], { atBucket: finalAt });

    expect(report.fixSurvivalTime).toEqual([
      {
        findingId,
        title: "SQL injection risk",
        fixedAt: middleAt,
        regressedAt: lastAt,
        survivedMs: 86_400_000,
      },
      {
        findingId,
        title: "SQL injection risk",
        fixedAt: laterAt,
        survivedMs: 86_400_000,
      },
    ]);
  });

  it("ignores status changes to non-fixed statuses for fix survival", () => {
    const report = computeTrends([
      discoveredEvent(),
      statusChangedEvent({ at: middleAt, from: "open", to: "confirmed" }),
      regressedEvent({ at: lastAt, fromStatus: "confirmed", toStatus: "open" }),
    ], { atBucket: laterAt });

    expect(report.fixSurvivalTime).toEqual([]);
  });

  it("uses seen_again events as run boundaries for later status changes", () => {
    const report = computeTrends([
      discoveredEvent(),
      seenAgainEvent({ at: middleAt, runId: "run-seen-boundary" }),
      statusChangedEvent({ at: lastAt }),
    ], { atBucket: finalAt });

    expect(report.perRunTimeline).toEqual([
      { runId: "run-origin", introduced: 1, seenAgain: 0, statusChanged: 0, regressed: 0, totalActive: 1 },
      { runId: "run-seen-boundary", introduced: 0, seenAgain: 1, statusChanged: 1, regressed: 0, totalActive: 0 },
    ]);
  });

  it("attributes pre-boundary status changes to the mark run", () => {
    const preBoundaryAt = "2026-01-01T00:00:00.000Z";
    const boundaryAt = "2026-05-10T00:00:00.000Z";
    const report = computeTrends([
      discoveredEvent({
        at: boundaryAt,
        finding: validFinding({
          origin: {
            runId: "run-origin",
            sourceType: "report",
            sourcePath: ".omre/reports/latest.json",
            createdAt: boundaryAt,
          },
          occurrence: {
            firstSeenAt: boundaryAt,
            lastSeenAt: boundaryAt,
            count: 1,
            runIds: ["run-origin"],
          },
        }),
      }),
      statusChangedEvent({ eventId: "evt_status_before_first_boundary", at: preBoundaryAt }),
    ], { atBucket: finalAt });

    expect(report.perRunTimeline).toContainEqual(
      { runId: "omre-mark", introduced: 0, seenAgain: 0, statusChanged: 1, regressed: 0, totalActive: 0 },
    );
  });

  it("attributes status changes between run boundaries to the earlier run", () => {
    const report = computeTrends([
      discoveredEvent(),
      statusChangedEvent({ eventId: "evt_status_between_boundaries", at: middleAt }),
      seenAgainEvent({ eventId: "evt_seen_after_status", at: lastAt, runId: "run-second-boundary" }),
    ], { atBucket: finalAt });

    expect(report.perRunTimeline).toEqual([
      { runId: "run-origin", introduced: 1, seenAgain: 0, statusChanged: 1, regressed: 0, totalActive: 0 },
      { runId: "run-second-boundary", introduced: 0, seenAgain: 1, statusChanged: 0, regressed: 0, totalActive: 0 },
    ]);
  });

  it("attributes status changes after one run boundary to that run", () => {
    const report = computeTrends([
      discoveredEvent(),
      statusChangedEvent({ eventId: "evt_status_after_single_boundary", at: middleAt }),
    ], { atBucket: finalAt });

    expect(report.perRunTimeline).toEqual([
      { runId: "run-origin", introduced: 1, seenAgain: 0, statusChanged: 1, regressed: 0, totalActive: 0 },
    ]);
  });

  it("buckets status changes without a run boundary under the mark run", () => {
    const report = computeTrends([statusChangedEvent()], { atBucket: lastAt });

    expect(report.perRunTimeline).toEqual([
      { runId: "omre-mark", introduced: 0, seenAgain: 0, statusChanged: 1, regressed: 0, totalActive: 0 },
    ]);
  });

  it("counts regressed events in their run bucket and active totals", () => {
    const report = computeTrends([
      discoveredEvent(),
      statusChangedEvent({ at: middleAt }),
      regressedEvent({ at: lastAt, runId: "run-regression-later" }),
    ], { atBucket: finalAt });

    expect(report.perRunTimeline).toEqual([
      { runId: "run-origin", introduced: 1, seenAgain: 0, statusChanged: 1, regressed: 0, totalActive: 0 },
      { runId: "run-regression-later", introduced: 0, seenAgain: 0, statusChanged: 0, regressed: 1, totalActive: 1 },
    ]);
  });

  it("ignores related events when all event types are present", () => {
    const eventsWithoutRelated = [
      discoveredEvent(),
      statusChangedEvent({ at: middleAt }),
      seenAgainEvent({ at: afterMiddleAt }),
      regressedEvent({ at: lastAt }),
    ];

    const reportWithoutRelated = computeTrends(eventsWithoutRelated, { atBucket: laterAt });
    const reportWithRelated = computeTrends([
      ...eventsWithoutRelated,
      relatedEvent({ at: afterMiddleAt }),
    ], { atBucket: laterAt });

    expect(reportWithRelated).toEqual(reportWithoutRelated);
  });
});

describe("safeDateParse", () => {
  it("returns a numeric timestamp for a valid ISO string", () => {
    const result = safeDateParse("2026-05-28T00:00:00.000Z");
    expect(result).toBe(Date.parse("2026-05-28T00:00:00.000Z"));
    expect(result).toBeTypeOf("number");
  });

  it("returns undefined for a completely invalid string", () => {
    const result = safeDateParse("not-a-date");
    expect(result).toBeUndefined();
  });

  it("returns undefined for a well-formed but invalid date (NaN)", () => {
    const result = safeDateParse("");
    expect(result).toBeUndefined();
  });
});

describe("selectStatusRunId", () => {
  it("returns the mark run id when boundaries are empty", () => {
    const result = selectStatusRunId("2026-05-28T00:00:00.000Z", []);
    expect(result).toBe("omre-mark");
  });

  it("returns the single boundary run id when the timestamp is after it", () => {
    const boundaries: RunBoundary[] = [
      { runId: "run-1", at: "2026-05-28T00:00:00.000Z", order: 0 },
    ];
    const result = selectStatusRunId("2026-05-29T00:00:00.000Z", boundaries);
    expect(result).toBe("run-1");
  });

  it("returns the mark run id when the timestamp is before all boundaries", () => {
    const boundaries: RunBoundary[] = [
      { runId: "run-1", at: "2026-05-28T00:00:00.000Z", order: 0 },
    ];
    const result = selectStatusRunId("2026-05-27T00:00:00.000Z", boundaries);
    expect(result).toBe("omre-mark");
  });

  it("returns the correct run id for multiple boundaries (earlier)", () => {
    const boundaries: RunBoundary[] = [
      { runId: "run-1", at: "2026-05-28T00:00:00.000Z", order: 0 },
      { runId: "run-2", at: "2026-05-30T00:00:00.000Z", order: 1 },
      { runId: "run-3", at: "2026-06-01T00:00:00.000Z", order: 2 },
    ];
    const result = selectStatusRunId("2026-05-29T00:00:00.000Z", boundaries);
    expect(result).toBe("run-1");
  });

  it("returns the correct run id for multiple boundaries (later)", () => {
    const boundaries: RunBoundary[] = [
      { runId: "run-1", at: "2026-05-28T00:00:00.000Z", order: 0 },
      { runId: "run-2", at: "2026-05-30T00:00:00.000Z", order: 1 },
      { runId: "run-3", at: "2026-06-01T00:00:00.000Z", order: 2 },
    ];
    const result = selectStatusRunId("2026-05-31T00:00:00.000Z", boundaries);
    expect(result).toBe("run-2");
  });

  it("returns the last run id when the timestamp is after all boundaries", () => {
    const boundaries: RunBoundary[] = [
      { runId: "run-1", at: "2026-05-28T00:00:00.000Z", order: 0 },
      { runId: "run-2", at: "2026-05-30T00:00:00.000Z", order: 1 },
      { runId: "run-3", at: "2026-06-01T00:00:00.000Z", order: 2 },
    ];
    const result = selectStatusRunId("2026-06-02T00:00:00.000Z", boundaries);
    expect(result).toBe("run-3");
  });
});
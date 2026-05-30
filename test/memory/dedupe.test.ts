import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEventBatchContext,
  generateEventId,
  type EventBatchContext,
} from "../../src/memory/events.js";
import { deduplicateAndGenerateEvents } from "../../src/memory/dedupe.js";
import { MemoryEventSchema, type MemoryEvent, type MemoryFinding } from "../../src/memory/schema.js";

const timestamp = "2026-05-28T00:00:00.000Z";
const sourcePath = ".omre/reports/latest.json";
const thresholds = {
  fingerprintMerge: 0.8,
  samePathProblem: 0.75,
  crossPathRelated: 0.75,
};

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
      runId: "run-original",
      sourceType: "report",
      sourcePath,
      createdAt: timestamp,
    },
    reviewer: "security",
    severity: "high",
    status: "open",
    category: "authz",
    title: "Missing tenant isolation",
    problem: "Tenant records are queried without tenant_id filtering in the repository layer.",
    evidence: "db.query('select * from tenants')",
    locations: [{ path: "src/tenants.ts", line: 42 }],
    occurrence: {
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      count: 1,
      runIds: ["run-original"],
    },
    searchable: {
      redactedText: "tenant records queried without tenant_id filtering",
      tokens: ["tenant", "tenant_id", "filtering"],
    },
    metadata: {
      evidenceTruncated: false,
      problemTruncated: false,
      recommendationTruncated: false,
      sourceMalformed: false,
    },
    contentHash: "ch1234567890abcdef",
  } satisfies MemoryFinding;

  return { ...finding, ...overrides };
}

function ctx(runId = "run-dedupe"): {
  runId: string;
  sourcePath: string;
  batchCtx: EventBatchContext;
} {
  return {
    runId,
    sourcePath,
    batchCtx: createEventBatchContext(runId),
  };
}

function expectSchemaValid(events: MemoryEvent[]): void {
  for (const event of events) {
    expect(MemoryEventSchema.safeParse(event).success).toBe(true);
  }
}

describe("deduplicateAndGenerateEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(timestamp));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits finding.discovered and appends unmatched new findings", () => {
    const newFinding = validFinding({ id: "mem_1111111111111111" });

    const result = deduplicateAndGenerateEvents([newFinding], [], ctx(), thresholds);

    expect(result.events).toEqual([
      {
        type: "finding.discovered",
        eventId: generateEventId(createEventBatchContext("run-dedupe").batchId, 0),
        at: timestamp,
        finding: newFinding,
      },
    ]);
    expect(result.findings).toEqual([newFinding]);
    expectSchemaValid(result.events);
  });

  it("emits finding.seen_again for exact fingerprint matches without appending duplicates", () => {
    const existing = validFinding({ id: "mem_2222222222222222", fingerprint: "fp-matching-123456" });
    const incoming = validFinding({ id: "mem_3333333333333333", fingerprint: existing.fingerprint });

    const result = deduplicateAndGenerateEvents([incoming], [existing], ctx("run-repeat"), thresholds);

    expect(result.events).toEqual([
      {
        type: "finding.seen_again",
        eventId: generateEventId(createEventBatchContext("run-repeat").batchId, 0),
        at: timestamp,
        findingId: existing.id,
        runId: "run-repeat",
        sourcePath,
        matchedBy: "fingerprint-exact",
      },
    ]);
    expect(result.findings).toEqual([existing]);
    expectSchemaValid(result.events);
  });

  it("emits finding.seen_again and finding.regressed when a fixed fingerprint match reappears", () => {
    const existing = validFinding({
      id: "mem_4444444444444444",
      fingerprint: "fp-regressed-1234",
      status: "fixed",
    });
    const incoming = validFinding({ id: "mem_5555555555555555", fingerprint: existing.fingerprint });
    const batchCtx = createEventBatchContext("run-regression");

    const result = deduplicateAndGenerateEvents(
      [incoming],
      [existing],
      { runId: "run-regression", sourcePath, batchCtx },
      thresholds,
    );

    expect(result.events).toEqual([
      {
        type: "finding.seen_again",
        eventId: generateEventId(batchCtx.batchId, 0),
        at: timestamp,
        findingId: existing.id,
        runId: "run-regression",
        sourcePath,
        matchedBy: "fingerprint-exact",
      },
      {
        type: "finding.regressed",
        eventId: generateEventId(batchCtx.batchId, 1),
        at: timestamp,
        findingId: existing.id,
        fromStatus: "fixed",
        toStatus: "open",
        runId: "run-regression",
      },
    ]);
    expect(result.findings).toEqual([existing]);
    expectSchemaValid(result.events);
  });

  it("matches same reviewer, category, and path by similar title before similar problem", () => {
    const existing = validFinding({
      id: "mem_6666666666666666",
      fingerprint: "fp-title-old-1234",
      title: "Missing tenant_id filter in repository query",
      problem: "Old unrelated details about the data access path.",
    });
    const incoming = validFinding({
      id: "mem_7777777777777777",
      fingerprint: "fp-title-new-1234",
      title: "Missing tenant_id filter in repository query",
      problem: "New unrelated details that should not be needed for the match.",
    });

    const result = deduplicateAndGenerateEvents([incoming], [existing], ctx("run-title"), thresholds);

    expect(result.events).toMatchObject([
      {
        type: "finding.seen_again",
        findingId: existing.id,
        runId: "run-title",
        sourcePath,
        matchedBy: "title-similar",
      },
    ]);
    expect(result.findings).toEqual([existing]);
    expectSchemaValid(result.events);
  });

  it("matches same reviewer, category, and path by similar problem when titles differ", () => {
    const existing = validFinding({
      id: "mem_8888888888888888",
      fingerprint: "fp-problem-old-123",
      title: "Tenant query lacks organization guard",
      problem: "Tenant records are queried without tenant_id filtering in repository layer.",
    });
    const incoming = validFinding({
      id: "mem_9999999999999999",
      fingerprint: "fp-problem-new-123",
      title: "Different title for recurring issue",
      problem: "Tenant records are queried without tenant_id filtering in repository layer.",
    });

    const result = deduplicateAndGenerateEvents([incoming], [existing], ctx("run-problem"), thresholds);

    expect(result.events).toMatchObject([
      {
        type: "finding.seen_again",
        findingId: existing.id,
        runId: "run-problem",
        sourcePath,
        matchedBy: "problem-similar-same-path",
      },
    ]);
    expect(result.findings).toEqual([existing]);
    expectSchemaValid(result.events);
  });

  it("emits finding.related for similar problems on different paths without seen_again", () => {
    const existing = validFinding({
      id: "mem_aaaaaaaaaaaaaaaa",
      fingerprint: "fp-related-old-12",
      locations: [{ path: "src/accounts.ts", line: 7 }],
      problem: "Tenant records are queried without tenant_id filtering in repository layer.",
    });
    const incoming = validFinding({
      id: "mem_bbbbbbbbbbbbbbbb",
      fingerprint: "fp-related-new-12",
      locations: [{ path: "src/tenants.ts", line: 42 }],
      problem: "Tenant records are queried without tenant_id filtering in repository layer.",
    });

    const result = deduplicateAndGenerateEvents([incoming], [existing], ctx("run-related"), thresholds);

    expect(result.events).toMatchObject([
      {
        type: "finding.related",
        findingId: incoming.id,
        relatedFindingId: existing.id,
        relationType: "similar-cross-path",
      },
    ]);
    expect(result.events.map((event) => event.type)).not.toContain("finding.seen_again");
    expect(result.findings).toEqual([existing]);
    expectSchemaValid(result.events);
  });

  it("emits schema-valid unique deterministic event IDs for the same fixed batch context", () => {
    const existing = validFinding({
      id: "mem_cccccccccccccccc",
      fingerprint: "fp-deterministic-1",
      status: "fixed",
    });
    const incoming = validFinding({ id: "mem_dddddddddddddddd", fingerprint: existing.fingerprint });

    const first = deduplicateAndGenerateEvents([incoming], [existing], ctx("run-deterministic"), thresholds);
    const second = deduplicateAndGenerateEvents([incoming], [existing], ctx("run-deterministic"), thresholds);
    const eventIds = first.events.map((event) => event.eventId);

    expect(eventIds).toEqual(second.events.map((event) => event.eventId));
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(eventIds).toEqual([
      generateEventId(createEventBatchContext("run-deterministic").batchId, 0),
      generateEventId(createEventBatchContext("run-deterministic").batchId, 1),
    ]);
    expectSchemaValid(first.events);
  });
});

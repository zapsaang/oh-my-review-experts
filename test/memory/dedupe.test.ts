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
    tags: [],
    contentHash: "ch1234567890abcdef",
  } satisfies MemoryFinding;

  return { ...finding, ...overrides };
}

function ctx(runId = "run-dedupe"): {
  runId: string;
  batchCtx: EventBatchContext;
} {
  return {
    runId,
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
    const dedupeCtx = ctx();

    const result = deduplicateAndGenerateEvents([newFinding], [], dedupeCtx, thresholds);

    expect(result.events).toMatchObject([
      {
        type: "finding.discovered",
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
    const dedupeCtx = ctx("run-repeat");

    const result = deduplicateAndGenerateEvents([incoming], [existing], dedupeCtx, thresholds);

    expect(result.events).toMatchObject([
      {
        type: "finding.seen_again",
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
      { runId: "run-regression", batchCtx },
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
        type: "finding.discovered",
        finding: incoming,
      },
      {
        type: "finding.related",
        findingId: incoming.id,
        relatedFindingId: existing.id,
        relationType: "similar-cross-path",
      },
    ]);
    expect(result.events.map((event) => event.type)).not.toContain("finding.seen_again");
    expect(result.findings).toEqual([existing, incoming]);
    expectSchemaValid(result.events);
  });

  it("retains incoming finding and emits finding.discovered BEFORE finding.related for cross-path matches", () => {
    const existing = validFinding({
      id: "mem_crosspathexisting",
      fingerprint: "fp-cross-existing",
      locations: [{ path: "src/users.ts", line: 15 }],
      problem: "Database query lacks parameterization allowing SQL injection.",
    });
    const incoming = validFinding({
      id: "mem_crosspathincoming",
      fingerprint: "fp-cross-incoming",
      locations: [{ path: "src/orders.ts", line: 33 }],
      problem: "Database query lacks parameterization allowing SQL injection.",
    });
    const result = deduplicateAndGenerateEvents([incoming], [existing], ctx("run-crosspath"), thresholds);

    const eventTypes = result.events.map((event) => event.type);
    expect(eventTypes).toContain("finding.discovered");
    expect(eventTypes).toContain("finding.related");
    const discoveredIndex = eventTypes.indexOf("finding.discovered");
    const relatedIndex = eventTypes.indexOf("finding.related");
    expect(discoveredIndex).toBeLessThan(relatedIndex);
    expect(result.findings).toContainEqual(incoming);
    expectSchemaValid(result.events);
  });

  it("emits schema-valid unique event IDs within each batch context", () => {
    const existing = validFinding({
      id: "mem_cccccccccccccccc",
      fingerprint: "fp-deterministic-1",
      status: "fixed",
    });
    const incoming = validFinding({ id: "mem_dddddddddddddddd", fingerprint: existing.fingerprint });

    const firstCtx = ctx("run-deterministic");
    const secondCtx = ctx("run-deterministic");
    const first = deduplicateAndGenerateEvents([incoming], [existing], firstCtx, thresholds);
    const second = deduplicateAndGenerateEvents([incoming], [existing], secondCtx, thresholds);
    const eventIds = first.events.map((event) => event.eventId);
    const secondEventIds = second.events.map((event) => event.eventId);

    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(eventIds).toEqual([
      generateEventId(firstCtx.batchCtx.batchId, 0),
      generateEventId(firstCtx.batchCtx.batchId, 1),
    ]);
    expect(secondEventIds).toEqual([
      generateEventId(secondCtx.batchCtx.batchId, 0),
      generateEventId(secondCtx.batchCtx.batchId, 1),
    ]);
    expect(eventIds).not.toEqual(secondEventIds);
    expectSchemaValid(first.events);
    expectSchemaValid(second.events);
  });

  it("attributes finding.seen_again to the incoming finding's origin.sourcePath", () => {
    const handoffPath = ".omre/handoffs/20260530-120000-001/security.md";
    const reportPath = ".omre/reports/latest.json";

    const existing = validFinding({
      id: "mem_mixed_source_existing",
      fingerprint: "fp-mixed-source-001",
      origin: { ...validFinding().origin, sourcePath: handoffPath },
    });

    const incoming = validFinding({
      id: "mem_mixed_source_incoming",
      fingerprint: existing.fingerprint,
      origin: { ...validFinding().origin, sourcePath: reportPath },
    });

    const batchCtx = createEventBatchContext("run-mixed");
    const mixedCtx = { runId: "run-mixed", batchCtx };

    const result = deduplicateAndGenerateEvents([incoming], [existing], mixedCtx, thresholds);

    const seenAgain = result.events.find((e) => e.type === "finding.seen_again");
    expect(seenAgain).toBeDefined();
    expect(seenAgain!.sourcePath).toBe(reportPath);
    expectSchemaValid(result.events);
  });
});

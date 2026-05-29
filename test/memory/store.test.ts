import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureMemoryDirs, resolveMemoryPaths, type MemoryPaths } from "../../src/memory/paths.js";
import type {
  MemoryEvent,
  MemoryFinding,
  MemoryManifest,
  RelatedIndex,
} from "../../src/memory/schema.js";
import {
  readMaterializedState,
  rebuildMaterializedStateFromEvents,
  writeMaterializedState,
  type MaterializedState,
} from "../../src/memory/store.js";

const findingId = "mem_abcdef1234567890";
const relatedFindingId = "mem_1234567890abcdef";
const timestamp = "2026-05-28T00:00:00.000Z";

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
  } satisfies MemoryFinding;

  return { ...finding, ...overrides };
}

function relatedFinding(): MemoryFinding {
  return validFinding({
    id: relatedFindingId,
    fingerprint: "fpabcdef1234567890",
    reviewer: "quality",
    severity: "medium",
    category: "maintainability",
    title: "Duplicate validation logic",
    problem: "Two modules implement the same validation behavior independently.",
    evidence: "validateUser() and validateAccount() repeat the same branch structure.",
    locations: [{ path: "src/accounts.ts", line: 17 }],
    contentHash: "chabcdef1234567890",
  });
}

function validManifest(overrides: Partial<MemoryManifest> = {}): MemoryManifest {
  const manifest = {
    schemaVersion: 1,
    eventSchemaVersion: 1,
    viewSchemaVersion: 1,
    lastRebuiltAt: timestamp,
    materializedHash: "mat1234567890abcdef",
    relatedIndexHash: "rel1234567890abcdef",
    includedEventFiles: ["events/segments/20260528.jsonl"],
    compactedInputSegments: ["events/compacted/20260528.jsonl"],
    gcSummary: {
      deletedRawSegments: 0,
      deletedTmpFiles: 0,
      deletedQuarantineFiles: 0,
    },
    quarantine: [],
  } satisfies MemoryManifest;

  return { ...manifest, ...overrides };
}

function validRelatedIndex(overrides: Partial<RelatedIndex> = {}): RelatedIndex {
  const relation = { findingId, relatedFindingId, relationType: "same-root-cause" };
  const index = {
    schemaVersion: 1,
    generatedAt: timestamp,
    relations: [relation],
    byFindingId: {
      [findingId]: [relation],
    },
  } satisfies RelatedIndex;

  return { ...index, ...overrides };
}

function validState(overrides: Partial<MaterializedState> = {}): MaterializedState {
  const state = {
    findings: [validFinding(), relatedFinding()],
    manifest: validManifest(),
    relatedIndex: validRelatedIndex(),
  } satisfies MaterializedState;

  return { ...state, ...overrides };
}

function discoveredEvent(overrides: Partial<DiscoveredEvent> = {}): DiscoveredEvent {
  const event = {
    type: "finding.discovered",
    eventId: "evt_discovered_001",
    at: timestamp,
    finding: validFinding(),
  } satisfies DiscoveredEvent;

  return { ...event, ...overrides };
}

function seenAgainEvent(overrides: Partial<SeenAgainEvent> = {}): SeenAgainEvent {
  const event = {
    type: "finding.seen_again",
    eventId: "evt_seen_again_001",
    at: timestamp,
    findingId,
    runId: "run-20260528-repeat",
    sourcePath: ".omre/reports/history/20260528.json",
    matchedBy: "fingerprint",
  } satisfies SeenAgainEvent;

  return { ...event, ...overrides };
}

function statusChangedEvent(overrides: Partial<StatusChangedEvent> = {}): StatusChangedEvent {
  const event = {
    type: "finding.status_changed",
    eventId: "evt_status_changed_001",
    at: timestamp,
    findingId,
    from: "open",
    to: "acknowledged",
    markedBy: "reviewer@example.com",
  } satisfies StatusChangedEvent;

  return { ...event, ...overrides };
}

function regressedEvent(overrides: Partial<RegressedEvent> = {}): RegressedEvent {
  const event = {
    type: "finding.regressed",
    eventId: "evt_regressed_001",
    at: timestamp,
    findingId,
    fromStatus: "fixed",
    toStatus: "open",
    runId: "run-20260528-regression",
  } satisfies RegressedEvent;

  return { ...event, ...overrides };
}

function relatedEvent(overrides: Partial<RelatedEvent> = {}): RelatedEvent {
  const event = {
    type: "finding.related",
    eventId: "evt_related_001",
    at: timestamp,
    findingId,
    relatedFindingId,
    relationType: "same-root-cause",
  } satisfies RelatedEvent;

  return { ...event, ...overrides };
}

function futureEvent() {
  return {
    type: "finding.future",
    eventId: "evt_future_001",
    at: timestamp,
    payload: "ignored by PR1",
  };
}

function writeDataFilesWithoutManifest(paths: MemoryPaths, state: MaterializedState): void {
  fs.writeFileSync(paths.memoryFile, `${state.findings.map((finding) => JSON.stringify(finding)).join("\n")}\n`, "utf8");
  fs.writeFileSync(paths.relatedIndexFile, JSON.stringify(state.relatedIndex), "utf8");
}

describe("materialized memory store", () => {
  let tmpDir: string;
  let paths: MemoryPaths;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-store-test-"));
    paths = resolveMemoryPaths(tmpDir);
    ensureMemoryDirs(paths);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the manifest is absent", () => {
    writeDataFilesWithoutManifest(paths, validState());

    expect(readMaterializedState(paths)).toBeNull();
  });

  it("round-trips findings, manifest, and related index from disk", () => {
    const state = validState();

    writeMaterializedState(paths, state);

    const memoryLines = fs.readFileSync(paths.memoryFile, "utf8").trimEnd().split("\n");
    expect(memoryLines).toHaveLength(2);
    expect(readMaterializedState(paths)).toEqual(state);
  });

  it("writes memory and related index before manifest as the commit point", () => {
    const state = validState();
    const originalRenameSync = fs.renameSync;
    const renameTargets: string[] = [];
    let stateAfterRelatedWrite: MaterializedState | null | undefined;

    vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      originalRenameSync(oldPath, newPath);
      renameTargets.push(newPath.toString());

      if (newPath.toString() === paths.relatedIndexFile) {
        stateAfterRelatedWrite = readMaterializedState(paths);
      }
    });

    writeMaterializedState(paths, state);

    expect(renameTargets).toEqual([paths.memoryFile, paths.relatedIndexFile, paths.manifestFile]);
    expect(stateAfterRelatedWrite).toBeNull();
    expect(readMaterializedState(paths)).toEqual(state);
  });

  it("rebuilds findings only from finding.discovered events", () => {
    const first = validFinding();
    const second = relatedFinding();

    const state = rebuildMaterializedStateFromEvents([
      seenAgainEvent({ eventId: "evt_seen_before_discovery", findingId: first.id }),
      discoveredEvent({ eventId: "evt_discovered_first", finding: first }),
      relatedEvent({ eventId: "evt_related_noop", findingId: first.id, relatedFindingId: second.id }),
      discoveredEvent({ eventId: "evt_discovered_second", finding: second }),
    ]);

    expect(state.findings).toEqual([first, second]);
    expect(state.manifest.schemaVersion).toBe(1);
    expect(state.manifest.materializedHash).toMatch(/^[a-f0-9]{16}$/);
    expect(state.relatedIndex.relations).toEqual([]);
    expect(state.relatedIndex.byFindingId).toEqual({});
  });

  it("handles unknown event types as no-ops without throwing", () => {
    const discovered = discoveredEvent();
    const future = futureEvent() as unknown as MemoryEvent;
    let rebuilt: MaterializedState | undefined;

    expect(() => {
      rebuilt = rebuildMaterializedStateFromEvents([future, discovered]);
    }).not.toThrow();

    expect(rebuilt?.findings).toEqual([discovered.finding]);
  });

  it("keeps PR2 event variants as no-ops in PR1", () => {
    const original = validFinding();

    const state = rebuildMaterializedStateFromEvents([
      discoveredEvent({ finding: original }),
      seenAgainEvent({ findingId: original.id, runId: "run-20260528-repeat" }),
      statusChangedEvent({ findingId: original.id, from: "open", to: "acknowledged" }),
      regressedEvent({ findingId: original.id, fromStatus: "fixed", toStatus: "open" }),
      relatedEvent({ findingId: original.id, relatedFindingId }),
    ]);

    // PR2: finding.seen_again will update occurrence count and lastSeenAt.
    // PR2: finding.status_changed will update the finding status.
    // PR2: finding.regressed will record fixed-to-open regressions.
    // PR2: finding.related will populate the related index.
    expect(state.findings).toEqual([original]);
    expect(state.findings[0]?.occurrence).toEqual(original.occurrence);
    expect(state.findings[0]?.status).toBe("open");
    expect(state.relatedIndex).toMatchObject({ relations: [], byFindingId: {} });
  });
});

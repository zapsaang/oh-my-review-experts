import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureMemoryDirs, resolveMemoryPaths, type MemoryPaths } from "../../src/memory/paths.js";
import { MemoryManifestSchema, normalizeMemoryStatus, type MemoryEvent, type MemoryFinding, type MemoryManifest, type RelatedIndex } from "../../src/memory/schema.js";
import {
  hashFindings,
  readMaterializedState,
  rebuildMaterializedStateFromEvents,
  scanEventFiles,
  writeMaterializedState,
  type MaterializedState,
} from "../../src/memory/store.js";
import { writeSegment } from "./_helpers.js";

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
    tags: [],
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
    materializedHash: hashFindings([validFinding(), relatedFinding()]),
    relatedIndexHash: "rel1234567890abcdef",
    includedEventFiles: ["events/segments/20260528.jsonl"],
    compactedInputSegments: ["events/compacted/20260528.jsonl"],
    gcSummary: {
      lastGcAt: undefined,
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
    to: "confirmed",
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

function hashAsRead(findings: MemoryFinding[]): string {
  const normalized = findings.map((finding) => ({
    ...finding,
    status: normalizeMemoryStatus(finding.status) as MemoryFinding["status"],
  }));
  return hashFindings(normalized);
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

  it("rebuilds unique findings from finding.discovered events", () => {
    const first = validFinding();
    const second = relatedFinding();

    const state = rebuildMaterializedStateFromEvents([
      seenAgainEvent({ eventId: "evt_seen_before_discovery", findingId: first.id }),
      discoveredEvent({ eventId: "evt_discovered_first", finding: first }),
      discoveredEvent({ eventId: "evt_discovered_duplicate", finding: first }),
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

  it("replays finding.seen_again by incrementing occurrence and deduplicating run IDs", () => {
    const original = validFinding();
    const originalOccurrence = {
      ...original.occurrence,
      runIds: [...original.occurrence.runIds],
    };
    const firstSeenAgainAt = "2026-05-29T00:00:00.000Z";
    const secondSeenAgainAt = "2026-05-30T00:00:00.000Z";

    const state = rebuildMaterializedStateFromEvents([
      discoveredEvent({ finding: original }),
      seenAgainEvent({
        eventId: "evt_seen_again_first",
        at: firstSeenAgainAt,
        findingId: original.id,
        runId: "run-20260529-repeat",
      }),
      seenAgainEvent({
        eventId: "evt_seen_again_second",
        at: secondSeenAgainAt,
        findingId: original.id,
        runId: "run-20260529-repeat",
      }),
    ]);

    expect(state.findings[0]?.occurrence).toEqual({
      ...originalOccurrence,
      count: originalOccurrence.count + 2,
      lastSeenAt: secondSeenAgainAt,
      runIds: [...originalOccurrence.runIds, "run-20260529-repeat"],
    });
  });

  it("replays finding.status_changed by updating the finding status", () => {
    const original = validFinding();

    const state = rebuildMaterializedStateFromEvents([
      discoveredEvent({ finding: original }),
      statusChangedEvent({ findingId: original.id, from: "open", to: "confirmed" }),
    ]);

    expect(state.findings[0]?.status).toBe("confirmed");
  });

  it("replays finding.regressed by reopening the finding and refreshing occurrence metadata", () => {
    const original = validFinding({ status: "fixed" });
    const originalOccurrence = {
      ...original.occurrence,
      runIds: [...original.occurrence.runIds],
    };
    const regressedAt = "2026-05-29T12:00:00.000Z";

    const state = rebuildMaterializedStateFromEvents([
      discoveredEvent({ finding: original }),
      regressedEvent({
        at: regressedAt,
        findingId: original.id,
        fromStatus: "fixed",
        toStatus: "open",
        runId: "run-20260529-regression",
      }),
    ]);

    expect(state.findings[0]?.status).toBe("open");
    expect(state.findings[0]?.occurrence).toEqual({
      ...originalOccurrence,
      lastSeenAt: regressedAt,
      runIds: [...originalOccurrence.runIds, "run-20260529-regression"],
    });
  });

  it("replays finding.related by populating and deduplicating the related index", () => {
    const first = validFinding();
    const second = relatedFinding();
    const relation = { findingId: first.id, relatedFindingId: second.id, relationType: "same-root-cause" };

    const state = rebuildMaterializedStateFromEvents([
      discoveredEvent({ eventId: "evt_discovered_first", finding: first }),
      discoveredEvent({ eventId: "evt_discovered_second", finding: second }),
      relatedEvent({ eventId: "evt_related_first", findingId: first.id, relatedFindingId: second.id }),
      relatedEvent({ eventId: "evt_related_duplicate", findingId: first.id, relatedFindingId: second.id }),
    ]);

    expect(state.relatedIndex.relations).toEqual([relation]);
    expect(state.relatedIndex.byFindingId).toEqual({
      [first.id]: [relation],
    });
  });

  it("should produce manifest compatible with new schema", () => {
    const state = rebuildMaterializedStateFromEvents([]);

    expect(() => MemoryManifestSchema.parse(state.manifest)).not.toThrow();
    expect(state.manifest.includedEventFiles).toEqual([]);
    expect(state.manifest.compactedInputSegments).toEqual([]);
    expect(state.manifest.quarantine).toEqual([]);
  });

  it("populates manifest.includedEventFiles from event files on disk when writing", () => {
    const segmentPath = writeSegment(paths, [discoveredEvent()], "run-20260528");

    const state = validState({ manifest: validManifest({ includedEventFiles: [] }) });
    writeMaterializedState(paths, state);

    const read = readMaterializedState(paths);
    expect(read).not.toBeNull();

    const included = read!.manifest.includedEventFiles;
    expect(Array.isArray(included)).toBe(true);
    expect(included.length).toBe(1);

    const entry = included[0] as Extract<typeof included[number], { kind: string }>;
    expect(entry.path).toBe(path.relative(paths.root, segmentPath));
    expect(entry.kind).toBe("raw");
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.eventCount).toBe(1);
    expect(entry.minTimestamp).toBe(timestamp);
    expect(entry.maxTimestamp).toBe(timestamp);
  });

  it("classifies compacted segments and sorts scan results by minTimestamp ascending", () => {
    const later = "2026-06-01T00:00:00.000Z";
    const rawPath = writeSegment(paths, [discoveredEvent({ at: later })], "run-raw");
    const compactedPath = writeSegment(
      paths,
      [discoveredEvent({ eventId: "evt_compacted", at: timestamp })],
      "run-compacted",
      { kind: "compacted" },
    );

    const scanned = scanEventFiles(paths);
    expect(scanned).toHaveLength(2);
    expect(scanned[0]!.path).toBe(path.relative(paths.root, compactedPath));
    expect(scanned[0]!.kind).toBe("compacted");
    expect(scanned[1]!.path).toBe(path.relative(paths.root, rawPath));
    expect(scanned[1]!.kind).toBe("raw");
  });

  it("keeps rebuildMaterializedStateFromEvents pure with no filesystem writes", () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const renameSpy = vi.spyOn(fs, "renameSync");

    rebuildMaterializedStateFromEvents([discoveredEvent()]);

    expect(writeSpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
  });

  describe("legacy status compatibility", () => {
    it("reads legacy acknowledged status as confirmed", () => {
      // @ts-expect-error legacy status value for backward-compatibility test
      const finding = validFinding({ status: "acknowledged" });
      const state = validState({ findings: [finding] });
      writeDataFilesWithoutManifest(paths, state);
      fs.writeFileSync(paths.manifestFile, JSON.stringify(validManifest({ materializedHash: hashAsRead(state.findings) })), "utf8");

      const read = readMaterializedState(paths);
      expect(read).not.toBeNull();
      expect(read!.findings[0]!.status).toBe("confirmed");
    });

    it("reads legacy false_positive status as false-positive", () => {
      // @ts-expect-error legacy status value for backward-compatibility test
      const finding = validFinding({ status: "false_positive" });
      const state = validState({ findings: [finding] });
      writeDataFilesWithoutManifest(paths, state);
      fs.writeFileSync(paths.manifestFile, JSON.stringify(validManifest({ materializedHash: hashAsRead(state.findings) })), "utf8");

      const read = readMaterializedState(paths);
      expect(read).not.toBeNull();
      expect(read!.findings[0]!.status).toBe("false-positive");
    });

    it("reads legacy wont_fix status as ignored", () => {
      // @ts-expect-error legacy status value for backward-compatibility test
      const finding = validFinding({ status: "wont_fix" });
      const state = validState({ findings: [finding] });
      writeDataFilesWithoutManifest(paths, state);
      fs.writeFileSync(paths.manifestFile, JSON.stringify(validManifest({ materializedHash: hashAsRead(state.findings) })), "utf8");

      const read = readMaterializedState(paths);
      expect(read).not.toBeNull();
      expect(read!.findings[0]!.status).toBe("ignored");
    });

    it("rebuilds from events with legacy status and writes canonical status", () => {
      // @ts-expect-error legacy status value for backward-compatibility test
      const legacyFinding = validFinding({ status: "acknowledged" });

      const state = rebuildMaterializedStateFromEvents([
        discoveredEvent({ finding: legacyFinding }),
      ]);

      expect(state.findings[0]!.status).toBe("confirmed");
    });

    it("replays old status_changed event with legacy status without crashing", () => {
      const original = validFinding();

      const state = rebuildMaterializedStateFromEvents([
        discoveredEvent({ finding: original }),
        // @ts-expect-error legacy status value for backward-compatibility test
        statusChangedEvent({ findingId: original.id, from: "open", to: "acknowledged" }),
      ]);

      expect(state.findings[0]!.status).toBe("confirmed");
    });

    it("replays old regressed event with legacy status without crashing", () => {
      const original = validFinding({ status: "fixed" });

      const state = rebuildMaterializedStateFromEvents([
        discoveredEvent({ finding: original }),
        regressedEvent({
          findingId: original.id,
          fromStatus: "fixed",
          // @ts-expect-error legacy status value for backward-compatibility test
          toStatus: "wont_fix",
          runId: "run-20260529-regression",
        }),
      ]);

      expect(state.findings[0]!.status).toBe("ignored");
    });

    it("materializes mixed old and new records correctly", () => {
      // @ts-expect-error legacy status value for backward-compatibility test
      const legacyAcknowledged = validFinding({ id: "mem_legacyack1234567", status: "acknowledged" });
      // @ts-expect-error legacy status value for backward-compatibility test
      const legacyFalsePositive = validFinding({ id: "mem_legacyfp12345678", status: "false_positive" });
      // @ts-expect-error legacy status value for backward-compatibility test
      const legacyWontFix = validFinding({ id: "mem_legacywf123456789", status: "wont_fix" });
      const canonicalOpen = validFinding({ id: "mem_canonicalopen12345", status: "open" });
      const canonicalFixed = validFinding({ id: "mem_canonicalfixed1234", status: "fixed" });

      const state = validState({
        findings: [legacyAcknowledged, legacyFalsePositive, legacyWontFix, canonicalOpen, canonicalFixed],
      });
      writeDataFilesWithoutManifest(paths, state);
      fs.writeFileSync(paths.manifestFile, JSON.stringify(validManifest({ materializedHash: hashAsRead(state.findings) })), "utf8");

      const read = readMaterializedState(paths);
      expect(read).not.toBeNull();
      expect(read!.findings).toHaveLength(5);

      const byId = Object.fromEntries(read!.findings.map((f) => [f.id, f.status]));
      expect(byId["mem_legacyack1234567"]).toBe("confirmed");
      expect(byId["mem_legacyfp12345678"]).toBe("false-positive");
      expect(byId["mem_legacywf123456789"]).toBe("ignored");
      expect(byId["mem_canonicalopen12345"]).toBe("open");
      expect(byId["mem_canonicalfixed1234"]).toBe("fixed");
    });
  });
});

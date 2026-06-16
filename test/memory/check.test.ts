import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { MemoryPaths } from "../../src/memory/paths.js";
import type { MemoryEvent } from "../../src/memory/schema.js";
import { writeMaterializedState, rebuildMaterializedStateFromEvents } from "../../src/memory/store.js";
import { makeTempRepo, writeFinding, writeSegment } from "./_helpers.js";
import { runMemoryCheck, renderCheckResult } from "../../src/memory/check.js";

const timestamp = "2026-05-28T00:00:00.000Z";

function makeDiscoveredEvent(id: string, at: string = timestamp): MemoryEvent {
  return {
    eventId: `evt_${id.padEnd(24, "0")}`,
    at,
    type: "finding.discovered",
    finding: writeFinding({ id: `mem_${id.padEnd(32, "0")}` }),
  };
}

describe("runMemoryCheck", () => {
  let paths: MemoryPaths;

  beforeEach(() => {
    paths = makeTempRepo();
  });

  describe("healthy state passes", () => {
    it("returns healthy: true on seeded valid repo", () => {
      const events1: MemoryEvent[] = [makeDiscoveredEvent("aaa")];
      const events2: MemoryEvent[] = [makeDiscoveredEvent("bbb", "2026-05-28T01:00:00.000Z")];
      const events3: MemoryEvent[] = [makeDiscoveredEvent("ccc", "2026-05-28T02:00:00.000Z")];
      const eventsCompacted: MemoryEvent[] = [makeDiscoveredEvent("ddd", "2026-05-28T03:00:00.000Z")];

      writeSegment(paths, events1, "run-a");
      writeSegment(paths, events2, "run-b");
      writeSegment(paths, events3, "run-c");
      writeSegment(paths, eventsCompacted, "run-d", { kind: "compacted" });

      // Rebuild state from all events and write (Task 1 fix populates includedEventFiles)
      const allEvents = [...events1, ...events2, ...events3, ...eventsCompacted];
      const rebuilt = rebuildMaterializedStateFromEvents(allEvents);
      writeMaterializedState(paths, rebuilt);

      // Write VERSION file
      fs.writeFileSync(paths.versionFile, JSON.stringify({
        schemaVersion: 1,
        eventSchemaVersion: 1,
        viewSchemaVersion: 1,
      }));

      const result = runMemoryCheck(paths);

      expect(result.healthy).toBe(true);
      expect(result.segments.raw).toBe(3);
      expect(result.segments.compacted).toBe(1);
      expect(result.segments.orphanRaw).toBe(0);
      expect(result.segments.includedInManifest).toBe(4);
      expect(result.warnings).toHaveLength(0);
      expect(result.version.schemaVersion).toBe(1);
      expect(result.version.eventSchemaVersion).toBe(1);
      expect(result.materialized.findings).toBe(4);
      expect(result.materialized.relations).toBe(0);
    });
  });

  describe("orphan raw segment detected", () => {
    it("flags orphan raw segments not in manifest.includedEventFiles", () => {
      const events1: MemoryEvent[] = [makeDiscoveredEvent("aaa")];
      writeSegment(paths, events1, "run-a");

      // Rebuild and write state (only includes the one segment)
      const rebuilt = rebuildMaterializedStateFromEvents(events1);
      writeMaterializedState(paths, rebuilt);

      // Write VERSION file
      fs.writeFileSync(paths.versionFile, JSON.stringify({
        schemaVersion: 1,
        eventSchemaVersion: 1,
        viewSchemaVersion: 1,
      }));

      // NOW write an orphan segment (after writeMaterializedState, so it's NOT in includedEventFiles)
      const orphanEvents: MemoryEvent[] = [makeDiscoveredEvent("zzz", "2026-05-29T00:00:00.000Z")];
      writeSegment(paths, orphanEvents, "orphan-run");

      const result = runMemoryCheck(paths);

      expect(result.segments.orphanRaw).toBe(1);
      expect(result.warnings.some((w) => /orphan/i.test(w))).toBe(true);
    });
  });

  describe("legacy string[] manifest degrades gracefully", () => {
    it("warns and skips advanced orphan check for legacy manifests", () => {
      // Bypass writeMaterializedState (re-scans includedEventFiles) to keep string[] legacy form.
      fs.writeFileSync(paths.manifestFile, JSON.stringify({
        schemaVersion: 1,
        eventSchemaVersion: 1,
        viewSchemaVersion: 1,
        lastRebuiltAt: timestamp,
        materializedHash: "mat1234567890abcdef",
        relatedIndexHash: "rel1234567890abcdef",
        includedEventFiles: ["a.jsonl"],
        compactedInputSegments: [],
        gcSummary: {
          deletedRawSegments: 0,
          deletedTmpFiles: 0,
          deletedQuarantineFiles: 0,
        },
        quarantine: [],
      }));

      // Write VERSION file
      fs.writeFileSync(paths.versionFile, JSON.stringify({
        schemaVersion: 1,
        eventSchemaVersion: 1,
        viewSchemaVersion: 1,
      }));

      const result = runMemoryCheck(paths);

      expect(result.warnings.some((w) => /legacy|string/i.test(w))).toBe(true);
      expect(result.segments.orphanRaw).toBe(0);
      expect(typeof result.healthy).toBe("boolean");
    });
  });

  describe("empty memory dir does not throw", () => {
    it("returns graceful result on fresh temp repo", () => {
      const result = runMemoryCheck(paths);

      expect(result.segments.raw).toBe(0);
      expect(result.segments.compacted).toBe(0);
      expect(result.segments.includedInManifest).toBe(0);
      expect(result.healthy).toBe(true);
    });
  });

  describe("renderCheckResult", () => {
    it("produces stable text output", () => {
      const events1: MemoryEvent[] = [makeDiscoveredEvent("aaa")];
      writeSegment(paths, events1, "run-a");

      const rebuilt = rebuildMaterializedStateFromEvents(events1);
      writeMaterializedState(paths, rebuilt);

      fs.writeFileSync(paths.versionFile, JSON.stringify({
        schemaVersion: 1,
        eventSchemaVersion: 1,
        viewSchemaVersion: 1,
      }));

      const result = runMemoryCheck(paths);
      const text = renderCheckResult(result);

      expect(text).toContain("Memory Check");
      expect(text).toContain("Version:");
      expect(text).toContain("schemaVersion: 1");
      expect(text).toContain("Segments:");
      expect(text).toContain("raw: 1");
      expect(text).toContain("Materialized:");
      expect(text).toContain("findings: 1");
    });
  });
});

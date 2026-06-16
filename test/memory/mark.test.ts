import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { runMemoryMark } from "../../src/memory/mark.js";
import { writeEventSegment } from "../../src/memory/events.js";
import {
  rebuildMaterializedStateFromEvents,
  writeMaterializedState,
} from "../../src/memory/store.js";
import type { MemoryEvent, MemoryFinding } from "../../src/memory/schema.js";
import type { MemoryPaths } from "../../src/memory/paths.js";
import { makeTempRepo, writeFinding } from "./_helpers.js";

const TIMESTAMP = "2026-05-28T00:00:00.000Z";

function discoveredEvent(finding: MemoryFinding, eventId: string): MemoryEvent {
  return {
    type: "finding.discovered",
    eventId,
    at: TIMESTAMP,
    finding,
  };
}

/**
 * Seed a memory store so it contains `finding`: write a finding.discovered
 * event segment to disk, then rebuild + persist the materialized state from
 * that event. This mirrors how runMemoryMark reads state then rebuilds from
 * on-disk events.
 */
function seedFinding(paths: MemoryPaths, finding: MemoryFinding): void {
  writeEventSegment(paths, [discoveredEvent(finding, "evt_seed_discovered_0001")], "run-seed");
  const state = rebuildMaterializedStateFromEvents([
    discoveredEvent(finding, "evt_seed_discovered_0001"),
  ]);
  writeMaterializedState(paths, state);
}

describe("runMemoryMark", () => {
  let paths: MemoryPaths;

  beforeEach(() => {
    paths = makeTempRepo();
  });

  afterEach(() => {
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  it("marks an open finding as fixed and reports the transition", () => {
    const finding = writeFinding({ id: "mem_markhappy0123456", status: "open" });
    seedFinding(paths, finding);

    const result = runMemoryMark({
      findingId: finding.id,
      status: "fixed",
      cwd: paths.root.replace(/\/\.omre\/memory$/, ""),
    });

    expect(result.success).toBe(true);
    expect(result.findingId).toBe(finding.id);
    expect(result.previousStatus).toBe("open");
    expect(result.newStatus).toBe("fixed");
    expect(result.eventId).toMatch(/^evt_[a-f0-9]{24}$/);
    expect(fs.existsSync(result.segmentPath)).toBe(true);
  });

  it("persists the new status so a subsequent read reflects fixed", () => {
    const finding = writeFinding({ id: "mem_markpersist01234", status: "open" });
    seedFinding(paths, finding);
    const cwd = paths.root.replace(/\/\.omre\/memory$/, "");

    runMemoryMark({ findingId: finding.id, status: "fixed", cwd });

    const memoryRaw = fs.readFileSync(paths.memoryFile, "utf8").trim();
    const persisted = JSON.parse(memoryRaw) as MemoryFinding;
    expect(persisted.status).toBe("fixed");
  });

  it("rejects an invalid transition (ignored → confirmed)", () => {
    const finding = writeFinding({ id: "mem_markinvalid01234", status: "ignored" });
    seedFinding(paths, finding);
    const cwd = paths.root.replace(/\/\.omre\/memory$/, "");

    expect(() => runMemoryMark({ findingId: finding.id, status: "confirmed", cwd }))
      .toThrow("invalid transition: ignored → confirmed");
  });

  it("throws when the finding does not exist", () => {
    const finding = writeFinding({ id: "mem_markmissing01234", status: "open" });
    seedFinding(paths, finding);
    const cwd = paths.root.replace(/\/\.omre\/memory$/, "");

    expect(() => runMemoryMark({ findingId: "mem_doesnotexist0123", status: "fixed", cwd }))
      .toThrow("finding not found: mem_doesnotexist0123");
  });

  it("throws when no memory state exists", () => {
    const cwd = paths.root.replace(/\/\.omre\/memory$/, "");

    expect(() => runMemoryMark({ findingId: "mem_markmissing01234", status: "fixed", cwd }))
      .toThrow("no memory state found");
  });

  it("normalizes a legacy status alias before validating (wont_fix → ignored)", () => {
    const finding = writeFinding({ id: "mem_markalias0123456", status: "open" });
    seedFinding(paths, finding);
    const cwd = paths.root.replace(/\/\.omre\/memory$/, "");

    const result = runMemoryMark({ findingId: finding.id, status: "wont_fix", cwd });

    expect(result.previousStatus).toBe("open");
    expect(result.newStatus).toBe("ignored");

    const persisted = JSON.parse(fs.readFileSync(paths.memoryFile, "utf8").trim()) as MemoryFinding;
    expect(persisted.status).toBe("ignored");
  });
});

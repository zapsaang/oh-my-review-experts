// Wave 3 RED coverage: proves each of the 4 memory write entry points engages
// the repo-level memory lock. Approach: spy on lock.withMemoryLock (the spy is
// observed across the ESM boundary in this runtime — verified) and assert each
// entry point invokes it exactly once. The default spy calls through, so the
// real lock is taken and released and the fn body runs normally.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lockModule from "../../src/memory/lock.js";
import { writeEventSegment } from "../../src/memory/events.js";
import { rebuildMaterializedStateFromEvents, writeMaterializedState } from "../../src/memory/store.js";
import { runIndexLatest } from "../../src/memory/indexing.js";
import { runMemoryMark } from "../../src/memory/mark.js";
import { runMemoryGc } from "../../src/memory/gc.js";
import { runMemoryCompact } from "../../src/memory/compact.js";
import type { MemoryEvent, MemoryFinding } from "../../src/memory/schema.js";
import type { MemoryPaths } from "../../src/memory/paths.js";
import { makeTempRepo, writeFinding } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const LATEST_FIXTURE_PATH = path.join(FIXTURES_DIR, "latest.json");
const HANDOFF_FIXTURE_PATH = path.join(FIXTURES_DIR, "handoff-sample.md");
const TIMESTAMP = "2026-05-28T00:00:00.000Z";
const ORIGINAL_CWD = process.cwd();

function repoCwd(paths: MemoryPaths): string {
  return paths.root.replace(/\/\.omre\/memory$/, "");
}

function discoveredEvent(finding: MemoryFinding): MemoryEvent {
  return { type: "finding.discovered", eventId: "evt_engage_discovered_0000", at: TIMESTAMP, finding };
}

function seedFinding(paths: MemoryPaths, finding: MemoryFinding): void {
  const events = [discoveredEvent(finding)];
  writeEventSegment(paths, events, "run-engage-seed");
  writeMaterializedState(paths, rebuildMaterializedStateFromEvents(events));
}

function seedReportFixture(cwd: string): void {
  const reportDir = path.join(cwd, ".omre", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "latest.json");
  fs.copyFileSync(LATEST_FIXTURE_PATH, reportPath);

  const runId = (JSON.parse(fs.readFileSync(reportPath, "utf8")) as { run_id?: string }).run_id;
  if (!runId) {
    throw new Error("latest.json fixture must include run_id");
  }

  const handoffDir = path.join(cwd, ".omre", "handoffs", runId);
  fs.mkdirSync(handoffDir, { recursive: true });
  fs.copyFileSync(HANDOFF_FIXTURE_PATH, path.join(handoffDir, "handoff-sample.md"));
}

describe("memory write entry points engage the lock", () => {
  let paths: MemoryPaths;

  beforeEach(() => {
    paths = makeTempRepo();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(ORIGINAL_CWD);
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  it("runIndexLatest acquires the memory lock", () => {
    const cwd = repoCwd(paths);
    seedReportFixture(cwd);
    process.chdir(cwd);

    const spy = vi.spyOn(lockModule, "withMemoryLock");
    const result = runIndexLatest({ cwd, output: { log: () => undefined, error: () => undefined } });

    expect(result.eventsGenerated).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("runMemoryMark acquires the memory lock", () => {
    const cwd = repoCwd(paths);
    seedFinding(paths, writeFinding({ id: "mem_lockengagemark01", status: "open" }));

    const spy = vi.spyOn(lockModule, "withMemoryLock");
    const result = runMemoryMark({ cwd, findingId: "mem_lockengagemark01", status: "fixed" });

    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("runMemoryGc acquires the memory lock", () => {
    const cwd = repoCwd(paths);

    const spy = vi.spyOn(lockModule, "withMemoryLock");
    const result = runMemoryGc({ cwd, dryRun: true });

    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("runMemoryCompact acquires the memory lock", () => {
    const cwd = repoCwd(paths);

    const spy = vi.spyOn(lockModule, "withMemoryLock");
    const result = runMemoryCompact({ cwd, dryRun: true });

    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

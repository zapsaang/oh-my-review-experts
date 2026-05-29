import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureMemoryDirs, resolveMemoryPaths, type MemoryPaths } from "../../src/memory/paths.js";
import { MemoryEventSchema, type MemoryEvent, type MemoryFinding } from "../../src/memory/schema.js";
import {
  compareMemoryEvents,
  createEventBatchContext,
  generateBatchId,
  generateEventId,
  nextEventId,
  readAllEventSegments,
  writeEventSegment,
} from "../../src/memory/events.js";

const findingId = "mem_abcdef1234567890";
const timestamp = "2026-05-28T00:00:00.000Z";

type DiscoveredEvent = Extract<MemoryEvent, { type: "finding.discovered" }>;
type SeenAgainEvent = Extract<MemoryEvent, { type: "finding.seen_again" }>;

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

function writeJsonl(filePath: string, values: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

describe("memory event helpers", () => {
  let tmpDir: string;
  let paths: MemoryPaths;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-events-test-"));
    paths = resolveMemoryPaths(tmpDir);
    ensureMemoryDirs(paths);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates deterministic 16-character hex batch IDs", () => {
    const first = generateBatchId("run-20260528");
    const second = generateBatchId("run-20260528");

    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(second).toBe(first);
    expect(generateBatchId("run-20260529")).not.toBe(first);
  });

  it("generates deterministic event IDs with the evt prefix and 24 hex characters", () => {
    const first = generateEventId("batch-1234", 7);
    const second = generateEventId("batch-1234", 7);

    expect(first).toMatch(/^evt_[a-f0-9]{24}$/);
    expect(second).toBe(first);
    expect(generateEventId("batch-1234", 8)).not.toBe(first);
  });

  it("creates a batch context and increments event sequence IDs", () => {
    const ctx = createEventBatchContext("run-20260528");

    expect(ctx.runId).toBe("run-20260528");
    expect(ctx.batchId).toBe(generateBatchId("run-20260528"));
    expect(ctx.seqCounter).toBe(0);
    expect(Date.parse(ctx.createdAt)).not.toBeNaN();

    expect(nextEventId(ctx)).toBe(generateEventId(ctx.batchId, 0));
    expect(nextEventId(ctx)).toBe(generateEventId(ctx.batchId, 1));
    expect(ctx.seqCounter).toBe(2);
  });

  it("sorts memory events by timestamp ascending and then eventId ascending", () => {
    const later = seenAgainEvent({ eventId: "evt_c", at: "2026-05-28T00:00:02.000Z" });
    const sameTimeSecond = seenAgainEvent({ eventId: "evt_b", at: "2026-05-28T00:00:01.000Z" });
    const sameTimeFirst = discoveredEvent({ eventId: "evt_a", at: "2026-05-28T00:00:01.000Z" });

    const sorted = [later, sameTimeSecond, sameTimeFirst].sort(compareMemoryEvents);

    expect(sorted.map((event) => event.eventId)).toEqual(["evt_a", "evt_b", "evt_c"]);
  });

  it("writes a JSONL segment with one memory event per line", () => {
    const events = [
      discoveredEvent({ eventId: "evt_discovered_line" }),
      seenAgainEvent({ eventId: "evt_seen_again_line" }),
    ];

    const result = writeEventSegment(paths, events, "run-20260528");
    const content = fs.readFileSync(result.segmentPath, "utf8");
    const lines = content.trimEnd().split("\n");

    expect(result.eventsWritten).toBe(2);
    expect(path.dirname(result.segmentPath)).toBe(paths.segmentsDir);
    expect(content.endsWith("\n")).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => MemoryEventSchema.parse(JSON.parse(line)).eventId)).toEqual([
      "evt_discovered_line",
      "evt_seen_again_line",
    ]);
  });

  it("includes timestamp, pid, random suffix, and sanitized runId in segment filenames", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T12:34:56.789Z"));

    const result = writeEventSegment(paths, [discoveredEvent()], "run:with/slashes and spaces");

    expect(path.basename(result.segmentPath)).toMatch(
      new RegExp(`^20260528123456-${process.pid}-[a-f0-9]{8}-run_with_slashes_and_spaces\\.jsonl$`),
    );
  });

  it("writes segments with exclusive create mode so an existing path throws", () => {
    const originalWriteFileSync = fs.writeFileSync;
    const writeFileSpy = vi.spyOn(fs, "writeFileSync");

    writeFileSpy.mockImplementation((file, data, options) => {
      originalWriteFileSync(file.toString(), "", { encoding: "utf8", flag: "w" });
      return originalWriteFileSync(file, data, options);
    });

    expect(() => writeEventSegment(paths, [discoveredEvent()], "run-collision")).toThrow();
    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringMatching(/run-collision\.jsonl$/),
      expect.any(String),
      { encoding: "utf8", flag: "wx" },
    );
  });

  it("reads segments and compacted event files, validates JSON lines, skips invalid lines, and returns sorted events", () => {
    const later = seenAgainEvent({ eventId: "evt_later", at: "2026-05-28T00:00:03.000Z" });
    const earlier = discoveredEvent({ eventId: "evt_earlier", at: "2026-05-28T00:00:01.000Z" });
    const sameTime = seenAgainEvent({ eventId: "evt_middle", at: "2026-05-28T00:00:01.000Z" });
    const invalidSchemaLine = {
      type: "finding.seen_again",
      eventId: "evt_invalid",
      at: "2026-05-28T00:00:02.000Z",
      findingId,
      runId: "run-invalid",
      sourcePath: ".omre/reports/latest.json",
    };
    const safeParseSpy = vi.spyOn(MemoryEventSchema, "safeParse");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    writeJsonl(path.join(paths.segmentsDir, "raw.jsonl"), [later, invalidSchemaLine]);
    fs.appendFileSync(path.join(paths.segmentsDir, "raw.jsonl"), "not valid json\n", "utf8");
    writeJsonl(path.join(paths.compactedDir, "compacted.jsonl"), [sameTime, earlier]);
    fs.writeFileSync(path.join(paths.segmentsDir, "ignored.txt"), `${JSON.stringify(discoveredEvent({ eventId: "evt_ignored" }))}\n`, "utf8");

    const events = readAllEventSegments(paths);

    expect(safeParseSpy).toHaveBeenCalledTimes(4);
    expect(warnSpy).toHaveBeenCalled();
    expect(events.map((event) => event.eventId)).toEqual(["evt_earlier", "evt_middle", "evt_later"]);
  });
});

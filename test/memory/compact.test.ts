import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempRepo, writeSegment, seedManifest, writeFinding } from "./_helpers.js";
import { runMemoryCompact } from "../../src/memory/compact.js";
import type { CompactedSegment, MemoryEvent } from "../../src/memory/schema.js";
import { readMemoryManifest } from "../../src/memory/store.js";
import { sha256File } from "../../src/memory/ids.js";

function makeEvent(overrides: Partial<MemoryEvent & { type: "finding.discovered" }> = {}): MemoryEvent {
  const finding = writeFinding({
    id: `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`,
  });
  return {
    eventId: `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    at: new Date().toISOString(),
    type: "finding.discovered",
    finding,
    ...overrides,
  } as MemoryEvent;
}

function repoRootOf(memoryRoot: string): string {
  return path.resolve(memoryRoot, "..", "..");
}

describe("runMemoryCompact", () => {
  it("merges 3 raw segments into 1 compacted file and updates compactedInputSegments", () => {
    const paths = makeTempRepo();
    seedManifest(paths);

    // Write 3 raw segments with distinct events
    const events1 = [makeEvent({ at: "2026-05-28T01:00:00.000Z" })];
    const events2 = [makeEvent({ at: "2026-05-28T02:00:00.000Z" })];
    const events3 = [makeEvent({ at: "2026-05-28T03:00:00.000Z" })];

    writeSegment(paths, events1, "run-1");
    writeSegment(paths, events2, "run-2");
    writeSegment(paths, events3, "run-3");

    const result = runMemoryCompact({ cwd: repoRootOf(paths.root) });

    expect(result.success).toBe(true);
    expect(result.compactedSegments.length).toBe(1);
    expect(result.compactedSegments[0]!.rawPaths.length).toBe(3);
    expect(result.compactedSegments[0]!.eventCount).toBe(3);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Compacted file exists in compactedDir
    const compactedPath = result.compactedSegments[0]!.compactedPath;
    const compactedAbs = path.join(paths.root, compactedPath);
    expect(fs.existsSync(compactedAbs)).toBe(true);

    // Compacted file contains exactly 3 valid JSON lines
    const content = fs.readFileSync(compactedAbs, "utf8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(3);

    // Lines are sorted by `at`
    const timestamps = lines.map((l) => (JSON.parse(l) as { at: string }).at);
    expect(timestamps).toEqual([...timestamps].sort());

    // Manifest updated with compactedInputSegments
    const manifest = readMemoryManifest(paths)!;
    expect(manifest).not.toBeNull();

    const segments = manifest.compactedInputSegments as CompactedSegment[];
    expect(segments.length).toBe(3);
    for (const seg of segments) {
      expect(seg.rawPath).toBeTruthy();
      expect(seg.rawSha256).toBeTruthy();
      expect(seg.compactedPath).toBe(compactedPath);
      expect(seg.compactedSha256).toBeTruthy();
      expect(seg.compactedAt).toBeTruthy();
    }

    // Verify sha256 of compacted file matches
    expect(segments[0]!.compactedSha256).toBe(sha256File(compactedAbs));

    // Raw segments are NOT deleted (that's gc's job)
    const rawFiles = fs.readdirSync(paths.segmentsDir).filter((f) => f.endsWith(".jsonl"));
    expect(rawFiles.length).toBe(3);
  });

  it("quarantines a corrupt segment and continues compaction", () => {
    const paths = makeTempRepo();
    seedManifest(paths);

    const events1 = [makeEvent({ at: "2026-05-28T01:00:00.000Z" })];
    const events2 = [makeEvent({ at: "2026-05-28T03:00:00.000Z" })];

    writeSegment(paths, events1, "run-1");

    // Write a corrupt segment
    const corruptName = `${Date.now()}-corrupt.jsonl`;
    const corruptPath = path.join(paths.segmentsDir, corruptName);
    fs.writeFileSync(corruptPath, "{not-valid-json\n{also-bad}", { encoding: "utf8", flag: "wx" });

    writeSegment(paths, events2, "run-3");

    const result = runMemoryCompact({ cwd: repoRootOf(paths.root) });

    expect(result.success).toBe(true);
    // Only 2 good events compacted (corrupt was skipped)
    expect(result.compactedSegments[0]!.eventCount).toBe(2);
    // Corrupt segment moved to quarantine
    expect(fs.existsSync(corruptPath)).toBe(false);
    const quarantineFiles = fs.readdirSync(paths.quarantineDir).filter((f) => !f.endsWith(".meta.json"));
    expect(quarantineFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("dry-run writes nothing and returns the plan", () => {
    const paths = makeTempRepo();
    seedManifest(paths);

    const events1 = [makeEvent({ at: "2026-05-28T01:00:00.000Z" })];
    const events2 = [makeEvent({ at: "2026-05-28T02:00:00.000Z" })];

    writeSegment(paths, events1, "run-1");
    writeSegment(paths, events2, "run-2");

    // Snapshot state before
    const manifestBefore = readMemoryManifest(paths);
    const compactedFilesBefore = fs.existsSync(paths.compactedDir)
      ? fs.readdirSync(paths.compactedDir)
      : [];

    const result = runMemoryCompact({ cwd: repoRootOf(paths.root), dryRun: true });

    expect(result.success).toBe(true);
    expect(result.compactedSegments.length).toBe(1);
    expect(result.compactedSegments[0]!.rawPaths.length).toBe(2);
    expect(result.compactedSegments[0]!.eventCount).toBe(2);

    // Nothing was written
    const compactedFilesAfter = fs.readdirSync(paths.compactedDir);
    expect(compactedFilesAfter).toEqual(compactedFilesBefore);

    // Manifest unchanged
    const manifestAfter = readMemoryManifest(paths);
    expect(manifestAfter).toEqual(manifestBefore);
  });

  it("stops gracefully on timeout, keeping completed work without corruption", () => {
    const paths = makeTempRepo();
    seedManifest(paths);

    writeSegment(paths, [makeEvent({ at: "2026-05-28T01:00:00.000Z" })], "run-1");
    writeSegment(paths, [makeEvent({ at: "2026-05-28T02:00:00.000Z" })], "run-2");
    writeSegment(paths, [makeEvent({ at: "2026-05-28T03:00:00.000Z" })], "run-3");

    // Control the clock: start at 1000, allow one segment, then exceed the
    // 3000ms default budget so the loop stops before the next file-read.
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000)
      .mockReturnValue(1000 + 3001);

    let result;
    try {
      result = runMemoryCompact({ cwd: repoRootOf(paths.root) });
    } finally {
      nowSpy.mockRestore();
    }

    expect(result.success).toBe(true);
    expect(result.compactedSegments[0]!.rawPaths.length).toBe(1);
    expect(result.compactedSegments[0]!.eventCount).toBe(1);

    const manifest = readMemoryManifest(paths);
    expect(manifest).not.toBeNull();
    const segments = manifest!.compactedInputSegments as CompactedSegment[];
    expect(segments.length).toBe(1);
    expect(segments[0]!.rawPath).toBeTruthy();
    expect(segments[0]!.compactedPath).toBeTruthy();
    expect(segments[0]!.compactedSha256).toBeTruthy();

    const rawFiles = fs.readdirSync(paths.segmentsDir).filter((f) => f.endsWith(".jsonl"));
    expect(rawFiles.length).toBe(3);
  });
});

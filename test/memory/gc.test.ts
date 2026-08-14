import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempRepo, seedManifest } from "./_helpers.js";
import { runMemoryGc } from "../../src/memory/gc.js";
import type { MemoryPaths } from "../../src/memory/paths.js";
import type { CompactedSegment, QuarantineEntry } from "../../src/memory/schema.js";
import { readMemoryManifest } from "../../src/memory/store.js";

const tempDirs: string[] = [];

function backdate(filePath: string, days: number): void {
  const mtime = new Date(Date.now() - days * 86_400_000);
  fs.utimesSync(filePath, mtime, mtime);
}

function backdateHours(filePath: string, hours: number): void {
  const mtime = new Date(Date.now() - hours * 3_600_000);
  fs.utimesSync(filePath, mtime, mtime);
}

function writeTmpFile(paths: MemoryPaths, name: string): string {
  const filePath = path.join(paths.tmpDir, name);
  fs.writeFileSync(filePath, "tmp content", "utf8");
  return filePath;
}

function writeRawSegment(paths: MemoryPaths, name: string, content = "{}\n"): string {
  const filePath = path.join(paths.segmentsDir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function writeQuarantineFile(paths: MemoryPaths, name: string): { filePath: string; metaPath: string } {
  const filePath = path.join(paths.quarantineDir, name);
  const metaPath = `${filePath}.meta.json`;
  fs.writeFileSync(filePath, "quarantined content", "utf8");
  fs.writeFileSync(metaPath, JSON.stringify({ reason: "parse-error" }), "utf8");
  return { filePath, metaPath };
}

/**
 * Returns the repo root (parent of .omre/memory) from MemoryPaths.
 * makeTempRepo creates paths rooted at `tmpDir/.omre/memory`,
 * so repoRoot is two levels up from paths.root.
 */
function repoRootFromPaths(paths: MemoryPaths): string {
  return path.resolve(paths.root, "..", "..");
}

function writeConfig(repoRoot: string, memory: Record<string, unknown>): void {
  const configDir = path.join(repoRoot, ".omre");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ memory }, null, 2), "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runMemoryGc", () => {
  describe("Rule 1: tmp-expired", () => {
    it("deletes tmp files older than tmpFileMaxAgeHours", () => {
      const paths = makeTempRepo();
      const repoRoot = repoRootFromPaths(paths);
      tempDirs.push(repoRoot);

      seedManifest(paths);

      const oldTmp = writeTmpFile(paths, "old.tmp");
      backdateHours(oldTmp, 25); // default threshold is 24h

      const freshTmp = writeTmpFile(paths, "fresh.tmp");

      const result = runMemoryGc({ cwd: repoRoot });

      expect(result.success).toBe(true);
      expect(result.deleted.tmpFiles).toBe(1);
      expect(fs.existsSync(oldTmp)).toBe(false);
      expect(fs.existsSync(freshTmp)).toBe(true);
    });

    // slop-fix: fails until B5 fix lands
    it("reports only successfully deleted tmp files when unlink fails", () => {
      const paths = makeTempRepo();
      const repoRoot = repoRootFromPaths(paths);
      tempDirs.push(repoRoot);
      seedManifest(paths);

      const oldTmp = writeTmpFile(paths, "undeletable.tmp");
      backdateHours(oldTmp, 25);
      const originalUnlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((filePath) => {
        if (filePath === oldTmp) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return originalUnlink(filePath);
      });

      try {
        const result = runMemoryGc({ cwd: repoRoot });
        expect(result.deleted.tmpFiles).toBe(0);
        expect(fs.existsSync(oldTmp)).toBe(true);
      } finally {
        unlinkSpy.mockRestore();
      }
    });
  });

  describe("Rule 2: empty-segment", () => {
    it("deletes empty raw segments", () => {
      const paths = makeTempRepo();
      const repoRoot = repoRootFromPaths(paths);
      tempDirs.push(repoRoot);

      seedManifest(paths);

      const emptySegment = writeRawSegment(paths, "empty.jsonl", "");
      const nonEmptySegment = writeRawSegment(paths, "non-empty.jsonl", "{}\n");

      const result = runMemoryGc({ cwd: repoRoot });

      expect(result.success).toBe(true);
      expect(result.deleted.emptySegments).toBe(1);
      expect(fs.existsSync(emptySegment)).toBe(false);
      expect(fs.existsSync(nonEmptySegment)).toBe(true);
    });
  });

  describe("Rule 3: compacted-raw-expired", () => {
    it("deletes raw segments referenced in compactedInputSegments AND older than rawSegmentKeepDays", () => {
      const paths = makeTempRepo();
      const repoRoot = repoRootFromPaths(paths);
      tempDirs.push(repoRoot);

      const rawSeg = writeRawSegment(paths, "compacted-raw.jsonl", "{}\n");
      backdate(rawSeg, 35); // default rawSegmentKeepDays=30

      const rawRelPath = path.relative(paths.root, rawSeg);

      const compactedSegments: CompactedSegment[] = [
        {
          rawPath: rawRelPath,
          rawSha256: "abcd1234abcd1234",
          compactedPath: "events/compacted/out.jsonl",
          compactedSha256: "efgh5678efgh5678",
          compactedAt: "2026-05-01T00:00:00.000Z",
        },
      ];

      seedManifest(paths, { compactedInputSegments: compactedSegments });

      const result = runMemoryGc({ cwd: repoRoot });

      expect(result.success).toBe(true);
      expect(result.deleted.compactedRawSegments).toBe(1);
      expect(fs.existsSync(rawSeg)).toBe(false);
    });

    it("does NOT delete a compacted raw segment that is not yet expired", () => {
      const paths = makeTempRepo();
      const repoRoot = repoRootFromPaths(paths);
      tempDirs.push(repoRoot);

      const rawSeg = writeRawSegment(paths, "compacted-fresh.jsonl", "{}\n");
      backdate(rawSeg, 5); // younger than rawSegmentKeepDays=30

      const compactedSegments: CompactedSegment[] = [
        {
          rawPath: path.relative(paths.root, rawSeg),
          rawSha256: "abcd1234abcd1234",
          compactedPath: "events/compacted/out.jsonl",
          compactedSha256: "efgh5678efgh5678",
          compactedAt: "2026-06-10T00:00:00.000Z",
        },
      ];

      seedManifest(paths, { compactedInputSegments: compactedSegments });

      const result = runMemoryGc({ cwd: repoRoot });

      expect(result.deleted.compactedRawSegments).toBe(0);
      expect(fs.existsSync(rawSeg)).toBe(true);
    });

    it("refuses to delete when compactedInputSegments is legacy string[]", () => {
      const paths = makeTempRepo();
      const repoRoot = repoRootFromPaths(paths);
      tempDirs.push(repoRoot);

      const rawSeg = writeRawSegment(paths, "legacy-raw.jsonl", "{}\n");
      backdate(rawSeg, 35);

      seedManifest(paths, { compactedInputSegments: ["events/segments/legacy-raw.jsonl"] });

      const result = runMemoryGc({ cwd: repoRoot });

      // Should NOT delete — legacy format safety
      expect(result.success).toBe(true);
      expect(result.deleted.compactedRawSegments).toBe(0);
      expect(fs.existsSync(rawSeg)).toBe(true);
    });
  });

  describe("Rule 4: raw-segment-overflow", () => {
    it("keeps only the most recent maxRawSegments, deleting oldest first", () => {
      const paths = makeTempRepo();
      const repoRoot = repoRootFromPaths(paths);
      tempDirs.push(repoRoot);

      writeConfig(repoRoot, { retention: { maxRawSegments: 3 } });

      seedManifest(paths);

      const segments: string[] = [];
      for (let i = 0; i < 5; i++) {
        const seg = writeRawSegment(paths, `seg-${i}.jsonl`, `{"i":${i}}\n`);
        backdateHours(seg, (5 - i) * 24);
        segments.push(seg);
      }

      // segments[0] is oldest (5 days), segments[4] is newest (1 day)
      const result = runMemoryGc({ cwd: repoRoot });

      expect(result.success).toBe(true);
      expect(result.deleted.overflowRawSegments).toBe(2);
      expect(fs.existsSync(segments[0]!)).toBe(false);
      expect(fs.existsSync(segments[1]!)).toBe(false);
      expect(fs.existsSync(segments[2]!)).toBe(true);
      expect(fs.existsSync(segments[3]!)).toBe(true);
      expect(fs.existsSync(segments[4]!)).toBe(true);
    });
  });

  describe("quarantine cleanup", () => {
    it("deletes quarantine files older than olderThanDays", () => {
      const paths = makeTempRepo();
      const repoRoot = repoRootFromPaths(paths);
      tempDirs.push(repoRoot);

      const { filePath: oldQ, metaPath: oldMeta } = writeQuarantineFile(paths, "old-q.jsonl");
      backdate(oldQ, 10);
      backdate(oldMeta, 10);

      const { filePath: freshQ, metaPath: freshMeta } = writeQuarantineFile(paths, "fresh-q.jsonl");

      const quarantine: QuarantineEntry[] = [
        {
          path: path.relative(paths.root, oldQ),
          metaPath: path.relative(paths.root, oldMeta),
          reason: "parse-error",
          movedAt: "2026-05-01T00:00:00.000Z",
        },
        {
          path: path.relative(paths.root, freshQ),
          metaPath: path.relative(paths.root, freshMeta),
          reason: "parse-error",
          movedAt: new Date().toISOString(),
        },
      ];

      seedManifest(paths, { quarantine });

      const result = runMemoryGc({ cwd: repoRoot, quarantine: { olderThanDays: 7 } });

      expect(result.success).toBe(true);
      expect(result.deleted.quarantineFiles).toBe(1);
      expect(fs.existsSync(oldQ)).toBe(false);
      expect(fs.existsSync(oldMeta)).toBe(false);
      expect(fs.existsSync(freshQ)).toBe(true);
      expect(fs.existsSync(freshMeta)).toBe(true);
    });
  });

  describe("dryRun", () => {
    it("computes the deletion plan without deleting anything", () => {
      const paths = makeTempRepo();
      const repoRoot = repoRootFromPaths(paths);
      tempDirs.push(repoRoot);

      seedManifest(paths);

      const oldTmp = writeTmpFile(paths, "old.tmp");
      backdateHours(oldTmp, 25);

      const emptySegment = writeRawSegment(paths, "empty.jsonl", "");

      const result = runMemoryGc({ cwd: repoRoot, dryRun: true });

      expect(result.success).toBe(true);
      expect(result.deleted.tmpFiles).toBe(1);
      expect(result.deleted.emptySegments).toBe(1);
      // Files should still exist
      expect(fs.existsSync(oldTmp)).toBe(true);
      expect(fs.existsSync(emptySegment)).toBe(true);
      // No gc log written in dry-run
      expect(result.gcLogPath).toBeUndefined();
    });
  });

  describe("path-prefix guard", () => {
    it("never deletes outside .omre/memory/", () => {
      const paths = makeTempRepo();
      const repoRoot = repoRootFromPaths(paths);
      tempDirs.push(repoRoot);

      seedManifest(paths);

      // Write a file outside the memory root
      const outsideFile = path.join(repoRoot, "outside.txt");
      fs.writeFileSync(outsideFile, "outside content", "utf8");

      // Create a symlink inside tmpDir pointing outside, backdated to look expired
      const symlinkPath = path.join(paths.tmpDir, "malicious-link");
      try {
        fs.symlinkSync(outsideFile, symlinkPath);
        backdateHours(symlinkPath, 25);
      } catch {
        // If symlink creation fails (permissions), nothing to assert
        return;
      }

      const result = runMemoryGc({ cwd: repoRoot });

      // The outside file must survive
      expect(fs.existsSync(outsideFile)).toBe(true);
      expect(result.success).toBe(true);
    });
  });

  describe("manifest updates", () => {
    it("updates gcSummary and cleans stale compactedInputSegments after gc", () => {
      const paths = makeTempRepo();
      const repoRoot = repoRootFromPaths(paths);
      tempDirs.push(repoRoot);

      // Compacted segment whose rawPath no longer exists on disk
      const compactedSegments: CompactedSegment[] = [
        {
          rawPath: "events/segments/already-gone.jsonl",
          rawSha256: "abcd1234abcd1234",
          compactedPath: "events/compacted/out.jsonl",
          compactedSha256: "efgh5678efgh5678",
          compactedAt: "2026-05-01T00:00:00.000Z",
        },
      ];

      seedManifest(paths, { compactedInputSegments: compactedSegments });

      const oldTmp = writeTmpFile(paths, "old.tmp");
      backdateHours(oldTmp, 25);

      runMemoryGc({ cwd: repoRoot });

      const manifest = readMemoryManifest(paths);
      expect(manifest).not.toBeNull();
      expect(manifest!.gcSummary.lastGcAt).toBeDefined();
      expect(manifest!.gcSummary.deletedTmpFiles).toBeGreaterThanOrEqual(1);
      // The stale compactedInputSegments entry should be cleaned
      expect(manifest!.compactedInputSegments).toHaveLength(0);
    });

    it("writes a gc log file", () => {
      const paths = makeTempRepo();
      const repoRoot = repoRootFromPaths(paths);
      tempDirs.push(repoRoot);

      seedManifest(paths);

      const oldTmp = writeTmpFile(paths, "old.tmp");
      backdateHours(oldTmp, 25);

      const result = runMemoryGc({ cwd: repoRoot });

      expect(result.gcLogPath).toBeDefined();
      expect(fs.existsSync(result.gcLogPath!)).toBe(true);

      const logContent = fs.readFileSync(result.gcLogPath!, "utf8");
      const logEntry = JSON.parse(logContent.trim().split("\n")[0]!);
      expect(logEntry.type).toBe("gc");
      expect(logEntry.at).toBeDefined();
    });
  });
});

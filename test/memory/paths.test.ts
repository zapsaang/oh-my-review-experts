import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveMemoryPaths, ensureMemoryDirs } from "../../src/memory/paths.js";

describe("resolveMemoryPaths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-memory-paths-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns correct absolute paths for all entries with default memoryDir", () => {
    const paths = resolveMemoryPaths(tmpDir);
    const memoryRoot = path.join(tmpDir, ".omre", "memory");

    expect(paths.root).toBe(memoryRoot);
    expect(paths.versionFile).toBe(path.join(memoryRoot, "version"));
    expect(paths.eventsDir).toBe(path.join(memoryRoot, "events"));
    expect(paths.segmentsDir).toBe(path.join(memoryRoot, "events", "segments"));
    expect(paths.compactedDir).toBe(path.join(memoryRoot, "events", "compacted"));
    expect(paths.quarantineDir).toBe(path.join(memoryRoot, "events", "quarantine"));
    expect(paths.gcDir).toBe(path.join(memoryRoot, "gc"));
    expect(paths.materializedDir).toBe(path.join(memoryRoot, "materialized"));
    expect(paths.memoryFile).toBe(path.join(memoryRoot, "materialized", "memory.jsonl"));
    expect(paths.relatedIndexFile).toBe(path.join(memoryRoot, "materialized", "related-index.json"));
    expect(paths.manifestFile).toBe(path.join(memoryRoot, "materialized", "manifest.json"));
    expect(paths.tmpDir).toBe(path.join(memoryRoot, "tmp"));
    expect(paths.locksDir).toBe(path.join(memoryRoot, "locks"));
    expect(paths.lockFile).toBe(path.join(memoryRoot, "locks", "memory.lock"));
  });

  it("returns correct absolute paths with custom memoryDir", () => {
    const paths = resolveMemoryPaths(tmpDir, "custom-memory");
    const memoryRoot = path.join(tmpDir, "custom-memory");

    expect(paths.root).toBe(memoryRoot);
    expect(paths.segmentsDir).toBe(path.join(memoryRoot, "events", "segments"));
    expect(paths.lockFile).toBe(path.join(memoryRoot, "locks", "memory.lock"));
  });

  it("rejects path traversal via assertSafePath", () => {
    expect(() => resolveMemoryPaths(tmpDir, "../escape")).toThrow("Path traversal blocked");
  });

  it("rejects deep path traversal", () => {
    expect(() => resolveMemoryPaths(tmpDir, "foo/../../escape")).toThrow("Path traversal blocked");
  });
});

describe("ensureMemoryDirs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-ensure-dirs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates all 7 required directories", () => {
    const paths = resolveMemoryPaths(tmpDir);
    ensureMemoryDirs(paths);

    expect(fs.existsSync(paths.segmentsDir)).toBe(true);
    expect(fs.existsSync(paths.compactedDir)).toBe(true);
    expect(fs.existsSync(paths.quarantineDir)).toBe(true);
    expect(fs.existsSync(paths.gcDir)).toBe(true);
    expect(fs.existsSync(paths.materializedDir)).toBe(true);
    expect(fs.existsSync(paths.tmpDir)).toBe(true);
    expect(fs.existsSync(paths.locksDir)).toBe(true);
  });

  it("is idempotent — calling twice does not throw", () => {
    const paths = resolveMemoryPaths(tmpDir);
    ensureMemoryDirs(paths);
    ensureMemoryDirs(paths);

    expect(fs.existsSync(paths.segmentsDir)).toBe(true);
    expect(fs.existsSync(paths.materializedDir)).toBe(true);
  });
});

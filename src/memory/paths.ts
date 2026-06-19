import fs from "node:fs";
import path from "node:path";
import { assertSafePath } from "../tools/fs-utils.js";

export interface MemoryPaths {
  root: string;
  versionFile: string;
  eventsDir: string;
  segmentsDir: string;
  compactedDir: string;
  quarantineDir: string;
  gcDir: string;
  materializedDir: string;
  memoryFile: string;
  relatedIndexFile: string;
  manifestFile: string;
  tmpDir: string;
  /** Directory for repo-level memory write locks. */
  locksDir: string;
  /** Lock directory for concurrent write protection (mkdir-based advisory lock). */
  lockFile: string;
}

export function resolveMemoryPaths(repoRoot: string, memoryDir = ".omre/memory"): MemoryPaths {
  const root = path.resolve(repoRoot, memoryDir);
  assertSafePath(root, repoRoot, "memory.directory");

  return {
    root,
    versionFile: path.join(root, "version"),
    eventsDir: path.join(root, "events"),
    segmentsDir: path.join(root, "events", "segments"),
    compactedDir: path.join(root, "events", "compacted"),
    quarantineDir: path.join(root, "events", "quarantine"),
    gcDir: path.join(root, "gc"),
    materializedDir: path.join(root, "materialized"),
    memoryFile: path.join(root, "materialized", "memory.jsonl"),
    relatedIndexFile: path.join(root, "materialized", "related-index.json"),
    manifestFile: path.join(root, "materialized", "manifest.json"),
    tmpDir: path.join(root, "tmp"),
    locksDir: path.join(root, "locks"),
    lockFile: path.join(root, "locks", "memory.lock"),
  };
}

export function ensureMemoryDirs(paths: MemoryPaths): void {
  fs.mkdirSync(paths.segmentsDir, { recursive: true });
  fs.mkdirSync(paths.compactedDir, { recursive: true });
  fs.mkdirSync(paths.quarantineDir, { recursive: true });
  fs.mkdirSync(paths.gcDir, { recursive: true });
  fs.mkdirSync(paths.materializedDir, { recursive: true });
  fs.mkdirSync(paths.tmpDir, { recursive: true });
  // locksDir is created here for future Claim 2 implementation
  fs.mkdirSync(paths.locksDir, { recursive: true });
}

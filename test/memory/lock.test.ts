import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  acquireMemoryLock,
  releaseMemoryLock,
  withMemoryLock,
  type LockOwnerInfo,
} from "../../src/memory/lock.js";
import { resolveMemoryPaths, ensureMemoryDirs, type MemoryPaths } from "../../src/memory/paths.js";
import { readMaterializedState } from "../../src/memory/store.js";
import { writeFileAtomicOverwrite } from "../../src/tools/fs-utils.js";
import type { MemoryFinding, MemoryManifest } from "../../src/memory/schema.js";

describe("memory lock", () => {
  let tmpDir: string;
  let paths: MemoryPaths;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-lock-test-"));
    paths = resolveMemoryPaths(tmpDir);
    ensureMemoryDirs(paths);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readOwner(lockDir: string): LockOwnerInfo {
    const raw = fs.readFileSync(path.join(lockDir, "owner.json"), "utf8");
    return JSON.parse(raw) as LockOwnerInfo;
  }

  function makeFinding(id: string): MemoryFinding {
    return {
      schemaVersion: 1,
      id,
      fingerprint: "fp1234567890abcdef",
      repo: { rootHash: "repo1234567890abcd", packagePath: "packages/core" },
      origin: {
        runId: "run-20260528",
        sourceType: "report",
        sourcePath: ".omre/reports/latest.json",
        createdAt: "2026-05-28T00:00:00.000Z",
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
        firstSeenAt: "2026-05-28T00:00:00.000Z",
        lastSeenAt: "2026-05-28T00:00:00.000Z",
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
  }

  function computeHash(findings: MemoryFinding[]): string {
    const content = findings.map((finding) => finding.id).join("\n");
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  function makeManifest(overrides: Partial<MemoryManifest> = {}): MemoryManifest {
    const manifest = {
      schemaVersion: 1,
      eventSchemaVersion: 1,
      viewSchemaVersion: 1,
      lastRebuiltAt: "2026-05-28T00:00:00.000Z",
      materializedHash: "mat1234567890abcdef",
      relatedIndexHash: "rel1234567890abcdef",
      includedEventFiles: [],
      compactedInputSegments: [],
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

  // #1
  it("acquireMemoryLock creates lockDir + owner.json with pid/hostname/acquiredAt", () => {
    const handle = acquireMemoryLock(paths);

    expect(fs.existsSync(handle.lockDir)).toBe(true);
    expect(handle.lockDir).toBe(paths.lockFile);

    const owner = readOwner(handle.lockDir);
    expect(owner.pid).toBe(process.pid);
    expect(typeof owner.hostname).toBe("string");
    expect(owner.hostname.length).toBeGreaterThan(0);
    expect(owner.acquiredAt).toBe(handle.acquiredAt);
    expect(Number.isNaN(new Date(owner.acquiredAt).getTime())).toBe(false);
  });

  // #2
  it("acquireMemoryLock times out while lock is held", () => {
    const held = acquireMemoryLock(paths);
    try {
      expect(() =>
        acquireMemoryLock(paths, { timeoutMs: 200, staleMs: 60_000, pollMs: 20 }),
      ).toThrow(/memory lock timeout/);
    } finally {
      releaseMemoryLock(held);
    }
  });

  // #3
  it("recovers a stale lock and re-acquires", () => {
    // Manually create a stale lock with an old acquiredAt.
    fs.mkdirSync(paths.lockFile);
    const oldAcquiredAt = new Date(Date.now() - 120_000).toISOString();
    const staleOwner: LockOwnerInfo = {
      pid: 999_999,
      hostname: "ghost-host",
      acquiredAt: oldAcquiredAt,
    };
    fs.writeFileSync(path.join(paths.lockFile, "owner.json"), JSON.stringify(staleOwner), "utf8");

    const handle = acquireMemoryLock(paths, { timeoutMs: 1_000, staleMs: 60_000, pollMs: 20 });

    expect(fs.existsSync(handle.lockDir)).toBe(true);
    const owner = readOwner(handle.lockDir);
    // The stale owner has been replaced by us.
    expect(owner.pid).toBe(process.pid);
    expect(owner.acquiredAt).not.toBe(oldAcquiredAt);
    // The renamed stale dir was cleaned up.
    expect(fs.existsSync(`${paths.lockFile}.stale.${process.pid}`)).toBe(false);
  });

  // #4
  it("retries after a failed steal (rename double-steal prevention)", () => {
    // Pre-create a stale lock.
    fs.mkdirSync(paths.lockFile);
    const staleOwner: LockOwnerInfo = {
      pid: 999_999,
      hostname: "ghost-host",
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    };
    fs.writeFileSync(path.join(paths.lockFile, "owner.json"), JSON.stringify(staleOwner), "utf8");

    const realRename = fs.renameSync.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      calls += 1;
      if (calls === 1) {
        // Simulate another process winning the steal race.
        const err = new Error("ENOENT: lost the steal race") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return realRename(from, to);
    });

    const handle = acquireMemoryLock(paths, { timeoutMs: 2_000, staleMs: 60_000, pollMs: 20 });

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(handle.lockDir)).toBe(true);
    expect(readOwner(handle.lockDir).pid).toBe(process.pid);
  });

  // #5
  it("releaseMemoryLock deletes lockDir", () => {
    const handle = acquireMemoryLock(paths);
    expect(fs.existsSync(handle.lockDir)).toBe(true);

    releaseMemoryLock(handle);
    expect(fs.existsSync(handle.lockDir)).toBe(false);
  });

  // #6
  it("releaseMemoryLock is idempotent", () => {
    const handle = acquireMemoryLock(paths);
    releaseMemoryLock(handle);
    expect(() => releaseMemoryLock(handle)).not.toThrow();
    expect(fs.existsSync(handle.lockDir)).toBe(false);
  });

  // #7
  it("withMemoryLock returns fn value and cleans up the lock", () => {
    const result = withMemoryLock(paths, () => {
      expect(fs.existsSync(paths.lockFile)).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  });

  // #8
  it("withMemoryLock releases the lock when fn throws", () => {
    expect(() =>
      withMemoryLock(paths, () => {
        throw new Error("boom");
      }),
    ).toThrow(/boom/);

    expect(fs.existsSync(paths.lockFile)).toBe(false);
  });

  // #9
  it("calls assertSafePath and rejects a path-traversal lockFile", () => {
    const evilPaths: MemoryPaths = {
      ...paths,
      lockFile: path.join(tmpDir, "outside", "memory.lock"),
    };

    expect(() => acquireMemoryLock(evilPaths)).toThrow(/Path traversal blocked/);
  });

  // #10 (FIX-1)
  it("auto-creates the parent locks/ dir when it is missing", () => {
    fs.rmSync(paths.locksDir, { recursive: true, force: true });
    expect(fs.existsSync(paths.locksDir)).toBe(false);

    const handle = acquireMemoryLock(paths);

    expect(fs.existsSync(handle.lockDir)).toBe(true);
    expect(fs.existsSync(paths.locksDir)).toBe(true);
  });

  // #11
  it("readMaterializedState retries once on hash mismatch then succeeds", () => {
    const finding = makeFinding("mem_hashretryokay0001");
    const correctHash = computeHash([finding]);

    fs.writeFileSync(paths.memoryFile, JSON.stringify(finding) + "\n", "utf8");
    const manifest = makeManifest({ materializedHash: correctHash });
    fs.writeFileSync(paths.manifestFile, JSON.stringify(manifest), "utf8");

    const realReadFileSync = fs.readFileSync.bind(fs);
    let memoryReadCount = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((p, opts) => {
      if (p.toString() === paths.memoryFile) {
        memoryReadCount++;
        if (memoryReadCount === 1) {
          const wrongFinding = makeFinding("mem_hashwrongdata0001");
          return JSON.stringify(wrongFinding) + "\n";
        }
      }
      return realReadFileSync(p, opts as BufferEncoding);
    });

    const waitSpy = vi.spyOn(Atomics, "wait");

    const result = readMaterializedState(paths);

    expect(result).not.toBeNull();
    expect(result!.findings[0]!.id).toBe(finding.id);
    expect(memoryReadCount).toBe(2);
    // Verify the retry backoff actually fired exactly once with READ_RETRY_DELAY_MS=25
    expect(waitSpy).toHaveBeenCalledTimes(1);
    expect(waitSpy.mock.calls[0]![3]).toBe(25);
  });

  // #12
  it("readMaterializedState returns null after retry still inconsistent", () => {
    const finding = makeFinding("mem_hashnevermatch01");
    fs.writeFileSync(paths.memoryFile, JSON.stringify(finding) + "\n", "utf8");
    const manifest = makeManifest({ materializedHash: "0000000000000000" });
    fs.writeFileSync(paths.manifestFile, JSON.stringify(manifest), "utf8");

    const result = readMaterializedState(paths);

    expect(result).toBeNull();
  });

  // #13
  it("writeFileAtomicOverwrite with fsync=true calls fsyncSync twice (file + dir)", () => {
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    const targetFile = path.join(tmpDir, "fsync-test.txt");

    writeFileAtomicOverwrite(targetFile, "hello fsync", { fsync: true });

    expect(fs.readFileSync(targetFile, "utf8")).toBe("hello fsync");
    expect(fsyncSpy).toHaveBeenCalledTimes(2);
  });

  // #14
  it("writeFileAtomicOverwrite without options does not call fsyncSync", () => {
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    const targetFile = path.join(tmpDir, "no-fsync-test.txt");

    writeFileAtomicOverwrite(targetFile, "no fsync");

    expect(fs.readFileSync(targetFile, "utf8")).toBe("no fsync");
    expect(fsyncSpy).not.toHaveBeenCalled();
  });

  // #15 (FIX-2)
  it("acquires lock when owner.json is missing but mtime is stale", () => {
    fs.mkdirSync(paths.lockFile);
    const oldTime = new Date(Date.now() - 120_000);
    fs.utimesSync(paths.lockFile, oldTime, oldTime);

    const handle = acquireMemoryLock(paths, { timeoutMs: 2_000, staleMs: 60_000, pollMs: 20 });

    expect(fs.existsSync(handle.lockDir)).toBe(true);
    const owner = readOwner(handle.lockDir);
    expect(owner.pid).toBe(process.pid);
  });
});

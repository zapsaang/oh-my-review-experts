import fs from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { assertSafePath } from "../tools/fs-utils.js";
import type { MemoryPaths } from "./paths.js";

export interface LockHandle {
  lockDir: string;
  acquiredAt: string;
}

export interface AcquireLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}

export interface LockOwnerInfo {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 50;

/**
 * Acquire the repo-level memory write lock. Blocks until acquired or timeout.
 * Throws when timeoutMs elapses without acquiring.
 */
export function acquireMemoryLock(
  paths: MemoryPaths,
  opts?: AcquireLockOptions,
): LockHandle {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;

  const lockDir = paths.lockFile; // .omre/memory/locks/memory.lock
  assertSafePath(lockDir, paths.root, "memory.lock");

  // FIX-1: the lock module is self-sufficient — gc.ts / compact.ts do not call
  // ensureMemoryDirs, so the parent locks/ dir may not exist. A non-recursive
  // fs.mkdirSync(lockDir) would then throw ENOENT. Pre-create the parent dir
  // (recursive, idempotent) instead of relying on the caller.
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      fs.mkdirSync(lockDir); // atomic acquire (non-recursive — EEXIST if held)
      break;
    } catch (err: unknown) {
      if (!isEexist(err)) throw err;

      // lockDir exists — check whether it is stale.
      // FIX-2: owner.json may be missing (holder crashed between mkdir and
      // writeFileSync(owner.json)). Fall back to lockDir mtime so stale
      // detection still fires instead of waiting out the full timeoutMs.
      const owner = readOwnerSafe(lockDir);
      const stale =
        owner !== null
          ? isStale(owner, staleMs)
          : isStaleByMtime(lockDir, staleMs);
      if (stale) {
        // Attempt an atomic steal.
        const staleDest = `${lockDir}.stale.${process.pid}`;
        try {
          fs.renameSync(lockDir, staleDest);
          // rename succeeded = we won, clean up the stolen dir.
          fs.rmSync(staleDest, { recursive: true, force: true });
          continue; // back to mkdir
        } catch {
          // rename failed = someone else stole first, back to polling.
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `memory lock timeout: could not acquire ${lockDir} within ${timeoutMs}ms` +
          (owner ? ` (held by pid=${owner.pid} since ${owner.acquiredAt})` : ""),
        );
      }
      sleepSync(jitteredPollMs(pollMs));
    }
  }

  // Acquired — write owner metadata.
  const acquiredAt = new Date().toISOString();
  const ownerInfo: LockOwnerInfo = {
    pid: process.pid,
    hostname: hostname(),
    acquiredAt,
  };
  const ownerPath = path.join(lockDir, "owner.json");
  fs.writeFileSync(ownerPath, JSON.stringify(ownerInfo), "utf8");

  return { lockDir, acquiredAt };
}

/**
 * Release the lock. Idempotent — does not throw if the lock dir is gone.
 */
export function releaseMemoryLock(handle: LockHandle): void {
  fs.rmSync(handle.lockDir, { recursive: true, force: true });
}

/**
 * Acquire → run fn → release. Releases even when fn throws (try/finally).
 */
export function withMemoryLock<T>(
  paths: MemoryPaths,
  fn: () => T,
  opts?: AcquireLockOptions,
): T {
  const handle = acquireMemoryLock(paths, opts);
  try {
    return fn();
  } finally {
    releaseMemoryLock(handle);
  }
}

function isEexist(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function readOwnerSafe(lockDir: string): LockOwnerInfo | null {
  try {
    const raw = fs.readFileSync(path.join(lockDir, "owner.json"), "utf8");
    return JSON.parse(raw) as LockOwnerInfo;
  } catch {
    return null;
  }
}

function isStale(owner: LockOwnerInfo, staleMs: number): boolean {
  const elapsed = Date.now() - new Date(owner.acquiredAt).getTime();
  return elapsed > staleMs;
}

function isStaleByMtime(lockDir: string, staleMs: number): boolean {
  try {
    const elapsed = Date.now() - fs.statSync(lockDir).mtimeMs;
    return elapsed > staleMs;
  } catch {
    // lockDir was just cleaned up by another process — treat as not stale,
    // fall back to polling / retrying mkdir.
    return false;
  }
}

function sleepSync(ms: number): void {
  // Truly block the current thread without burning CPU. Atomics.wait on a
  // SharedArrayBuffer that nobody notifies returns on timeout — equivalent to
  // a synchronous sleep.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function jitteredPollMs(base: number): number {
  // ±20% random jitter to avoid thundering herd in N-worker concurrency tests.
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

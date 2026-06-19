import fs from "node:fs";
import path from "node:path";
import { loadConfigUnsafe } from "../config/load-config.js";
import { withMemoryLock } from "./lock.js";
import { resolveMemoryPaths, type MemoryPaths } from "./paths.js";
import { readMaterializedState, writeMaterializedState } from "./store.js";
import { writeFileAtomicOverwrite, formatTimestamp } from "../tools/fs-utils.js";
import type { CompactedSegment, MemoryManifest, QuarantineEntry } from "./schema.js";

export interface GcOptions {
  cwd?: string;
  dryRun?: boolean;
  quarantine?: {
    olderThanDays?: number;
  };
}

export interface GcResult {
  success: boolean;
  deleted: {
    tmpFiles: number;
    emptySegments: number;
    compactedRawSegments: number;
    overflowRawSegments: number;
    quarantineFiles: number;
  };
  gcLogPath?: string;
}

interface DeletionPlan {
  tmpFiles: string[];
  emptySegments: string[];
  compactedRawSegments: string[];
  overflowRawSegments: string[];
  quarantineFiles: string[];
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Run garbage collection over the on-disk memory store.
 *
 * SAFETY (C5): This routine reads the manifest ONCE at the start (a snapshot)
 * and writes it LAST. It must NOT run concurrently with compaction — both
 * mutate the manifest and the segment directories, and there is no lock yet.
 *
 * Every candidate path is checked against a strict path-prefix guard so that
 * nothing outside `.omre/memory/` (paths.root) can ever be deleted.
 */
export function runMemoryGc(options: GcOptions): GcResult {
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun === true;

  const config = loadConfigUnsafe(cwd);
  const paths = resolveMemoryPaths(cwd, config.memory.directory);
  const retention = config.memory.retention;

  return withMemoryLock(paths, () => {
    // Snapshot the manifest ONCE (C5). May be null if memory was never built.
    const state = readMaterializedState(paths);
    const manifest = state?.manifest ?? null;

    const now = Date.now();
    const plan: DeletionPlan = {
      tmpFiles: [],
      emptySegments: [],
      compactedRawSegments: [],
      overflowRawSegments: [],
      quarantineFiles: [],
    };

    // Track every raw segment that is already accounted for by an earlier rule
    // so each file is evaluated ONCE (first match wins).
    const claimedSegments = new Set<string>();

    // --- Rule 1: tmp-expired ---
    const tmpMaxAgeMs = retention.tmpFileMaxAgeHours * MS_PER_HOUR;
    for (const filePath of listFiles(paths.tmpDir)) {
      if (!isWithinRoot(filePath, paths)) continue;
      const mtimeMs = safeMtimeMs(filePath);
      if (mtimeMs === null) continue;
      if (now - mtimeMs > tmpMaxAgeMs) {
        plan.tmpFiles.push(filePath);
      }
    }

    // --- Rule 2: empty-segment ---
    for (const filePath of listFiles(paths.segmentsDir)) {
      if (!isWithinRoot(filePath, paths)) continue;
      if (claimedSegments.has(filePath)) continue;
      const size = safeSize(filePath);
      if (size === 0) {
        plan.emptySegments.push(filePath);
        claimedSegments.add(filePath);
      }
    }

    // --- Rule 3: compacted-raw-expired ---
    // Raw segment referenced in manifest.compactedInputSegments AND older than
    // retention.rawSegmentKeepDays. If compactedInputSegments is legacy string[],
    // REFUSE this rule for safety and emit a warning.
    const rawKeepMs = retention.rawSegmentKeepDays * MS_PER_DAY;
    if (manifest !== null) {
      const segments = manifest.compactedInputSegments;
      if (isLegacyStringArray(segments)) {
        // eslint-disable-next-line no-console
        console.warn(
          "memory gc: compactedInputSegments is a legacy string[]; refusing compacted-raw-expired deletions for safety",
        );
      } else {
        for (const entry of segments as CompactedSegment[]) {
          const rawAbs = path.resolve(paths.root, entry.rawPath);
          if (!isWithinRoot(rawAbs, paths)) continue;
          if (claimedSegments.has(rawAbs)) continue;
          if (!fs.existsSync(rawAbs)) continue;
          const mtimeMs = safeMtimeMs(rawAbs);
          if (mtimeMs === null) continue;
          if (now - mtimeMs > rawKeepMs) {
            plan.compactedRawSegments.push(rawAbs);
            claimedSegments.add(rawAbs);
          }
        }
      }
    }

    // --- Rule 4: raw-segment-overflow ---
    // Keep the most recent `maxRawSegments`; delete the rest, oldest first.
    // Compute the overflow set ONCE (C2).
    const maxRawSegments = retention.maxRawSegments;
    const rawByMtime = listRawSegmentsSortedByMtime(paths); // newest first
    const overflow = rawByMtime.slice(maxRawSegments);
    for (const filePath of overflow) {
      if (!isWithinRoot(filePath, paths)) continue;
      if (claimedSegments.has(filePath)) continue;
      plan.overflowRawSegments.push(filePath);
      claimedSegments.add(filePath);
    }

    // --- Quarantine cleanup ---
    const quarantineOlderThanDays = options.quarantine?.olderThanDays;
    if (quarantineOlderThanDays !== undefined) {
      const quarantineMaxAgeMs = quarantineOlderThanDays * MS_PER_DAY;
      for (const filePath of listFiles(paths.quarantineDir)) {
        if (!isWithinRoot(filePath, paths)) continue;
        // Skip sidecar meta files here; they are deleted alongside their data file.
        if (filePath.endsWith(".meta.json")) continue;
        const mtimeMs = safeMtimeMs(filePath);
        if (mtimeMs === null) continue;
        if (now - mtimeMs > quarantineMaxAgeMs) {
          plan.quarantineFiles.push(filePath);
        }
      }
    }

    const deleted = {
      tmpFiles: plan.tmpFiles.length,
      emptySegments: plan.emptySegments.length,
      compactedRawSegments: plan.compactedRawSegments.length,
      overflowRawSegments: plan.overflowRawSegments.length,
      quarantineFiles: plan.quarantineFiles.length,
    };

    // --- dryRun: return the plan WITHOUT deleting or writing ---
    if (dryRun) {
      return { success: true, deleted };
    }

    // --- Perform deletions (guarded once more at the boundary) ---
    for (const filePath of plan.tmpFiles) safeUnlink(filePath, paths);
    for (const filePath of plan.emptySegments) safeUnlink(filePath, paths);
    for (const filePath of plan.compactedRawSegments) safeUnlink(filePath, paths);
    for (const filePath of plan.overflowRawSegments) safeUnlink(filePath, paths);
    for (const filePath of plan.quarantineFiles) {
      safeUnlink(filePath, paths);
      const metaPath = `${filePath}.meta.json`;
      if (fs.existsSync(metaPath)) {
        safeUnlink(metaPath, paths);
      }
    }

    // --- Write gc log segment ---
    const at = new Date().toISOString();
    const gcLogPath = writeGcLog(paths, at, deleted);

    // --- Update + write manifest LAST (commit point) ---
    if (manifest !== null && state !== null) {
      const deletedRawSegments =
        deleted.emptySegments + deleted.compactedRawSegments + deleted.overflowRawSegments;

      const updatedManifest: MemoryManifest = {
        ...manifest,
        gcSummary: {
          lastGcAt: at,
          deletedRawSegments: manifest.gcSummary.deletedRawSegments + deletedRawSegments,
          deletedTmpFiles: manifest.gcSummary.deletedTmpFiles + deleted.tmpFiles,
          deletedQuarantineFiles: manifest.gcSummary.deletedQuarantineFiles + deleted.quarantineFiles,
        },
        compactedInputSegments: cleanCompactedInputSegments(manifest, paths),
        quarantine: cleanQuarantine(manifest, paths),
      };

      writeMaterializedState(paths, {
        findings: state.findings,
        manifest: updatedManifest,
        relatedIndex: state.relatedIndex,
      });
    }

    return { success: true, deleted, gcLogPath };
  });
}

/**
 * Remove compactedInputSegments entries whose rawPath no longer exists on disk.
 * Legacy string[] arrays are left untouched (we cannot safely resolve them).
 */
function cleanCompactedInputSegments(
  manifest: MemoryManifest,
  paths: MemoryPaths,
): MemoryManifest["compactedInputSegments"] {
  const segments = manifest.compactedInputSegments;
  if (isLegacyStringArray(segments)) {
    return segments;
  }
  return (segments as CompactedSegment[]).filter((entry) => {
    const rawAbs = path.resolve(paths.root, entry.rawPath);
    return fs.existsSync(rawAbs);
  });
}

/**
 * Remove quarantine entries whose data file no longer exists on disk.
 * Legacy string[] arrays are left untouched.
 */
function cleanQuarantine(
  manifest: MemoryManifest,
  paths: MemoryPaths,
): MemoryManifest["quarantine"] {
  const quarantine = manifest.quarantine;
  if (isLegacyStringArray(quarantine)) {
    return quarantine;
  }
  return (quarantine as QuarantineEntry[]).filter((entry) => {
    const abs = path.resolve(paths.root, entry.path);
    return fs.existsSync(abs);
  });
}

/**
 * Write a gc log JSON-lines segment to `gc/{ts14}-gc.jsonl`.
 */
function writeGcLog(paths: MemoryPaths, at: string, deleted: GcResult["deleted"]): string {
  const fileName = `${formatTimestamp(new Date())}-gc.jsonl`;
  const gcLogPath = path.join(paths.gcDir, fileName);
  const entry = { type: "gc", at, deleted };
  writeFileAtomicOverwrite(gcLogPath, JSON.stringify(entry) + "\n");
  return gcLogPath;
}

function isLegacyStringArray(arr: unknown[]): boolean {
  return arr.length > 0 && typeof arr[0] === "string";
}

/**
 * List absolute paths of regular files directly inside `dir`.
 * Returns an empty array if the directory does not exist.
 */
function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = safeLstat(full);
    if (stat === null) continue;
    if (stat.isFile() || stat.isSymbolicLink()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Return absolute paths of raw `.jsonl` segments sorted by mtime, NEWEST first.
 * Computed ONCE per gc run.
 */
function listRawSegmentsSortedByMtime(paths: MemoryPaths): string[] {
  if (!fs.existsSync(paths.segmentsDir)) return [];
  const entries: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const name of fs.readdirSync(paths.segmentsDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(paths.segmentsDir, name);
    const mtimeMs = safeMtimeMs(full);
    if (mtimeMs === null) continue;
    entries.push({ filePath: full, mtimeMs });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.map((e) => e.filePath);
}

/**
 * Strict path-prefix guard. A candidate is only safe if it resolves to a path
 * inside `paths.root` (the `.omre/memory/` directory). Uses path.relative so
 * that `..` segments are detected regardless of platform separators.
 *
 * Note: this checks the lexical path, NOT the symlink target. Deletion uses
 * fs.unlinkSync which removes the link itself, never the target.
 */
function isWithinRoot(candidate: string, paths: MemoryPaths): boolean {
  const rel = path.relative(paths.root, path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function safeUnlink(filePath: string, paths: MemoryPaths): void {
  if (!isWithinRoot(filePath, paths)) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best-effort
  }
}

function safeMtimeMs(filePath: string): number | null {
  const stat = safeLstat(filePath);
  return stat === null ? null : stat.mtimeMs;
}

function safeSize(filePath: string): number | null {
  const stat = safeLstat(filePath);
  return stat === null ? null : stat.size;
}

function safeLstat(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

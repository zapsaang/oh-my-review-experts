import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicOverwrite } from "../tools/fs-utils.js";
import { sha256File } from "./ids.js";
import type { MemoryPaths } from "./paths.js";
import type { MemoryManifest, QuarantineEntry } from "./schema.js";

interface QuarantineSidecar {
  schemaVersion: 1;
  originalPath: string;
  quarantinedPath: string;
  reason: QuarantineEntry["reason"];
  message?: string;
  movedAt: string;
  sha256: string;
}

/**
 * Move a corrupt or unusable event file into the quarantine directory and
 * write a sidecar `.meta.json` describing why it was quarantined.
 *
 * Best-effort by contract: callers should wrap this in try/catch and continue
 * on failure. It never aborts a compaction or rebuild.
 *
 * The move is crash-tolerant and consistent with the repository's no-fsync
 * atomic pattern: content is read, written to the destination via
 * `writeFileAtomicOverwrite` (temp + rename), and only then is the source
 * removed. A native cross-directory rename is intentionally avoided.
 */
export function quarantineFile(
  paths: MemoryPaths,
  filePath: string,
  reason: QuarantineEntry["reason"],
  message?: string,
): QuarantineEntry {
  const sourceHash = sha256File(filePath);
  const baseName = path.basename(filePath);
  const destName = resolveQuarantineDestName(paths.quarantineDir, baseName, sourceHash);
  const destPath = path.join(paths.quarantineDir, destName);
  const metaPath = `${destPath}.meta.json`;

  const content = fs.readFileSync(filePath, "utf8");
  writeFileAtomicOverwrite(destPath, content);
  fs.rmSync(filePath);

  const movedAt = new Date().toISOString();
  const quarantinedRel = path.relative(paths.root, destPath);
  const sidecar: QuarantineSidecar = {
    schemaVersion: 1,
    originalPath: path.relative(paths.root, filePath),
    quarantinedPath: quarantinedRel,
    reason,
    ...(message !== undefined ? { message } : {}),
    movedAt,
    sha256: sha256File(destPath),
  };
  writeFileAtomicOverwrite(metaPath, JSON.stringify(sidecar));

  return {
    path: quarantinedRel,
    metaPath: path.relative(paths.root, metaPath),
    reason,
    movedAt,
  };
}

/**
 * Pick a collision-free destination filename inside the quarantine directory.
 * If `{baseName}` is free, it is used as-is. Otherwise a short hash suffix
 * (first 8 chars of the source sha256) is inserted before the extension, e.g.
 * `segment.jsonl` -> `segment-a1b2c3d4.jsonl`.
 */
function resolveQuarantineDestName(quarantineDir: string, baseName: string, sourceHash: string): string {
  if (!fs.existsSync(path.join(quarantineDir, baseName))) {
    return baseName;
  }

  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  return `${stem}-${sourceHash.slice(0, 8)}${ext}`;
}

/**
 * Return a new manifest with `entry` appended to the `quarantine` array.
 *
 * The `quarantine` field is a `string[] | QuarantineEntry[]` union. Legacy
 * data may still be `string[]`. Per the C4 migrate-on-write policy, when the
 * existing array is a legacy `string[]` we discard the old string entries and
 * replace the array with `[entry]` rather than attempting to coerce opaque
 * path strings into structured QuarantineEntry objects. Modern object arrays
 * are appended to normally. The input manifest is not mutated.
 */
export function appendQuarantineEntry(manifest: MemoryManifest, entry: QuarantineEntry): MemoryManifest {
  const existing = manifest.quarantine;
  const isLegacyStringArray = existing.length > 0 && typeof existing[0] === "string";

  const quarantine: QuarantineEntry[] = isLegacyStringArray
    ? [entry]
    : [...(existing as QuarantineEntry[]), entry];

  return { ...manifest, quarantine };
}

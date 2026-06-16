import fs from "node:fs";
import path from "node:path";
import { MemoryVersionSchema, type EventFileInfo } from "./schema.js";
import type { MemoryPaths } from "./paths.js";
import { readAllEventSegments } from "./events.js";
import { readMaterializedState, rebuildMaterializedStateFromEvents, readMemoryManifest } from "./store.js";

export interface CheckResult {
  healthy: boolean;
  version: {
    schemaVersion: number;
    eventSchemaVersion: number;
    viewSchemaVersion: number;
  };
  segments: {
    raw: number;
    compacted: number;
    includedInManifest: number;
    orphanRaw: number;
    invalid: number;
  };
  quarantine: {
    files: number;
    reasons: Record<string, number>;
    latest: Array<{ path: string; reason: string; movedAt: string }>;
  };
  materialized: {
    findings: number;
    relations: number;
    materializedHash: string;
    relatedIndexHash: string;
  };
  warnings: string[];
}

export function runMemoryCheck(paths: MemoryPaths): CheckResult {
  const warnings: string[] = [];

  // Rule 1: VERSION exists and schema versions are supported
  const version = readVersion(paths, warnings);

  // Read manifest (may be null for empty state)
  const manifest = readMemoryManifest(paths);

  // Scan raw and compacted directories
  const rawFiles = listJsonlFiles(paths.segmentsDir);
  const compactedFiles = listJsonlFiles(paths.compactedDir);

  // Count invalid segments (files where no line parses as valid JSON)
  const invalidCount = countInvalidSegments(paths, rawFiles, compactedFiles);

  // Determine if legacy string[] includedEventFiles
  const isLegacy = manifest !== null && isLegacyIncludedEventFiles(manifest.includedEventFiles);
  if (isLegacy) {
    warnings.push("manifest.includedEventFiles uses legacy string[] format; orphan detection skipped");
  }

  const includedInManifest = manifest !== null ? manifest.includedEventFiles.length : 0;

  // Rule 8: Orphan raw segments (raw segments on disk NOT in manifest.includedEventFiles)
  let orphanRaw = 0;
  if (manifest !== null && !isLegacy) {
    const includedPaths = new Set(
      (manifest.includedEventFiles as EventFileInfo[])
        .filter((entry) => entry.kind === "raw")
        .map((entry) => entry.path),
    );
    for (const file of rawFiles) {
      const relativePath = path.relative(paths.root, path.join(paths.segmentsDir, file));
      if (!includedPaths.has(relativePath)) {
        orphanRaw++;
      }
    }
    if (orphanRaw > 0) {
      warnings.push(`${orphanRaw} orphan raw segment(s) found not referenced in manifest.includedEventFiles`);
    }
  }

  // Rule 3: All raw segments referenced in manifest.includedEventFiles exist and are readable
  if (manifest !== null && !isLegacy) {
    for (const entry of manifest.includedEventFiles as EventFileInfo[]) {
      if (entry.kind === "raw") {
        const fullPath = path.join(paths.root, entry.path);
        if (!fs.existsSync(fullPath)) {
          warnings.push(`referenced raw segment missing: ${entry.path}`);
        }
      }
    }
  }

  // Rule 4: All compacted segments referenced in manifest.includedEventFiles exist
  if (manifest !== null && !isLegacy) {
    for (const entry of manifest.includedEventFiles as EventFileInfo[]) {
      if (entry.kind === "compacted") {
        const fullPath = path.join(paths.root, entry.path);
        if (!fs.existsSync(fullPath)) {
          warnings.push(`referenced compacted segment missing: ${entry.path}`);
        }
      }
    }
  }

  // Rule 5: compactedInputSegments entries have valid rawPath and compactedPath
  if (manifest !== null && Array.isArray(manifest.compactedInputSegments)) {
    const segments = manifest.compactedInputSegments;
    if (segments.length > 0 && typeof segments[0] === "object" && segments[0] !== null && "rawPath" in segments[0]) {
      for (const entry of segments as Array<{ rawPath: string; compactedPath: string }>) {
        if (!entry.rawPath || !entry.compactedPath) {
          warnings.push("compactedInputSegments entry has empty rawPath or compactedPath");
        }
      }
    }
  }

  // Rule 6: Quarantine files have corresponding .meta.json files
  const quarantine = scanQuarantine(paths, warnings);

  // Rule 2 & 7: manifest hash integrity check (B1 fix)
  let materializedHash = "";
  let relatedIndexHash = "";
  let findingsCount = 0;
  let relationsCount = 0;

  const state = readMaterializedState(paths);
  if (state !== null) {
    findingsCount = state.findings.length;
    relationsCount = state.relatedIndex.relations.length;
    materializedHash = state.manifest.materializedHash;
    relatedIndexHash = state.manifest.relatedIndexHash;

    // Rule 7: Recompute materializedHash from events and compare
    const { events } = readAllEventSegments(paths);
    const rebuilt = rebuildMaterializedStateFromEvents(events);
    if (rebuilt.manifest.materializedHash !== state.manifest.materializedHash) {
      warnings.push("materialized state stale; run index-latest (materializedHash mismatch)");
    }
  }

  const healthy = warnings.length === 0;

  return {
    healthy,
    version,
    segments: {
      raw: rawFiles.length,
      compacted: compactedFiles.length,
      includedInManifest,
      orphanRaw,
      invalid: invalidCount,
    },
    quarantine,
    materialized: {
      findings: findingsCount,
      relations: relationsCount,
      materializedHash,
      relatedIndexHash,
    },
    warnings,
  };
}

export function renderCheckResult(result: CheckResult): string {
  const lines: string[] = [];

  lines.push("Memory Check");
  lines.push("");
  lines.push("Version:");
  lines.push(`  schemaVersion: ${result.version.schemaVersion}`);
  lines.push(`  eventSchemaVersion: ${result.version.eventSchemaVersion}`);
  lines.push(`  viewSchemaVersion: ${result.version.viewSchemaVersion}`);
  lines.push("");
  lines.push("Segments:");
  lines.push(`  raw: ${result.segments.raw}`);
  lines.push(`  compacted: ${result.segments.compacted}`);
  lines.push(`  included in manifest: ${result.segments.includedInManifest}`);
  lines.push(`  orphan raw: ${result.segments.orphanRaw}`);
  lines.push(`  invalid: ${result.segments.invalid}`);
  lines.push("");
  lines.push("Quarantine:");
  lines.push(`  files: ${result.quarantine.files}`);
  if (Object.keys(result.quarantine.reasons).length > 0) {
    lines.push("  reasons:");
    for (const [reason, count] of Object.entries(result.quarantine.reasons).sort()) {
      lines.push(`    ${reason}: ${count}`);
    }
  }
  if (result.quarantine.latest.length > 0) {
    lines.push("  latest:");
    for (const entry of result.quarantine.latest) {
      lines.push(`    - ${entry.path}`);
      lines.push(`      reason: ${entry.reason}`);
      lines.push(`      movedAt: ${entry.movedAt}`);
    }
  }
  lines.push("");
  lines.push("Materialized:");
  lines.push(`  findings: ${result.materialized.findings}`);
  lines.push(`  relations: ${result.materialized.relations}`);
  lines.push(`  materializedHash: ${result.materialized.materializedHash}`);
  lines.push(`  relatedIndexHash: ${result.materialized.relatedIndexHash}`);

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  return lines.join("\n");
}

function readVersion(paths: MemoryPaths, warnings: string[]): CheckResult["version"] {
  const defaultVersion = { schemaVersion: 0, eventSchemaVersion: 0, viewSchemaVersion: 0 };

  if (!fs.existsSync(paths.versionFile)) {
    // On empty repos without VERSION file, we don't warn (healthy-but-empty)
    // Check if there's a manifest — if so, VERSION should exist
    if (fs.existsSync(paths.manifestFile)) {
      warnings.push("VERSION file missing but manifest exists");
    }
    return defaultVersion;
  }

  try {
    const raw = fs.readFileSync(paths.versionFile, "utf8");
    const parsed = JSON.parse(raw);
    const result = MemoryVersionSchema.safeParse(parsed);
    if (result.success) {
      return {
        schemaVersion: result.data.schemaVersion,
        eventSchemaVersion: result.data.eventSchemaVersion,
        viewSchemaVersion: result.data.viewSchemaVersion,
      };
    }
    warnings.push("VERSION file has invalid schema");
    return defaultVersion;
  } catch {
    warnings.push("VERSION file is not valid JSON");
    return defaultVersion;
  }
}

function listJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
}

function countInvalidSegments(paths: MemoryPaths, rawFiles: string[], compactedFiles: string[]): number {
  let invalid = 0;

  for (const file of rawFiles) {
    if (!hasAnyValidLine(path.join(paths.segmentsDir, file))) {
      invalid++;
    }
  }

  for (const file of compactedFiles) {
    if (!hasAnyValidLine(path.join(paths.compactedDir, file))) {
      invalid++;
    }
  }

  return invalid;
}

function hasAnyValidLine(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim() !== "");
    for (const line of lines) {
      try {
        JSON.parse(line);
        return true;
      } catch {
        // continue
      }
    }
    return lines.length === 0; // empty file is not "invalid"
  } catch {
    return false;
  }
}

function isLegacyIncludedEventFiles(includedEventFiles: unknown[]): boolean {
  if (includedEventFiles.length === 0) return false;
  return typeof includedEventFiles[0] === "string";
}

interface QuarantineMeta {
  path: string;
  reason: string;
  movedAt: string;
}

function scanQuarantine(
  paths: MemoryPaths,
  warnings: string[],
): CheckResult["quarantine"] {
  const result: CheckResult["quarantine"] = {
    files: 0,
    reasons: {},
    latest: [],
  };

  if (!fs.existsSync(paths.quarantineDir)) return result;

  const allFiles = fs.readdirSync(paths.quarantineDir);
  const dataFiles = allFiles.filter((f) => !f.endsWith(".meta.json"));
  result.files = dataFiles.length;

  const metas: QuarantineMeta[] = [];

  for (const file of dataFiles) {
    const metaFile = `${file}.meta.json`;
    const metaPath = path.join(paths.quarantineDir, metaFile);

    if (!allFiles.includes(metaFile)) {
      warnings.push(`quarantine file lacks sidecar: ${file}`);
      continue;
    }

    try {
      const raw = fs.readFileSync(metaPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const reason = typeof parsed.reason === "string" ? parsed.reason : "unknown";
      const movedAt = typeof parsed.movedAt === "string" ? parsed.movedAt : "unknown";

      result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
      metas.push({
        path: path.relative(paths.root, path.join(paths.quarantineDir, file)),
        reason,
        movedAt,
      });
    } catch {
      warnings.push(`quarantine sidecar unreadable: ${metaFile}`);
    }
  }

  // Sort by movedAt descending, take latest 3
  metas.sort((a, b) => b.movedAt.localeCompare(a.movedAt));
  result.latest = metas.slice(0, 3);

  if (result.files > 0) {
    warnings.push("quarantine contains files; run `omre memory gc --quarantine --older-than 30d`");
  }

  return result;
}

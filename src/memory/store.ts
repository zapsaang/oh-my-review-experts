import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  MemoryFindingSchema,
  MemoryManifestSchema,
  RelatedIndexSchema,
  normalizeMemoryStatus,
  type MemoryFinding,
  type MemoryEvent,
  type MemoryManifest,
  type RelatedIndex,
  type EventFileInfo,
} from "./schema.js";
import type { MemoryPaths } from "./paths.js";
import { writeFileAtomicOverwrite } from "../tools/fs-utils.js";
import { sleepSync } from "./lock.js";

export const CURRENT_MEMORY_EVENT_SCHEMA_VERSION = 1;

export interface MaterializedState {
  findings: MemoryFinding[];
  manifest: MemoryManifest;
  relatedIndex: RelatedIndex;
}

const MAX_READ_RETRIES = 1;
const READ_RETRY_DELAY_MS = 25;

export function readMaterializedState(paths: MemoryPaths): MaterializedState | null {
  return readMaterializedStateImpl(paths, 0);
}

function readMaterializedStateImpl(
  paths: MemoryPaths,
  retryCount: number,
): MaterializedState | null {
  const manifest = readMemoryManifest(paths);
  if (manifest === null) {
    return null;
  }

  let findings: MemoryFinding[] = [];
  if (fs.existsSync(paths.memoryFile)) {
    const memoryRaw = fs.readFileSync(paths.memoryFile, "utf8");
    const lines = memoryRaw.split("\n").filter((line) => line.trim() !== "");
    findings = lines.map((line) => {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (typeof raw.status === "string") {
        raw.status = normalizeMemoryStatus(raw.status);
      }
      return MemoryFindingSchema.parse(raw);
    });
  }

  let relatedIndex: RelatedIndex = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    relations: [],
    byFindingId: {},
  };
  if (fs.existsSync(paths.relatedIndexFile)) {
    const relatedRaw = fs.readFileSync(paths.relatedIndexFile, "utf8");
    relatedIndex = RelatedIndexSchema.parse(JSON.parse(relatedRaw));
  }

  const computed = hashFindings(findings);
  if (computed !== manifest.materializedHash) {
    if (retryCount < MAX_READ_RETRIES) {
      // FIX-4: a hash mismatch usually means we read memory.jsonl mid-write,
      // between a writer's data write and its manifest commit. A brief backoff
      // and re-read lets the writer finish. This retry path primarily benefits
      // lock-free readers (trends/stats/search); lock-holding writers
      // (mark/gc/compact) already have exclusive access and never race here.
      sleepSync(READ_RETRY_DELAY_MS);
      return readMaterializedStateImpl(paths, retryCount + 1);
    }
    return null;
  }

  return { findings, manifest, relatedIndex };
}

export function readMemoryManifest(paths: MemoryPaths): MemoryManifest | null {
  if (!fs.existsSync(paths.manifestFile)) {
    return null;
  }

  const manifestRaw = fs.readFileSync(paths.manifestFile, "utf8");
  return MemoryManifestSchema.parse(JSON.parse(manifestRaw));
}

export function writeMaterializedState(
  paths: MemoryPaths,
  state: MaterializedState,
): MaterializedState {
  const canonicalFindings = state.findings.map((finding) => MemoryFindingSchema.parse(finding));
  const diskManifest = {
    ...state.manifest,
    includedEventFiles: scanEventFiles(paths),
    compactedInputSegments: state.manifest.compactedInputSegments ?? [],
    materializedHash: hashFindings(canonicalFindings),
  };
  const diskRelatedIndex = structuredClone(state.relatedIndex);
  const diskState: MaterializedState = {
    findings: canonicalFindings,
    manifest: diskManifest,
    relatedIndex: diskRelatedIndex,
  };
  writeFileAtomicOverwrite(paths.memoryFile, canonicalFindings.map((finding) => JSON.stringify(finding)).join("\n") + "\n");
  writeFileAtomicOverwrite(paths.relatedIndexFile, JSON.stringify(diskRelatedIndex));
  writeFileAtomicOverwrite(paths.manifestFile, JSON.stringify(diskManifest), { fsync: true });
  return diskState;
}

/**
 * Scan the raw and compacted event directories and return one EventFileInfo
 * entry per `.jsonl` file, sorted by minTimestamp ascending. This is the
 * authoritative descriptor for `manifest.includedEventFiles`.
 */
export function scanEventFiles(paths: MemoryPaths): EventFileInfo[] {
  const dirs: Array<{ dir: string; kind: EventFileInfo["kind"] }> = [
    { dir: paths.segmentsDir, kind: "raw" },
    { dir: paths.compactedDir, kind: "compacted" },
  ];

  const infos: EventFileInfo[] = [];

  for (const { dir, kind } of dirs) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter((line) => line.trim() !== "");

      const timestamps: string[] = [];
      let eventCount = 0;
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          eventCount++;
          if (typeof parsed.at === "string") {
            timestamps.push(parsed.at);
          }
        } catch {
          // Non-JSON line (e.g. padding); ignore for counting.
        }
      }

      const fallback = fs.statSync(filePath).mtime.toISOString();
      const minTimestamp = timestamps.length > 0 ? timestamps[0]! : fallback;
      const maxTimestamp = timestamps.length > 0 ? timestamps[timestamps.length - 1]! : fallback;

      infos.push({
        path: path.relative(paths.root, filePath),
        kind,
        sha256: createHash("sha256").update(content).digest("hex"),
        eventCount,
        minTimestamp,
        maxTimestamp,
      });
    }
  }

  infos.sort((a, b) => a.minTimestamp.localeCompare(b.minTimestamp));
  return infos;
}

export function rebuildMaterializedStateFromEvents(events: MemoryEvent[]): MaterializedState {
  const findings: MemoryFinding[] = [];
  const findingsById = new Map<string, MemoryFinding>();
  const relations: RelatedIndex["relations"] = [];
  const relationKeys = new Set<string>();
  const byFindingId: RelatedIndex["byFindingId"] = {};

  for (const event of events) {
    switch (event.type) {
      case "finding.discovered": {
        if (!findingsById.has(event.finding.id)) {
          const finding = event.finding;
          finding.status = normalizeMemoryStatus(finding.status) as MemoryFinding["status"];
          findings.push(finding);
          findingsById.set(finding.id, finding);
        }
        break;
      }
      case "finding.seen_again": {
        const finding = findingsById.get(event.findingId);
        if (finding) {
          finding.occurrence.count += 1;
          finding.occurrence.lastSeenAt = event.at;
          if (!finding.occurrence.runIds.includes(event.runId)) {
            finding.occurrence.runIds.push(event.runId);
          }
        }
        break;
      }
      case "finding.status_changed": {
        const finding = findingsById.get(event.findingId);
        if (finding) {
          finding.status = normalizeMemoryStatus(event.to) as MemoryFinding["status"];
        }
        break;
      }
      case "finding.regressed": {
        const finding = findingsById.get(event.findingId);
        if (finding) {
          finding.status = normalizeMemoryStatus(event.toStatus) as MemoryFinding["status"];
          finding.occurrence.lastSeenAt = event.at;
          if (!finding.occurrence.runIds.includes(event.runId)) {
            finding.occurrence.runIds.push(event.runId);
          }
        }
        break;
      }
      case "finding.related": {
        const relation = {
          findingId: event.findingId,
          relatedFindingId: event.relatedFindingId,
          relationType: event.relationType,
        };
        const relationKey = JSON.stringify([
          relation.findingId,
          relation.relatedFindingId,
          relation.relationType,
        ]);

        if (!relationKeys.has(relationKey)) {
          relations.push(relation);
          relationKeys.add(relationKey);
          byFindingId[relation.findingId] = byFindingId[relation.findingId] ?? [];
          byFindingId[relation.findingId].push(relation);
        }
        break;
      }
      default:
        break;
    }
  }

  const now = new Date().toISOString();
  const relatedIndex: RelatedIndex = {
    schemaVersion: 1,
    generatedAt: now,
    relations,
    byFindingId,
  };

  const manifest: MemoryManifest = {
    schemaVersion: 1,
    eventSchemaVersion: CURRENT_MEMORY_EVENT_SCHEMA_VERSION,
    viewSchemaVersion: 1,
    lastRebuiltAt: now,
    materializedHash: hashFindings(findings),
    relatedIndexHash: hashRelatedIndex(relatedIndex),
    includedEventFiles: [],
    compactedInputSegments: [],
    gcSummary: {
      lastGcAt: undefined,
      deletedRawSegments: 0,
      deletedTmpFiles: 0,
      deletedQuarantineFiles: 0,
    },
    quarantine: [],
  };

  return { findings, manifest, relatedIndex };
}

export function hashFindings(findings: MemoryFinding[]): string {
  const content = [...findings]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((finding) =>
      [
        finding.id,
        finding.fingerprint,
        finding.status,
        finding.severity,
        finding.contentHash,
      ].join("\x1f"),
    )
    .join("\n");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function hashRelatedIndex(relatedIndex: RelatedIndex): string {
  const content = JSON.stringify(relatedIndex.relations);
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

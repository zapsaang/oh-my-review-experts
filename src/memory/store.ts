import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  MemoryFindingSchema,
  MemoryManifestSchema,
  RelatedIndexSchema,
  type MemoryFinding,
  type MemoryEvent,
  type MemoryManifest,
  type RelatedIndex,
} from "./schema.js";
import type { MemoryPaths } from "./paths.js";
import { writeFileAtomicOverwrite } from "../tools/fs-utils.js";

export interface MaterializedState {
  findings: MemoryFinding[];
  manifest: MemoryManifest;
  relatedIndex: RelatedIndex;
}

export function readMaterializedState(paths: MemoryPaths): MaterializedState | null {
  if (!fs.existsSync(paths.manifestFile)) {
    return null;
  }

  const manifestRaw = fs.readFileSync(paths.manifestFile, "utf8");
  const manifest = MemoryManifestSchema.parse(JSON.parse(manifestRaw));

  let findings: MemoryFinding[] = [];
  if (fs.existsSync(paths.memoryFile)) {
    const memoryRaw = fs.readFileSync(paths.memoryFile, "utf8");
    const lines = memoryRaw.split("\n").filter((line) => line.trim() !== "");
    findings = lines.map((line) => MemoryFindingSchema.parse(JSON.parse(line)));
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

  return { findings, manifest, relatedIndex };
}

export function writeMaterializedState(
  paths: MemoryPaths,
  state: MaterializedState,
): void {
  // Write memory.jsonl FIRST
  const memoryContent = state.findings.map((finding) => JSON.stringify(finding)).join("\n") + "\n";
  writeFileAtomicOverwrite(paths.memoryFile, memoryContent);

  // Write related-index.json SECOND
  const relatedContent = JSON.stringify(state.relatedIndex);
  writeFileAtomicOverwrite(paths.relatedIndexFile, relatedContent);

  // Write manifest.json LAST (commit point)
  const manifestContent = JSON.stringify(state.manifest);
  writeFileAtomicOverwrite(paths.manifestFile, manifestContent);
}

export function rebuildMaterializedStateFromEvents(events: MemoryEvent[]): MaterializedState {
  const findings: MemoryFinding[] = [];
  const findingIds = new Set<string>();
  const relations: RelatedIndex["relations"] = [];
  const byFindingId: RelatedIndex["byFindingId"] = {};

  for (const event of events) {
    switch (event.type) {
      case "finding.discovered": {
        if (!findingIds.has(event.finding.id)) {
          findings.push(event.finding);
          findingIds.add(event.finding.id);
        }
        break;
      }
      case "finding.seen_again": {
        const finding = findings.find((candidate) => candidate.id === event.findingId);
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
        const finding = findings.find((candidate) => candidate.id === event.findingId);
        if (finding) {
          finding.status = event.to;
        }
        break;
      }
      case "finding.regressed": {
        const finding = findings.find((candidate) => candidate.id === event.findingId);
        if (finding) {
          finding.status = event.toStatus;
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
        const alreadyRecorded = relations.some((existing) => (
          existing.findingId === relation.findingId
          && existing.relatedFindingId === relation.relatedFindingId
          && existing.relationType === relation.relationType
        ));

        if (!alreadyRecorded) {
          relations.push(relation);
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
    eventSchemaVersion: 1,
    viewSchemaVersion: 1,
    lastRebuiltAt: now,
    materializedHash: hashFindings(findings),
    relatedIndexHash: hashRelatedIndex(relatedIndex),
    includedEventFiles: [],
    compactedInputSegments: [],
    gcSummary: {
      deletedRawSegments: 0,
      deletedTmpFiles: 0,
      deletedQuarantineFiles: 0,
    },
    quarantine: [],
  };

  return { findings, manifest, relatedIndex };
}

function hashFindings(findings: MemoryFinding[]): string {
  const content = findings.map((finding) => finding.id).join("\n");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function hashRelatedIndex(relatedIndex: RelatedIndex): string {
  const content = JSON.stringify(relatedIndex.relations);
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

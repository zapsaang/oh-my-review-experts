import fs from "node:fs";
import path from "node:path";
import { loadConfigUnsafe } from "../config/load-config.js";
import { compareMemoryEvents } from "./events.js";
import { sha256File } from "./ids.js";
import { resolveMemoryPaths, type MemoryPaths } from "./paths.js";
import { quarantineFile } from "./quarantine.js";
import { MemoryEventSchema, type CompactedSegment, type MemoryEvent } from "./schema.js";
import { readMemoryManifest, writeMaterializedState, readMaterializedState } from "./store.js";
import { writeFileAtomicOverwrite } from "../tools/fs-utils.js";

export interface CompactOptions {
  cwd?: string;
  dryRun?: boolean;
}

export interface CompactResult {
  success: boolean;
  compactedSegments: Array<{
    rawPaths: string[];
    compactedPath: string;
    eventCount: number;
  }>;
  durationMs: number;
}

export function runMemoryCompact(options: CompactOptions = {}): CompactResult {
  const start = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfigUnsafe(cwd).memory;
  const paths = resolveMemoryPaths(cwd, config.directory);
  const maxDurationMs = config.compaction.maxCompactDurationMs;

  const uncompacted = listUncompactedRawSegments(paths);
  if (uncompacted.length === 0) {
    return { success: true, compactedSegments: [], durationMs: Date.now() - start };
  }

  if (options.dryRun) {
    const planned = planDryRun(paths, uncompacted);
    return { success: true, compactedSegments: planned, durationMs: Date.now() - start };
  }

  const merged: MemoryEvent[] = [];
  const consumedRawPaths: string[] = [];

  for (const segPath of uncompacted) {
    if (Date.now() - start > maxDurationMs) {
      break;
    }

    const segmentEvents = readSegmentEvents(paths, segPath);
    if (segmentEvents === null) {
      continue;
    }

    merged.push(...segmentEvents);
    consumedRawPaths.push(segPath);
  }

  if (consumedRawPaths.length === 0) {
    return { success: true, compactedSegments: [], durationMs: Date.now() - start };
  }

  const dedupedSorted = dedupeAndSort(merged);
  const compactedAbs = writeCompactedFile(paths, dedupedSorted);
  const compactedRel = path.relative(paths.root, compactedAbs);
  const compactedSha256 = sha256File(compactedAbs);
  const compactedAt = new Date().toISOString();

  const newEntries: CompactedSegment[] = consumedRawPaths.map((rawAbs) => ({
    rawPath: path.relative(paths.root, rawAbs),
    rawSha256: sha256File(rawAbs),
    compactedPath: compactedRel,
    compactedSha256,
    compactedAt,
  }));

  updateManifest(paths, newEntries);

  return {
    success: true,
    compactedSegments: [{
      rawPaths: consumedRawPaths.map((rawAbs) => path.relative(paths.root, rawAbs)),
      compactedPath: compactedRel,
      eventCount: dedupedSorted.length,
    }],
    durationMs: Date.now() - start,
  };
}

function listUncompactedRawSegments(paths: MemoryPaths): string[] {
  if (!fs.existsSync(paths.segmentsDir)) {
    return [];
  }

  const compactedRawPaths = readCompactedRawPaths(paths);

  const candidates = fs.readdirSync(paths.segmentsDir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => path.join(paths.segmentsDir, file))
    .filter((abs) => !compactedRawPaths.has(path.relative(paths.root, abs)));

  candidates.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  return candidates;
}

function readCompactedRawPaths(paths: MemoryPaths): Set<string> {
  const manifest = readMemoryManifest(paths);
  if (manifest === null) {
    return new Set();
  }

  const segments = manifest.compactedInputSegments;
  if (segments.length === 0 || typeof segments[0] === "string") {
    return new Set();
  }

  return new Set((segments as CompactedSegment[]).map((entry) => entry.rawPath));
}

function readSegmentEvents(paths: MemoryPaths, segPath: string): MemoryEvent[] | null {
  const content = fs.readFileSync(segPath, "utf8");
  const lines = content.split("\n").filter((line) => line.trim() !== "");

  const events: MemoryEvent[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      quarantineSegment(paths, segPath);
      return null;
    }

    const result = MemoryEventSchema.safeParse(parsed);
    if (!result.success) {
      quarantineSegment(paths, segPath);
      return null;
    }

    events.push(result.data);
  }

  return events;
}

function quarantineSegment(paths: MemoryPaths, segPath: string): void {
  try {
    quarantineFile(paths, segPath, "parse-error");
  } catch {
    // Best-effort per quarantine.ts contract: never abort compaction.
  }
}

function dedupeAndSort(events: MemoryEvent[]): MemoryEvent[] {
  const sorted = [...events].sort(compareMemoryEvents);
  const seen = new Set<string>();
  const deduped: MemoryEvent[] = [];
  for (const event of sorted) {
    if (seen.has(event.eventId)) {
      continue;
    }
    seen.add(event.eventId);
    deduped.push(event);
  }
  return deduped;
}

function writeCompactedFile(paths: MemoryPaths, events: MemoryEvent[]): string {
  const ts14 = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const existing = fs.existsSync(paths.compactedDir)
    ? fs.readdirSync(paths.compactedDir).filter((file) => file.endsWith(".jsonl")).length
    : 0;
  const seq = String(existing).padStart(3, "0");
  const filename = `${ts14}-compact-${seq}.jsonl`;
  const compactedAbs = path.join(paths.compactedDir, filename);

  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  writeFileAtomicOverwrite(compactedAbs, `${lines}\n`);
  return compactedAbs;
}

function updateManifest(paths: MemoryPaths, newEntries: CompactedSegment[]): void {
  const state = readMaterializedState(paths);
  if (state === null) {
    return;
  }

  const existing = state.manifest.compactedInputSegments;
  const isLegacy = existing.length > 0 && typeof existing[0] === "string";
  const base: CompactedSegment[] = isLegacy ? [] : (existing as CompactedSegment[]);

  state.manifest.compactedInputSegments = [...base, ...newEntries];
  writeMaterializedState(paths, state);
}

function planDryRun(
  paths: MemoryPaths,
  uncompacted: string[],
): CompactResult["compactedSegments"] {
  const ts14 = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const existing = fs.existsSync(paths.compactedDir)
    ? fs.readdirSync(paths.compactedDir).filter((file) => file.endsWith(".jsonl")).length
    : 0;
  const seq = String(existing).padStart(3, "0");
  const plannedRel = path.relative(paths.root, path.join(paths.compactedDir, `${ts14}-compact-${seq}.jsonl`));

  let eventCount = 0;
  const rawPaths: string[] = [];
  for (const segPath of uncompacted) {
    const content = fs.readFileSync(segPath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim() !== "");
    let valid = true;
    let lineCount = 0;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!MemoryEventSchema.safeParse(parsed).success) {
          valid = false;
          break;
        }
        lineCount++;
      } catch {
        valid = false;
        break;
      }
    }
    if (!valid) {
      continue;
    }
    eventCount += lineCount;
    rawPaths.push(path.relative(paths.root, segPath));
  }

  return [{ rawPaths, compactedPath: plannedRel, eventCount }];
}

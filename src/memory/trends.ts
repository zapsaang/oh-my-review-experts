import { compareMemoryEvents } from "./events.js";
import type { MemoryEvent, MemoryFinding } from "./schema.js";

export interface ComputeTrendsOptions { atBucket: string; }

export interface TrendsReport {
  moduleDistribution: Array<{ module: string; count: number; percentage: number }>;
  recurringRegressions: Array<{ findingId: string; title: string; regressionCount: number; lastRegressionAt?: string }>;
  fixSurvivalTime: Array<{ findingId: string; title: string; fixedAt: string; regressedAt?: string; survivedMs: number }>;
  perRunTimeline: Array<{ runId: string; introduced: number; seenAgain: number; statusChanged: number; regressed: number; totalActive: number }>;
}

type TimelineBucket = TrendsReport["perRunTimeline"][number] & { firstAt: string; order: number };
type RunBoundary = { runId: string; at: string; order: number };
export type { RunBoundary };

const UNKNOWN_MODULE = "unknown";
const MARK_RUN_ID = "omre-mark";
const ACTIVE_STATUSES = new Set<MemoryFinding["status"]>(["open", "confirmed"]);

export function computeTrends(events: MemoryEvent[], options: ComputeTrendsOptions): TrendsReport {
  // readAllEventSegments already sorts with compareMemoryEvents; callers of this
  // pure function may still pass raw arrays, so keep a defensive non-mutating sort.
  const sortedEvents = [...events].sort(compareMemoryEvents);
  const findingsById = collectFindings(sortedEvents);

  return {
    moduleDistribution: computeModuleDistribution(findingsById),
    recurringRegressions: computeRecurringRegressions(sortedEvents, findingsById),
    fixSurvivalTime: computeFixSurvivalTime(sortedEvents, findingsById, options),
    perRunTimeline: computePerRunTimeline(sortedEvents, options),
  };
}

function collectFindings(events: MemoryEvent[]): Map<string, MemoryFinding> {
  const findingsById = new Map<string, MemoryFinding>();
  for (const event of events) {
    if (event.type === "finding.discovered" && !findingsById.has(event.finding.id)) {
      findingsById.set(event.finding.id, event.finding);
    }
  }
  return findingsById;
}

function computeModuleDistribution(findingsById: Map<string, MemoryFinding>): TrendsReport["moduleDistribution"] {
  const counts = new Map<string, number>();
  for (const finding of findingsById.values()) {
    const modules = finding.locations.length === 0
      ? new Set([UNKNOWN_MODULE])
      : new Set(finding.locations.map((location) => extractModule(location.path, finding.repo.packagePath)));
    for (const moduleName of modules) incrementCount(counts, moduleName);
  }

  const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
  return total === 0
    ? []
    : Array.from(counts, ([module, count]) => ({ module, count, percentage: (count / total) * 100 }))
      .sort((a, b) => b.count - a.count || a.module.localeCompare(b.module));
}

function extractModule(locationPath: string, packagePath: string): string {
  let normalizedPath = normalizePath(locationPath);
  const normalizedPackage = normalizePath(packagePath);
  if (normalizedPackage !== "" && normalizedPackage !== ".") {
    const relativePrefix = `${normalizedPackage}/`;
    const absoluteMarker = `/${normalizedPackage}/`;
    const markerIndex = normalizedPath.lastIndexOf(absoluteMarker);
    if (normalizedPath === normalizedPackage) {
      normalizedPath = "";
    } else if (normalizedPath.startsWith(relativePrefix)) {
      normalizedPath = normalizedPath.slice(relativePrefix.length);
    } else if (markerIndex >= 0) {
      normalizedPath = normalizedPath.slice(markerIndex + absoluteMarker.length);
    }
  }

  for (const anchor of ["/src/", "/lib/", "/test/", "/packages/", "/apps/"]) {
    const anchorIndex = normalizedPath.lastIndexOf(anchor);
    if (anchorIndex >= 0) {
      normalizedPath = normalizedPath.slice(anchorIndex + 1);
      break;
    }
  }

  if (normalizedPath.startsWith("/") || normalizedPath.includes(":/")) {
    normalizedPath = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  }

  const segments = normalizedPath.split("/").filter((segment) => segment.length > 0);
  const sourceIndex = segments.lastIndexOf("src");
  const moduleSegments = sourceIndex >= 0 ? segments.slice(sourceIndex + 1) : stripWorkspacePrefix(segments);
  const modulePart = moduleSegments[0] ?? UNKNOWN_MODULE;
  return moduleSegments.length > 1 ? modulePart : stripExtension(modulePart);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function stripWorkspacePrefix(segments: string[]): string[] {
  const first = segments[0];
  if (first === "src" || first === "lib" || first === "test") return segments.slice(1);
  return (first === "packages" || first === "apps") && segments[2] === "src" ? segments.slice(3) : segments;
}

function stripExtension(fileName: string): string {
  const extensionStart = fileName.lastIndexOf(".");
  return extensionStart <= 0 ? fileName : fileName.slice(0, extensionStart);
}

function computeRecurringRegressions(events: MemoryEvent[], findingsById: Map<string, MemoryFinding>): TrendsReport["recurringRegressions"] {
  const regressionsById = new Map<string, TrendsReport["recurringRegressions"][number]>();
  for (const event of events) {
    if (event.type !== "finding.regressed") {
      continue;
    }
    const existing = regressionsById.get(event.findingId);
    if (existing === undefined) {
      regressionsById.set(event.findingId, { findingId: event.findingId, title: findingsById.get(event.findingId)?.title ?? event.findingId, regressionCount: 1, lastRegressionAt: event.at });
    } else {
      existing.regressionCount += 1;
      existing.lastRegressionAt = event.at;
    }
  }
  return Array.from(regressionsById.values()).sort((a, b) => (
    b.regressionCount - a.regressionCount
    || compareOptionalTimestampDescending(a.lastRegressionAt, b.lastRegressionAt)
    || a.findingId.localeCompare(b.findingId)
  ));
}

// SCOPE NOTE: computeFixSurvivalTime turns Date.parse output into a numeric duration.
// Other Date.parse calls here are ordering-only sort comparators, and filterTimelineEvents already guards its bucket parse.
export function safeDateParse(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function computeFixSurvivalTime(
  events: MemoryEvent[],
  findingsById: Map<string, MemoryFinding>,
  options: ComputeTrendsOptions,
): TrendsReport["fixSurvivalTime"] {
  if (safeDateParse(options.atBucket) === undefined) {
    throw new Error(`Invalid atBucket timestamp: "${options.atBucket}"`);
  }
  const openEndedAt = options.atBucket;
  const entries: TrendsReport["fixSurvivalTime"] = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== "finding.status_changed" || event.to !== "fixed") {
      continue;
    }
    const endingEvent = findSurvivalEndingEvent(events, index, event.findingId);
    const endedAt = endingEvent?.at ?? openEndedAt;
    const fixedAtMs = safeDateParse(event.at);
    if (fixedAtMs === undefined) {
      throw new Error(`Invalid event timestamp: "${event.at}"`);
    }
    const endedAtMs = safeDateParse(endedAt);
    if (endedAtMs === undefined) {
      throw new Error(`Invalid event timestamp: "${endedAt}"`);
    }
    const entry = { findingId: event.findingId, title: findingsById.get(event.findingId)?.title ?? event.findingId, fixedAt: event.at, survivedMs: Math.max(0, endedAtMs - fixedAtMs) };
    entries.push(endingEvent === undefined ? entry : { ...entry, regressedAt: endingEvent.at });
  }

  return entries.sort((a, b) => Date.parse(a.fixedAt) - Date.parse(b.fixedAt) || a.findingId.localeCompare(b.findingId));
}

function findSurvivalEndingEvent(events: MemoryEvent[], fixedIndex: number, findingId: string): MemoryEvent | undefined {
  for (let index = fixedIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === "finding.regressed" && event.findingId === findingId) {
      return event;
    }
    if (event.type === "finding.seen_again" && event.findingId === findingId) {
      return event;
    }
  }
  return undefined;
}

function computePerRunTimeline(events: MemoryEvent[], options: ComputeTrendsOptions): TrendsReport["perRunTimeline"] {
  const timelineEvents = filterTimelineEvents(events, options.atBucket);
  const boundaries = collectBoundaries(timelineEvents);
  const bucketsByRunId = new Map<string, TimelineBucket>();
  const statusesByFindingId = new Map<string, MemoryFinding["status"]>();

  for (const event of timelineEvents) {
    let bucket: TimelineBucket | undefined;
    switch (event.type) {
      case "finding.discovered":
        bucket = ensureTimelineBucket(bucketsByRunId, event.finding.origin.runId, event.at);
        bucket.introduced += 1;
        statusesByFindingId.set(event.finding.id, event.finding.status);
        break;
      case "finding.seen_again":
        bucket = ensureTimelineBucket(bucketsByRunId, event.runId, event.at);
        bucket.seenAgain += 1;
        break;
      case "finding.status_changed":
        bucket = ensureTimelineBucket(bucketsByRunId, selectStatusRunId(event.at, boundaries), event.at);
        bucket.statusChanged += 1;
        statusesByFindingId.set(event.findingId, event.to);
        break;
      case "finding.regressed":
        bucket = ensureTimelineBucket(bucketsByRunId, event.runId, event.at);
        bucket.regressed += 1;
        statusesByFindingId.set(event.findingId, event.toStatus);
        break;
      case "finding.related":
        continue;
    }
    if (bucket !== undefined) {
      bucket.totalActive = countActive(statusesByFindingId);
    }
  }

  return Array.from(bucketsByRunId.values())
    .sort((a, b) => Date.parse(a.firstAt) - Date.parse(b.firstAt) || a.order - b.order || a.runId.localeCompare(b.runId))
    .map(({ runId, introduced, seenAgain, statusChanged, regressed, totalActive }) => ({ runId, introduced, seenAgain, statusChanged, regressed, totalActive }));
}

function filterTimelineEvents(events: MemoryEvent[], atBucket: string): MemoryEvent[] {
  const bucketTime = Date.parse(atBucket);
  return Number.isFinite(bucketTime) ? events.filter((event) => Date.parse(event.at) <= bucketTime) : events;
}

function collectBoundaries(events: MemoryEvent[]): RunBoundary[] {
  const byRunId = new Map<string, RunBoundary>();
  for (const event of events) {
    const runId = directRunId(event);
    if (runId === undefined) {
      continue;
    }
    const boundary = { runId, at: event.at, order: byRunId.size };
    const existing = byRunId.get(runId);
    if (existing === undefined || compareBoundary(boundary, existing) < 0) {
      byRunId.set(runId, boundary);
    }
  }
  return Array.from(byRunId.values()).sort(compareBoundary);
}

function directRunId(event: MemoryEvent): string | undefined {
  switch (event.type) {
    case "finding.discovered":
      return event.finding.origin.runId;
    case "finding.seen_again":
    case "finding.regressed":
      return event.runId;
    case "finding.status_changed":
    case "finding.related":
      return undefined;
  }
}

export function selectStatusRunId(at: string, boundaries: RunBoundary[]): string {
  if (boundaries.length === 0) return MARK_RUN_ID;
  const atMs = Date.parse(at);
  let left = 0;
  let right = boundaries.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const boundary = boundaries[mid];
    if (boundary === undefined) return MARK_RUN_ID;
    const boundaryMs = Date.parse(boundary.at);
    if (boundaryMs <= atMs) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  // Falling back to MARK_RUN_ID corrects the legacy boundaries[0].runId pre-boundary attribution bug.
  return boundaries[right]?.runId ?? MARK_RUN_ID;
}

function ensureTimelineBucket(
  bucketsByRunId: Map<string, TimelineBucket>,
  runId: string,
  at: string,
): TimelineBucket {
  const existing = bucketsByRunId.get(runId);
  if (existing !== undefined) {
    if (Date.parse(at) < Date.parse(existing.firstAt)) existing.firstAt = at;
    return existing;
  }

  const bucket = { runId, introduced: 0, seenAgain: 0, statusChanged: 0, regressed: 0, totalActive: 0, firstAt: at, order: bucketsByRunId.size };
  bucketsByRunId.set(runId, bucket);
  return bucket;
}

function countActive(statusesByFindingId: Map<string, MemoryFinding["status"]>): number {
  return Array.from(statusesByFindingId.values()).filter((status) => ACTIVE_STATUSES.has(status)).length;
}

function compareBoundary(a: RunBoundary, b: RunBoundary): number {
  return Date.parse(a.at) - Date.parse(b.at) || a.order - b.order || a.runId.localeCompare(b.runId);
}

function compareOptionalTimestampDescending(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) {
    return a === b ? 0 : a === undefined ? 1 : -1;
  }
  return Date.parse(b) - Date.parse(a);
}

function incrementCount<TKey>(counts: Map<TKey, number>, key: TKey): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

import { createEventBatchContext, nextEventId, readAllEventSegments, writeEventSegment } from "./events.js";
import { ensureMemoryDirs, resolveMemoryPaths } from "./paths.js";
import { MemoryEventSchema, normalizeMemoryStatus } from "./schema.js";
import {
  readMaterializedState,
  rebuildMaterializedStateFromEvents,
  writeMaterializedState,
} from "./store.js";

export interface MarkOptions {
  findingId: string;
  status: string;
  reason?: string;
  cwd?: string;
}

export interface MarkResult {
  success: boolean;
  findingId: string;
  previousStatus?: string;
  newStatus: string;
  eventId: string;
  segmentPath: string;
}

const MARK_RUN_ID = "omre-mark";
const MARK_MARKED_BY = "omre-cli";

/**
 * Allowed status transitions, keyed by the previous (current) status. Every
 * status may additionally transition to "stale" (the "any → stale" rule).
 */
const STATUS_TRANSITIONS: Record<string, string[]> = {
  open: ["confirmed", "fixed", "ignored", "false-positive"],
  confirmed: ["fixed", "ignored", "false-positive"],
  fixed: ["open"],
  ignored: [],
  "false-positive": [],
  stale: [],
};

function isValidTransition(prev: string, next: string): boolean {
  if (next === "stale") {
    return true;
  }
  return STATUS_TRANSITIONS[prev]?.includes(next) ?? false;
}

export function runMemoryMark(options: MarkOptions): MarkResult {
  const paths = resolveMemoryPaths(options.cwd ?? process.cwd());
  ensureMemoryDirs(paths);

  const state = readMaterializedState(paths);
  if (state === null) {
    throw new Error("no memory state found");
  }

  const finding = state.findings.find((candidate) => candidate.id === options.findingId);
  if (finding === undefined) {
    throw new Error(`finding not found: ${options.findingId}`);
  }

  const previousStatus = finding.status;
  const newStatus = normalizeMemoryStatus(options.status);

  if (!isValidTransition(previousStatus, newStatus)) {
    throw new Error(`invalid transition: ${previousStatus} → ${newStatus}`);
  }

  const batchCtx = createEventBatchContext(MARK_RUN_ID);
  const event = MemoryEventSchema.parse({
    type: "finding.status_changed",
    eventId: nextEventId(batchCtx),
    at: new Date().toISOString(),
    findingId: options.findingId,
    from: previousStatus,
    to: newStatus,
    markedBy: MARK_MARKED_BY,
  });

  const segment = writeEventSegment(paths, [event], MARK_RUN_ID);

  const { events } = readAllEventSegments(paths);
  const rebuilt = rebuildMaterializedStateFromEvents(events);
  writeMaterializedState(paths, rebuilt);

  return {
    success: true,
    findingId: options.findingId,
    previousStatus,
    newStatus,
    eventId: event.eventId,
    segmentPath: segment.segmentPath,
  };
}

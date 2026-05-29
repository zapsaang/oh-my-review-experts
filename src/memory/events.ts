import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { MemoryEventSchema, type MemoryEvent } from "./schema.js";
import type { MemoryPaths } from "./paths.js";

export interface EventBatchContext {
  runId: string;
  batchId: string;
  seqCounter: number;
  createdAt: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function generateBatchId(runId: string): string {
  return sha256(runId).slice(0, 16);
}

export function generateEventId(batchId: string, seq: number): string {
  const hash = sha256(`${batchId}:${seq}`);
  return `evt_${hash.slice(0, 24)}`;
}

export function createEventBatchContext(runId: string): EventBatchContext {
  const batchId = generateBatchId(runId);

  return {
    runId,
    batchId,
    seqCounter: 0,
    createdAt: new Date().toISOString(),
  };
}

export function nextEventId(ctx: EventBatchContext): string {
  const seq = ctx.seqCounter;
  ctx.seqCounter++;
  return generateEventId(ctx.batchId, seq);
}

export interface WriteEventSegmentResult {
  segmentPath: string;
  eventsWritten: number;
}

export function writeEventSegment(
  paths: MemoryPaths,
  events: MemoryEvent[],
  runId: string,
): WriteEventSegmentResult {
  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const pid = process.pid;
  const randomSuffix = randomBytes(4).toString("hex");
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${timestamp}-${pid}-${randomSuffix}-${safeRunId}.jsonl`;
  const segmentPath = path.join(paths.segmentsDir, filename);
  const lines = events.map((event) => JSON.stringify(event)).join("\n");

  fs.writeFileSync(segmentPath, `${lines}\n`, { encoding: "utf8", flag: "wx" });

  return { segmentPath, eventsWritten: events.length };
}

export function readAllEventSegments(paths: MemoryPaths): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  const dirs = [paths.segmentsDir, paths.compactedDir];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter((line) => line.trim() !== "");

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const result = MemoryEventSchema.safeParse(parsed);
          if (result.success) {
            events.push(result.data);
          } else if (process.env.NODE_ENV !== "production") {
            console.warn(`Skipped invalid event in ${filePath}:`, result.error.message);
          }
        } catch {
          if (process.env.NODE_ENV !== "production") {
            console.warn(`Skipped malformed JSON line in ${filePath}`);
          }
        }
      }
    }
  }

  return events.sort(compareMemoryEvents);
}

export function compareMemoryEvents(a: MemoryEvent, b: MemoryEvent): number {
  const atDiff = new Date(a.at).getTime() - new Date(b.at).getTime();
  if (atDiff !== 0) return atDiff;
  return a.eventId.localeCompare(b.eventId);
}

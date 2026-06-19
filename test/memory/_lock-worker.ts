/**
 * Fork worker for lock concurrency tests.
 * Receives an IPC message, performs the requested memory operation, sends result back.
 * Launched via: fork(path, [], { execArgv: ["--import", "tsx"] })
 */
import { runMemoryMark } from "../../src/memory/mark.js";
import { runIndexLatest } from "../../src/memory/cli.js";
import { resolveMemoryPaths, ensureMemoryDirs } from "../../src/memory/paths.js";
import { readMaterializedState } from "../../src/memory/store.js";
import { acquireMemoryLock, releaseMemoryLock } from "../../src/memory/lock.js";

interface WorkerMessage {
  op: "mark" | "read" | "acquireRelease" | "index";
  cwd: string;
  findingId?: string;
  status?: string;
  timeoutMs?: number;
  staleMs?: number;
  holdMs?: number;
  iterations?: number;
}

function isWorkerMessage(msg: unknown): msg is WorkerMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "op" in msg &&
    typeof (msg as Record<string, unknown>).op === "string" &&
    "cwd" in msg &&
    typeof (msg as Record<string, unknown>).cwd === "string"
  );
}

process.on("message", (msg: unknown) => {
  if (!isWorkerMessage(msg)) {
    process.send!({ error: "invalid message" });
    return;
  }

  try {
    const paths = resolveMemoryPaths(msg.cwd);
    ensureMemoryDirs(paths);

    switch (msg.op) {
      case "mark": {
        const result = runMemoryMark({
          cwd: msg.cwd,
          findingId: msg.findingId!,
          status: msg.status!,
        });
        process.send!({ result: { success: result.success, newStatus: result.newStatus } });
        break;
      }
      case "read": {
        const state = readMaterializedState(paths);
        process.send!({
          result: {
            findingsCount: state?.findings.length ?? 0,
            materializedHash: state?.manifest.materializedHash ?? null,
            isNull: state === null,
          },
        });
        break;
      }
      case "index": {
        process.chdir(msg.cwd);
        const result = runIndexLatest({
          cwd: msg.cwd,
          output: { log: () => undefined, error: () => undefined },
        });
        process.send!({
          result: {
            segmentPath: result.segmentPath ?? null,
            materializedFindings: result.materializedFindings ?? 0,
            eventsGenerated: result.eventsGenerated,
          },
        });
        break;
      }
      case "acquireRelease": {
        const iterations = msg.iterations ?? 1;
        for (let i = 0; i < iterations; i++) {
          const handle = acquireMemoryLock(paths, {
            timeoutMs: msg.timeoutMs ?? 10_000,
            staleMs: msg.staleMs ?? 60_000,
          });
          if (msg.holdMs && msg.holdMs > 0) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, msg.holdMs);
          }
          releaseMemoryLock(handle);
        }
        process.send!({ result: { released: true, iterations } });
        break;
      }
    }
  } catch (err: unknown) {
    process.send!({ error: err instanceof Error ? err.message : String(err) });
  }
});

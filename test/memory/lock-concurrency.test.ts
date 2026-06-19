import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAllEventSegments, writeEventSegment } from "../../src/memory/events.js";
import {
  rebuildMaterializedStateFromEvents,
  writeMaterializedState,
  readMaterializedState,
} from "../../src/memory/store.js";
import type { MemoryEvent, MemoryFinding } from "../../src/memory/schema.js";
import type { MemoryPaths } from "../../src/memory/paths.js";
import { makeTempRepo, writeFinding } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "_lock-worker.ts");
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const LATEST_FIXTURE_PATH = path.join(FIXTURES_DIR, "latest.json");
const HANDOFF_FIXTURE_PATH = path.join(FIXTURES_DIR, "handoff-sample.md");
const TIMESTAMP = "2026-05-28T00:00:00.000Z";

function repoCwd(paths: MemoryPaths): string {
  return paths.root.replace(/\/\.omre\/memory$/, "");
}

function seedReportFixture(cwd: string): void {
  const reportDir = path.join(cwd, ".omre", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "latest.json");
  fs.copyFileSync(LATEST_FIXTURE_PATH, reportPath);

  const runId = (JSON.parse(fs.readFileSync(reportPath, "utf8")) as { run_id?: string }).run_id;
  if (!runId) {
    throw new Error("latest.json fixture must include run_id");
  }

  const handoffDir = path.join(cwd, ".omre", "handoffs", runId);
  fs.mkdirSync(handoffDir, { recursive: true });
  fs.copyFileSync(HANDOFF_FIXTURE_PATH, path.join(handoffDir, "handoff-sample.md"));
}

function discoveredEvent(finding: MemoryFinding, eventId: string): MemoryEvent {
  return { type: "finding.discovered", eventId, at: TIMESTAMP, finding };
}

function seedFindings(paths: MemoryPaths, findings: MemoryFinding[]): void {
  const events = findings.map((finding, idx) =>
    discoveredEvent(finding, `evt_seed_discovered_${String(idx).padStart(4, "0")}`),
  );
  writeEventSegment(paths, events, "run-seed");
  const state = rebuildMaterializedStateFromEvents(events);
  writeMaterializedState(paths, state);
}

interface WorkerResult {
  result?: Record<string, unknown>;
  error?: string;
}

function runWorker(
  op: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER_PATH, [], {
      execArgv: ["--import", "tsx"],
      silent: true,
    });

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
      child.kill();
    };

    child.on("message", (msg: unknown) => {
      const m = (msg ?? {}) as WorkerResult;
      if (m.error !== undefined) {
        finish(() => reject(new Error(m.error)));
      } else {
        finish(() => resolve(m));
      }
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("exit", (code) => {
      if (!settled && code !== 0 && code !== null) {
        finish(() => reject(new Error(`worker exited with code ${code}`)));
      }
    });

    child.send({ op, cwd, ...extra });
  });
}

describe("memory lock concurrency", () => {
  let paths: MemoryPaths;

  beforeEach(() => {
    paths = makeTempRepo();
  });

  afterEach(() => {
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  // #1 — 10 concurrent runMemoryMark on distinct findings, no corruption.
  it(
    "10 concurrent runMemoryMark operations all succeed without corrupting state",
    async () => {
      const cwd = repoCwd(paths);
      const findings: MemoryFinding[] = [];
      for (let i = 0; i < 10; i++) {
        findings.push(
          writeFinding({ id: `mem_concurrentmark${String(i).padStart(4, "0")}`, status: "open" }),
        );
      }
      seedFindings(paths, findings);

      const results = await Promise.all(
        findings.map((finding) =>
          runWorker("mark", cwd, { findingId: finding.id, status: "fixed" }),
        ),
      );

      for (const r of results) {
        expect(r.error).toBeUndefined();
        expect(r.result?.success).toBe(true);
        expect(r.result?.newStatus).toBe("fixed");
      }

      // Final state is internally consistent: hash self-check passes (non-null),
      // all findings present, all transitioned to fixed.
      const finalState = readMaterializedState(paths);
      expect(finalState).not.toBeNull();
      expect(finalState!.findings.length).toBe(10);
      for (const finding of finalState!.findings) {
        expect(finding.status).toBe("fixed");
      }
    },
    30_000,
  );

  // #2 — concurrent runIndexLatest + runMemoryMark contend; both complete,
  // state intact, events = sum of both operations.
  it(
    "concurrent runIndexLatest + runMemoryMark produce complete, uncorrupted state",
    async () => {
      const cwd = repoCwd(paths);

      const seedFinding = writeFinding({ id: "mem_concurrentmarkseed", status: "open" });
      seedFindings(paths, [seedFinding]);

      // runIndexLatest only generates events when a report fixture exists.
      seedReportFixture(cwd);

      const baselineEvents = readAllEventSegments(paths).events.length;

      const [indexRes, markRes] = await Promise.all([
        runWorker("index", cwd),
        runWorker("mark", cwd, { findingId: "mem_concurrentmarkseed", status: "fixed" }),
      ]);

      expect(indexRes.error).toBeUndefined();
      expect(markRes.error).toBeUndefined();
      expect(markRes.result?.success).toBe(true);
      expect(markRes.result?.newStatus).toBe("fixed");
      expect((indexRes.result?.eventsGenerated as number)).toBeGreaterThan(0);

      // State is non-null — hash self-check passing means no corruption.
      const finalState = readMaterializedState(paths);
      expect(finalState).not.toBeNull();

      const marked = finalState!.findings.find((f) => f.id === "mem_concurrentmarkseed");
      expect(marked?.status).toBe("fixed");

      // Total events strictly increased beyond baseline (seed + index + mark).
      const finalEvents = readAllEventSegments(paths).events.length;
      const indexEventsGenerated = indexRes.result?.eventsGenerated as number;
      expect(finalEvents).toBeGreaterThanOrEqual(baselineEvents + indexEventsGenerated + 1);
    },
    30_000,
  );

  // #3 — lock-free reads stay stable while a writer mutates repeatedly.
  it(
    "lock-free reads remain stable during concurrent writes (null rate < 5%)",
    async () => {
      const cwd = repoCwd(paths);
      const finding = writeFinding({ id: "mem_readwhilewriting0", status: "open" });
      seedFindings(paths, [finding]);

      // Writer flips the finding open<->fixed repeatedly in the background.
      const writer = (async (): Promise<void> => {
        let status = "fixed";
        for (let i = 0; i < 8; i++) {
          await runWorker("mark", cwd, { findingId: finding.id, status });
          status = status === "fixed" ? "open" : "fixed";
        }
      })();

      // Main thread hammers reads concurrently.
      let nullCount = 0;
      let totalReads = 0;
      const readUntilWriterDone = (async (): Promise<void> => {
        let done = false;
        void writer.then(() => {
          done = true;
        });
        while (!done) {
          const state = readMaterializedState(paths);
          totalReads++;
          if (state === null) nullCount++;
          await new Promise((r) => setTimeout(r, 1));
        }
      })();

      await Promise.all([writer, readUntilWriterDone]);

      expect(totalReads).toBeGreaterThan(0);
      // Torn reads are caught by the hash self-check + retry; surviving nulls
      // must be rare.
      expect(nullCount / totalReads).toBeLessThan(0.05);
    },
    30_000,
  );

  // #4 — heavy lock churn from two workers, no deadlock or timeout.
  it(
    "two workers contending the lock 50x each complete without deadlock",
    async () => {
      const cwd = repoCwd(paths);

      const [resA, resB] = await Promise.all([
        runWorker("acquireRelease", cwd, { iterations: 50, holdMs: 5, timeoutMs: 20_000 }),
        runWorker("acquireRelease", cwd, { iterations: 50, holdMs: 5, timeoutMs: 20_000 }),
      ]);

      expect(resA.error).toBeUndefined();
      expect(resB.error).toBeUndefined();
      expect(resA.result?.released).toBe(true);
      expect(resA.result?.iterations).toBe(50);
      expect(resB.result?.released).toBe(true);
      expect(resB.result?.iterations).toBe(50);
    },
    30_000,
  );
});

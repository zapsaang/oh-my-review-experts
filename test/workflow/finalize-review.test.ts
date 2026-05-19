import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Local interfaces for the missing src/workflow/finalize-review.ts module.
// These keep the test file typecheck-clean without a static import.
// ---------------------------------------------------------------------------

interface FinalizeReviewInput {
  runId: string;
  cwd: string;
  trusted?: boolean;
}

interface DegradedSlice {
  slice_id: string;
  missing_dimensions: string[];
}

interface FinalizeReviewResult {
  written: string[];
  handoffsConsumed: number;
  degradedSlices: DegradedSlice[];
  missingDimensionsGlobal: string[];
}

// ---------------------------------------------------------------------------
// Dynamic import helper — uses a non-literal specifier so TypeScript does
// NOT attempt static module resolution of the missing file.
// ---------------------------------------------------------------------------

async function loadFinalizeReview(): Promise<{
  finalizeReview(input: FinalizeReviewInput): FinalizeReviewResult;
}> {
  const segments = ["..", "..", "src", "workflow", "finalize-review.js"];
  const modPath = segments.join("/");
  const mod = await import(modPath);
  return mod as unknown as {
    finalizeReview(input: FinalizeReviewInput): FinalizeReviewResult;
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function createTempProject(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-finalize-"));
  fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, ".omre", "config.json"),
    JSON.stringify({
      report: {
        enabled: true,
        directory: ".omre/reports",
        timestamped: true,
        latestMarkdown: "latest.md",
        latestJson: "latest.json",
      },
      handoff: {
        enabled: true,
        directory: ".omre/handoffs",
      },
    }),
    "utf8"
  );
  return tmpDir;
}

function buildHandoffJsonHeader(
  overrides: Record<string, unknown> = {}
): string {
  const base = {
    schema_version: "1",
    task_id: "task-123",
    agent: "reviewer-security",
    dimension: "security",
    status: "completed",
    target: { kind: "working-tree", value: "src/auth.ts" },
    slice_id: "slice-1",
    findings: [
      {
        id: "sec-1",
        severity: "critical",
        file: "src/auth.ts",
        line: 42,
        title: "Hardcoded secret",
        description: "API key is hardcoded in source",
        evidence: "const API_KEY = 'sk-...'",
        confidence: "high",
        classification: "injection",
      },
    ],
    meta: { total_findings: 1, notes: "" },
    ...overrides,
  };
  return "```json\n" + JSON.stringify(base, null, 2) + "\n```";
}

function writeHandoffFile(
  cwd: string,
  runId: string,
  filename: string,
  overrides: Record<string, unknown> = {}
): void {
  const handoffDir = path.join(cwd, ".omre", "handoffs", runId);
  fs.mkdirSync(handoffDir, { recursive: true });
  const content =
    buildHandoffJsonHeader(overrides) +
    "\n\n# Review Handoff\n\nTest body content for deterministic rendering.\n";
  fs.writeFileSync(path.join(handoffDir, filename), content, "utf8");
}

// ---------------------------------------------------------------------------
// RED tests — each will fail at runtime because src/workflow/finalize-review.ts
// does not exist yet (T7 implements it).
// ---------------------------------------------------------------------------

describe("finalizeReview [Fix 2-B RED]", () => {
  it("reads all handoff files in .omre/handoffs/{runId}/ and emits a markdown report >= 50 lines starting with '#'", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-20260519-test";
      writeHandoffFile(cwd, runId, "handoff-1.md", {
        agent: "reviewer-security",
        dimension: "security",
      });
      writeHandoffFile(cwd, runId, "handoff-2.md", {
        agent: "reviewer-quality",
        dimension: "quality",
      });

      const mod = await loadFinalizeReview();
      const result = mod.finalizeReview({ runId, cwd });

      const latestMd = fs.readFileSync(
        path.join(cwd, ".omre", "reports", "latest.md"),
        "utf8"
      );
      expect(latestMd.startsWith("#")).toBe(true);
      const nonBlankLines = latestMd
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(nonBlankLines.length).toBeGreaterThanOrEqual(50);

      expect(result.handoffsConsumed).toBe(2);
      expect(result.written.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("emits a JSON report with slices[].findings[] structure", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-20260519-json";
      writeHandoffFile(cwd, runId, "handoff-1.md");

      const mod = await loadFinalizeReview();
      mod.finalizeReview({ runId, cwd });

      const latestJsonPath = path.join(
        cwd,
        ".omre",
        "reports",
        "latest.json"
      );
      expect(fs.existsSync(latestJsonPath)).toBe(true);
      const jsonContent = fs.readFileSync(latestJsonPath, "utf8");
      const parsed = JSON.parse(jsonContent);
      expect(Array.isArray(parsed.slices)).toBe(true);
      expect(parsed.slices.length).toBeGreaterThan(0);
      expect(Array.isArray(parsed.slices[0].findings)).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is deterministic — same handoffs produce byte-identical markdown and JSON", async () => {
    const cwd1 = createTempProject();
    const cwd2 = createTempProject();
    try {
      const runId = "run-deterministic";
      const overrides = {
        agent: "reviewer-spec",
        dimension: "spec",
      };
      writeHandoffFile(cwd1, runId, "handoff-1.md", overrides);
      writeHandoffFile(cwd2, runId, "handoff-1.md", overrides);

      const mod = await loadFinalizeReview();
      mod.finalizeReview({ runId, cwd: cwd1 });
      mod.finalizeReview({ runId, cwd: cwd2 });

      const md1 = fs.readFileSync(
        path.join(cwd1, ".omre", "reports", "latest.md"),
        "utf8"
      );
      const md2 = fs.readFileSync(
        path.join(cwd2, ".omre", "reports", "latest.md"),
        "utf8"
      );
      expect(md1).toBe(md2);

      const json1 = fs.readFileSync(
        path.join(cwd1, ".omre", "reports", "latest.json"),
        "utf8"
      );
      const json2 = fs.readFileSync(
        path.join(cwd2, ".omre", "reports", "latest.json"),
        "utf8"
      );
      expect(json1).toBe(json2);
    } finally {
      fs.rmSync(cwd1, { recursive: true, force: true });
      fs.rmSync(cwd2, { recursive: true, force: true });
    }
  });

  it("surfaces degraded coverage when handoffs declare missing dimensions", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-degraded";
      writeHandoffFile(cwd, runId, "handoff-1.md", {
        agent: "reviewer-performance",
        dimension: "performance",
        meta: {
          total_findings: 0,
          notes: "Degraded: missing dimensions concurrency, security",
        },
      });

      const mod = await loadFinalizeReview();
      const result = mod.finalizeReview({ runId, cwd });

      expect(result.degradedSlices.length).toBeGreaterThan(0);
      expect(result.missingDimensionsGlobal.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("throws when runId path resolves outside cwd (path traversal)", async () => {
    const cwd = createTempProject();
    try {
      const mod = await loadFinalizeReview();
      expect(() =>
        mod.finalizeReview({ runId: "../../etc/passwd", cwd })
      ).toThrow();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("throws when handoff dir is empty", async () => {
    const cwd = createTempProject();
    try {
      const runId = "run-empty";
      fs.mkdirSync(path.join(cwd, ".omre", "handoffs", runId), {
        recursive: true,
      });

      const mod = await loadFinalizeReview();
      expect(() => mod.finalizeReview({ runId, cwd })).toThrow();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

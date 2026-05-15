import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ToolContext } from "@opencode-ai/plugin";
import { Effect } from "effect";
import { z } from "zod";
import { tools, HandoffFindingSchema } from "../../src/tools/plugin-tools.js";

function mockContext(directory: string): ToolContext {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: () => Effect.void as unknown as ReturnType<ToolContext["ask"]>,
  };
}

function parseToolArgs<T extends z.ZodRawShape>(
  tool: { args: T },
  raw: unknown
): z.infer<z.ZodObject<T>> {
  const schema = z.object(tool.args);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Tool args schema rejected input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
    );
  }
  return parsed.data;
}

describe("plugin tools", () => {
  it("exports required tools", () => {
    expect(tools.omre_build_review_code_prompt).toBeDefined();
    expect(tools.omre_write_report).toBeDefined();
    expect(tools.omre_dry_run).toBeDefined();
    expect(tools.omre_config).toBeDefined();
  });

  it("omre_dry_run returns markdown", async () => {
    const result = await tools.omre_dry_run.execute({ args: "", cwd: process.cwd() }, mockContext(process.cwd()));
    expect(result).toContain("Review Code Dry Run");
  });

  it("omre_config loads default config", async () => {
    const result = await tools.omre_config.execute({ cwd: process.cwd() }, mockContext(process.cwd()));
    const config = JSON.parse(result as string);
    expect(config.enabled).toBe(true);
    expect(config.command.name).toBe("review-code");
  });

  it("omre_config uses context.directory when cwd is omitted", async () => {
    const result = await tools.omre_config.execute({}, mockContext(process.cwd()));
    const config = JSON.parse(result as string);
    expect(config.enabled).toBe(true);
    expect(config.command.name).toBe("review-code");
  });

  it("omre_dry_run uses context.directory when cwd is omitted", async () => {
    const result = await tools.omre_dry_run.execute({}, mockContext(process.cwd()));
    expect(result).toContain("Review Code Dry Run");
  });

  it("omre_validate_handoff rejects files outside project directory", async () => {
    const input = parseToolArgs(tools.omre_validate_handoff, { filePath: "/etc/passwd" });
    await expect(
      tools.omre_validate_handoff.execute(input, mockContext(process.cwd()))
    ).rejects.toThrow("Path traversal blocked");
  });

  it("omre_write_report accepts structured JSON payload", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-report-test-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".omre", "config.json"),
        JSON.stringify({ report: { enabled: true, directory: ".omre/reports" } }),
        "utf8"
      );

      const input = parseToolArgs(tools.omre_write_report, {
        markdown: "# Test",
        json: { summary: "test" },
      });
      const result = await tools.omre_write_report.execute(input, mockContext(tmpDir));
      const parsed = JSON.parse(result as string);
      expect(parsed.written).toBeDefined();
      expect(parsed.written.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("omre_build_review_code_prompt uses context.directory when cwd is omitted", async () => {
    const result = await tools.omre_build_review_code_prompt.execute(
      {},
      mockContext(process.cwd())
    );
    const parsed = JSON.parse(result as string);
    expect(parsed.prompt).toBeDefined();
    expect(typeof parsed.estimatedTasks).toBe("number");
  });

  it("omre_write_handoff uses context.directory when cwd is omitted", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-handoff-test-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".omre", "config.json"),
        JSON.stringify({ handoff: { enabled: true, directory: ".omre/handoffs" } }),
        "utf8"
      );

      const payload = {
        schema_version: "1.0",
        task_id: "test-1",
        agent: "spec",
        dimension: "spec",
        status: "completed" as const,
        target: { kind: "slice" as const, value: "test" },
        slice_id: "slice-1",
        findings: [],
      };

      const input = parseToolArgs(tools.omre_write_handoff, { payload });
      const result = await tools.omre_write_handoff.execute(input, mockContext(tmpDir));
      const parsed = JSON.parse(result as string);
      expect(parsed.filePath).toContain(".omre/handoffs");
      expect(fs.existsSync(parsed.filePath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("omre_validate_handoff blocks path traversal to external paths", async () => {
    const input = parseToolArgs(tools.omre_validate_handoff, { filePath: "../outside-project.json" });
    await expect(
      tools.omre_validate_handoff.execute(input, mockContext(process.cwd()))
    ).rejects.toThrow("Path traversal blocked");
  });

  it("omre_validate_handoff resolves successfully with relative cwd", async () => {
    const handoffFile = path.join(process.cwd(), "test-handoff-temp.md");
    fs.writeFileSync(
      handoffFile,
      '```json\n{"schema_version":"1","task_id":"","agent":"test","dimension":"spec","status":"completed","target":{"kind":"working-tree","value":""},"slice_id":"whole-target","findings":[],"meta":{"total_findings":0,"notes":""}}\n```\n\n# Test\n',
      "utf8"
    );
    try {
      const input = parseToolArgs(tools.omre_validate_handoff, {
        filePath: "test-handoff-temp.md",
        cwd: ".",
      });
      const result = await tools.omre_validate_handoff.execute(input, mockContext(process.cwd()));
      const parsed = JSON.parse(result as string);
      expect(parsed.isValid).toBe(true);
    } finally {
      fs.unlinkSync(handoffFile);
    }
  });

  it("omre_validate_handoff rejects malicious absolute cwd outside workspace", async () => {
    const input = parseToolArgs(tools.omre_validate_handoff, {
      filePath: "passwd",
      cwd: "/etc",
    });
    await expect(
      tools.omre_validate_handoff.execute(input, mockContext(process.cwd()))
    ).rejects.toThrow("Path traversal blocked");
  });

  it("omre_write_handoff writes findings with extra fields and missing optionals", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-handoff-findings-test-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".omre", "config.json"),
        JSON.stringify({ handoff: { enabled: true, directory: ".omre/handoffs" } }),
        "utf8"
      );

      const payload = {
        agent: "spec",
        dimension: "spec",
        status: "completed" as const,
        findings: [
          {
            id: "f1",
            severity: "high",
            title: "Bug",
            description: "Found a bug",
            evidence: "Line 42",
            confidence: "high",
            classification: "bug",
            extraField: "should be allowed",
          },
        ],
      };

      const input = parseToolArgs(tools.omre_write_handoff, { payload });
      const result = await tools.omre_write_handoff.execute(input, mockContext(tmpDir));
      const parsed = JSON.parse(result as string);
      expect(parsed.filePath).toContain(".omre/handoffs");
      expect(fs.existsSync(parsed.filePath)).toBe(true);

      const content = fs.readFileSync(parsed.filePath, "utf8");
      expect(content).toContain("Bug");
      expect(content).toContain("Found a bug");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("omre_write_handoff followed by validate_handoff round-trip", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-roundtrip-test-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".omre", "config.json"),
        JSON.stringify({ handoff: { enabled: true, directory: ".omre/handoffs" } }),
        "utf8"
      );

      const payload = {
        agent: "security",
        dimension: "security",
        status: "completed" as const,
        findings: [
          {
            id: "sec-1",
            severity: "high",
            title: "SQL Injection",
            description: "Unparameterized query",
            evidence: "Line 15: db.query(req.body.id)",
            confidence: "high",
            classification: "injection",
          },
        ],
      };

      const writeInput = parseToolArgs(tools.omre_write_handoff, { payload });
      const writeResult = await tools.omre_write_handoff.execute(writeInput, mockContext(tmpDir));
      const writeParsed = JSON.parse(writeResult as string);
      const handoffPath = writeParsed.filePath;
      expect(fs.existsSync(handoffPath)).toBe(true);

      const validateInput = parseToolArgs(tools.omre_validate_handoff, { filePath: handoffPath });
      const validateResult = await tools.omre_validate_handoff.execute(validateInput, mockContext(tmpDir));
      const validateParsed = JSON.parse(validateResult as string);
      expect(validateParsed.isValid).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("HandoffFindingSchema preserves unknown fields via safeParse", () => {
    const validFinding = {
      id: "f1",
      severity: "high",
      title: "Bug",
      description: "Found a bug",
      evidence: "Line 42",
      confidence: "high",
      classification: "bug",
      extraField: "should be preserved",
      anotherUnknown: 42,
    };
    const result = HandoffFindingSchema.safeParse(validFinding);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).extraField).toBe("should be preserved");
      expect((result.data as Record<string, unknown>).anotherUnknown).toBe(42);
    }
  });

  it("tool args are correctly inferred at call site", async () => {
    const result = await tools.omre_config.execute({ cwd: "." }, mockContext(process.cwd()));
    expect(typeof result).toBe("string");
  });
});

import pluginModule from "../../src/index.js";
const OhMyReviewExperts = pluginModule.server;

function stubPluginInput(directory: string) {
  return {
    client: {},
    project: {},
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: {},
  } as unknown as Parameters<typeof OhMyReviewExperts>[0];
}

describe("plugin factory integration", () => {
  it("returns Hooks object with command.execute.before", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    expect(typeof hooks["command.execute.before"]).toBe("function");
  });

  it("does not include legacy name property", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    expect((hooks as Record<string, unknown>).name).toBeUndefined();
  });
});

function buildHandoffJson(overrides: Record<string, unknown> = {}): string {
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
        description: "API key is hardcoded",
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

function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omre-handoff-"));
  return fn(tmp).finally(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      void 0;
    }
  });
}

describe("omre_validate_handoff chat fallback", () => {
  it("returns source=file when filePath validates", async () => {
    await withTempCwd(async (cwd) => {
      const filePath = path.join(cwd, "handoff.md");
      fs.writeFileSync(filePath, buildHandoffJson(), "utf-8");

      const args = parseToolArgs(tools.omre_validate_handoff, {
        filePath,
        cwd,
      });
      const result = await tools.omre_validate_handoff.execute(args, mockContext(cwd));
      const parsed = JSON.parse(result as string);

      expect(parsed.isValid).toBe(true);
      expect(parsed.source).toBe("file");
    });
  });

  it("falls back to chatContent when file is missing", async () => {
    await withTempCwd(async (cwd) => {
      const args = parseToolArgs(tools.omre_validate_handoff, {
        filePath: path.join(cwd, "does-not-exist.md"),
        chatContent: buildHandoffJson(),
        cwd,
      });
      const result = await tools.omre_validate_handoff.execute(args, mockContext(cwd));
      const parsed = JSON.parse(result as string);

      expect(parsed.isValid).toBe(true);
      expect(parsed.source).toBe("chat");
    });
  });

  it("prefers file when both file and chat are valid", async () => {
    await withTempCwd(async (cwd) => {
      const filePath = path.join(cwd, "handoff.md");
      fs.writeFileSync(filePath, buildHandoffJson({ task_id: "from-file" }), "utf-8");

      const args = parseToolArgs(tools.omre_validate_handoff, {
        filePath,
        chatContent: buildHandoffJson({ task_id: "from-chat" }),
        cwd,
      });
      const result = await tools.omre_validate_handoff.execute(args, mockContext(cwd));
      const parsed = JSON.parse(result as string);

      expect(parsed.isValid).toBe(true);
      expect(parsed.source).toBe("file");
      expect(parsed.normalized.task_id).toBe("from-file");
    });
  });

  it("returns isValid=false with source=none when both file and chat fail", async () => {
    await withTempCwd(async (cwd) => {
      const args = parseToolArgs(tools.omre_validate_handoff, {
        filePath: path.join(cwd, "does-not-exist.md"),
        chatContent: "no fence here, just prose",
        cwd,
      });
      const result = await tools.omre_validate_handoff.execute(args, mockContext(cwd));
      const parsed = JSON.parse(result as string);

      expect(parsed.isValid).toBe(false);
      expect(parsed.source).toBe("none");
      expect(parsed.retryRecommended).toBe(true);
    });
  });

  it("works with chatContent only (no filePath provided)", async () => {
    await withTempCwd(async (cwd) => {
      const args = parseToolArgs(tools.omre_validate_handoff, {
        chatContent: buildHandoffJson(),
        cwd,
      });
      const result = await tools.omre_validate_handoff.execute(args, mockContext(cwd));
      const parsed = JSON.parse(result as string);

      expect(parsed.isValid).toBe(true);
      expect(parsed.source).toBe("chat");
    });
  });

  it("returns retryRecommended when neither filePath nor chatContent is provided", async () => {
    await withTempCwd(async (cwd) => {
      const args = parseToolArgs(tools.omre_validate_handoff, { cwd });
      const result = await tools.omre_validate_handoff.execute(args, mockContext(cwd));
      const parsed = JSON.parse(result as string);

      expect(parsed.isValid).toBe(false);
      expect(parsed.source).toBe("none");
      expect(parsed.retryRecommended).toBe(true);
    });
  });

  it("preserves a fence located beyond the prefix truncation limit (smart truncation)", async () => {
    await withTempCwd(async (cwd) => {
      const handoffJson = buildHandoffJson({ task_id: "near-boundary" });
      const padding = "x".repeat(52_000);
      const chatContent = padding + "\n\n" + handoffJson;

      const args = parseToolArgs(tools.omre_validate_handoff, {
        chatContent,
        cwd,
      });
      const result = await tools.omre_validate_handoff.execute(args, mockContext(cwd));
      const parsed = JSON.parse(result as string);

      expect(parsed.isValid).toBe(true);
      expect(parsed.source).toBe("chat");
      expect(parsed.normalized.task_id).toBe("near-boundary");
    });
  });

  it("truncates safely when fence body exceeds the limit and reports failure", async () => {
    await withTempCwd(async (cwd) => {
      const giantFiller = "y".repeat(60_000);
      const chatContent = "```json\n{ \"schema_version\": \"1\", \"junk\": \"" + giantFiller + "\"\n```";

      const args = parseToolArgs(tools.omre_validate_handoff, {
        chatContent,
        cwd,
      });
      const result = await tools.omre_validate_handoff.execute(args, mockContext(cwd));
      const parsed = JSON.parse(result as string);

      expect(parsed.isValid).toBe(false);
      expect(parsed.source).toBe("none");
    });
  });
});

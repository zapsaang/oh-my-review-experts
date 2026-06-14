import fs from "node:fs";
import path from "node:path";
import type { OmreConfig } from "../config/schema.js";
import { assertSafePath, writeFileAtomic, formatTimestamp } from "./fs-utils.js";
import { redactSecrets } from "./secret-scanner.js";
import { SCHEMA_VERSION, type ConfidenceLevel, type SeverityLevel } from "../agents/schemas.js";

export interface HandoffPayload {
  schemaVersion?: string;
  taskId?: string;
  agent: string;
  dimension: string;
  scope?: string;
  status: "completed" | "blocked";
  target?: { kind: string; value: string };
  sliceId?: string;
  filesInspected?: string[];
  findings: HandoffFinding[];
  suggestedFixes?: string[];
  openQuestions?: string[];
  notesForPrimary?: string;
}

export interface HandoffFinding {
  id: string;
  severity: SeverityLevel;
  file?: string;
  line?: number | string;
  title: string;
  description: string;
  evidence: string;
  confidence: ConfidenceLevel;
  classification: string;
  category?: string;
  impact?: string;
  recommendation?: string;
  memoryRefs?: string[];
  isRegression?: boolean;
  regressionReason?: string;
}

function buildJsonHeader(payload: HandoffPayload, resolvedTaskId: string): Record<string, unknown> {
  return {
    schema_version: payload.schemaVersion ?? SCHEMA_VERSION,
    task_id: resolvedTaskId,
    agent: payload.agent,
    dimension: payload.dimension,
    status: payload.status,
    target: payload.target ?? { kind: "working-tree", value: payload.scope ?? "" },
    slice_id: payload.sliceId ?? "whole-target",
    findings: payload.findings.map((f) => {
      const base: Record<string, unknown> = {
        id: f.id,
        severity: f.severity,
        file: f.file ?? "N/A",
        line: f.line ?? "N/A",
        title: redactSecrets(f.title),
        description: redactSecrets(f.description),
        evidence: redactSecrets(f.evidence),
        confidence: f.confidence,
        classification: f.classification,
      };
      if (f.category !== undefined) base.category = redactSecrets(f.category);
      if (f.impact !== undefined) base.impact = redactSecrets(f.impact);
      if (f.recommendation !== undefined) base.recommendation = redactSecrets(f.recommendation);
      if (f.memoryRefs !== undefined) base.memoryRefs = f.memoryRefs;
      if (f.isRegression !== undefined) base.isRegression = f.isRegression;
      if (f.regressionReason !== undefined) base.regressionReason = redactSecrets(f.regressionReason);
      return base;
    }),
    meta: {
      total_findings: payload.findings.length,
      notes: payload.notesForPrimary ? redactSecrets(payload.notesForPrimary) : "",
    },
  };
}

function formatHandoffMarkdown(payload: HandoffPayload, resolvedTaskId: string): string {
  const timestamp = new Date().toISOString();

  const jsonHeader = buildJsonHeader(payload, resolvedTaskId);
  const jsonBlock = `\`\`\`json\n${JSON.stringify(jsonHeader, null, 2)}\n\`\`\``;

  const findingsSection =
    payload.findings.length > 0
      ? payload.findings
          .map(
            (f, i) => `### Finding ${i + 1}

- Severity: ${f.severity}
- Category: ${f.category ?? f.classification}
- File: ${f.file ?? "N/A"}
- Lines: ${f.line ?? "N/A"}
- Evidence: ${f.evidence}
- Impact: ${f.impact ?? f.description}
- Recommendation: ${f.recommendation ?? ""}`,
          )
          .join("\n\n")
      : "No findings.";

  const suggestedFixesSection =
    payload.suggestedFixes && payload.suggestedFixes.length > 0
      ? payload.suggestedFixes.map((fix) => `- ${fix}`).join("\n")
      : "None.";

  const openQuestionsSection =
    payload.openQuestions && payload.openQuestions.length > 0
      ? payload.openQuestions.map((q) => `- ${q}`).join("\n")
      : "None.";

  const markdownBody = `# Review Handoff

## Metadata

- Agent: ${payload.agent}
- Scope: ${payload.scope ?? payload.dimension}
- Timestamp: ${timestamp}
- Status: ${payload.status}
- Confidence: ${payload.findings.length > 0 ? payload.findings[0].confidence : "high"}

## Files Inspected

${(payload.filesInspected ?? []).map((f) => `- \`${f}\``).join("\n") || "- N/A"}

## Findings

${findingsSection}

## Suggested Fixes

${suggestedFixesSection}

## Open Questions

${openQuestionsSection}

## Notes for Primary Agent

${payload.notesForPrimary ?? "None."}
`;

  return `${jsonBlock}\n\n${redactSecrets(markdownBody)}`;
}

export function writeHandoff(
  config: OmreConfig,
  payload: HandoffPayload,
  cwd = process.cwd(),
  runId?: string,
): { filePath: string; taskId: string } {
  if (!config.handoff.enabled) {
    throw new Error("Handoff protocol is disabled in config.");
  }

  const resolvedCwd = path.resolve(cwd);
  let dir = path.resolve(resolvedCwd, config.handoff.directory);
  if (runId) {
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "-");
    dir = path.join(dir, safeRunId);
  }

  assertSafePath(dir, resolvedCwd, "handoff.directory");
  fs.mkdirSync(dir, { recursive: true });

  // Scope truncation keeps total filename under ~90 chars:
  // timestamp(19) + "-" + agent(≤20) + "-" + scope(35) + ".md"(3) + separators(2) ≈ 80.
  // POSIX NAME_MAX is 255; this leaves generous headroom.
  const MAX_SCOPE_LENGTH = 35;
  const ts = formatTimestamp();
  const safeAgentName = payload.agent.replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeScope = (payload.scope ?? payload.dimension)
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, MAX_SCOPE_LENGTH);
  const filename = `${ts}-${safeAgentName}-${safeScope}.md`;
  const filePath = path.join(dir, filename);

  const resolvedTaskId =
    payload.taskId !== undefined && payload.taskId.length > 0
      ? payload.taskId
      : generateTaskId(runId, payload.agent, ts);

  const content = formatHandoffMarkdown(payload, resolvedTaskId);
  const writtenPath = writeFileAtomic(filePath, content);

  return { filePath: writtenPath, taskId: resolvedTaskId };
}

const TASK_ID_COUNTERS = new Map<string, number>();
const TASK_ID_RUN_SENTINEL = "no-run";

/**
 * Generates a deterministic, per-process taskId of the shape
 * `<runId>-<timestamp>-<agent>-<3-digit-counter>`. Used by `writeHandoff` when
 * the caller omits `taskId`. The counter increments per (runId, agent) tuple
 * inside the process; concurrent writers in the same review run get distinct
 * IDs without coordination across processes (each review run is one process).
 */
export function generateTaskId(runId: string | undefined, agent: string, timestamp: string): string {
  const safeRunId = (runId && runId.length > 0 ? runId : TASK_ID_RUN_SENTINEL).replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeAgent = agent.replace(/[^a-zA-Z0-9_-]/g, "-");
  const key = `${safeRunId}\u0000${safeAgent}`;
  const next = (TASK_ID_COUNTERS.get(key) ?? 0) + 1;
  TASK_ID_COUNTERS.set(key, next);
  const counter = String(next).padStart(3, "0");
  return `${safeRunId}-${timestamp}-${safeAgent}-${counter}`;
}

const MAX_HANDOFF_SIZE = 10 * 1024 * 1024;
const SAFE_HANDOFF_FILENAME = /^[a-zA-Z0-9_\-\.]+\.md$/;

export interface HandoffJsonHeaderResult {
  success: boolean;
  data: unknown | null;
  error: string | null;
}

/**
 * Parses the raw JSON fence at the top of a handoff markdown file.
 *
 * This function is a **raw JSON fence parser only** — it does NOT validate
 * schema_version. Version enforcement is intentionally delegated to
 * validateReviewerHandoff (src/workflow/validate-result.ts), which calls
 * validateSchemaVersion immediately after parsing. This separation keeps
 * the parser simple and allows the validator to apply consistent policy
 * across all handoff consumers.
 */
export function parseHandoffJsonHeader(content: string): HandoffJsonHeaderResult {
  const stripped = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const normalized = stripped.replace(/\r\n/g, "\n");
  const trimmed = normalized.trimStart();

  if (!trimmed.startsWith("```json")) {
    return { success: false, data: null, error: "JSON header missing: handoff does not start with ```json fence" };
  }

  const afterFenceOpen = trimmed.slice(7);
  const fenceEnd = afterFenceOpen.indexOf("\n```");
  if (fenceEnd === -1) {
    return { success: false, data: null, error: "JSON header malformed: closing fence not found" };
  }

  const jsonBlock = afterFenceOpen.slice(0, fenceEnd).trim();
  if (jsonBlock.length === 0) {
    return { success: false, data: null, error: "JSON header empty: no content inside fence" };
  }

  try {
    const parsed = JSON.parse(jsonBlock);
    return { success: true, data: parsed, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { success: false, data: null, error: `JSON parse error: ${message}` };
  }
}

export function readHandoffs(
  config: OmreConfig,
  cwd = process.cwd(),
  runId?: string,
): { filePath: string; content: string }[] {
  if (!config.handoff.enabled) {
    return [];
  }

  const resolvedCwd = path.resolve(cwd);
  let dir = path.resolve(resolvedCwd, config.handoff.directory);
  if (runId) {
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "-");
    dir = path.join(dir, safeRunId);
  }

  assertSafePath(dir, resolvedCwd, "handoff.directory");

  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir);
  const handoffs: { filePath: string; content: string }[] = [];

  for (const entry of entries) {
    if (!SAFE_HANDOFF_FILENAME.test(entry)) {
      continue;
    }
    const filePath = path.join(dir, entry);
    const lstat = fs.lstatSync(filePath);
    if (!lstat.isFile() || lstat.isSymbolicLink()) {
      continue;
    }
    if (lstat.size > MAX_HANDOFF_SIZE) {
      continue;
    }
    const content = fs.readFileSync(filePath, "utf8");
    handoffs.push({ filePath, content });
  }

  return handoffs.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

import fs from "node:fs";
import path from "node:path";
import type { OmreConfig } from "../config/schema.js";
import { assertSafePath, writeFileAtomic, formatTimestamp } from "./fs-utils.js";
import { redactSecrets } from "./secret-scanner.js";
import { SCHEMA_VERSION } from "../agents/schemas.js";

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
  severity: "critical" | "high" | "medium" | "low";
  file?: string;
  line?: number | string;
  title: string;
  description: string;
  evidence: string;
  confidence: "high" | "medium" | "low";
  classification: string;
  category?: string;
  impact?: string;
  recommendation?: string;
}

function buildJsonHeader(payload: HandoffPayload): Record<string, unknown> {
  return {
    schema_version: payload.schemaVersion ?? SCHEMA_VERSION,
    task_id: payload.taskId ?? "",
    agent: payload.agent,
    dimension: payload.dimension,
    status: payload.status,
    target: payload.target ?? { kind: "working-tree", value: payload.scope ?? "" },
    slice_id: payload.sliceId ?? "whole-target",
    findings: payload.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      file: f.file ?? "N/A",
      line: f.line ?? "N/A",
      title: redactSecrets(f.title),
      description: redactSecrets(f.description),
      evidence: redactSecrets(f.evidence),
      confidence: f.confidence,
      classification: f.classification,
    })),
    meta: {
      total_findings: payload.findings.length,
      notes: payload.notesForPrimary ? redactSecrets(payload.notesForPrimary) : "",
    },
  };
}

function formatHandoffMarkdown(payload: HandoffPayload): string {
  const timestamp = new Date().toISOString();

  const jsonHeader = buildJsonHeader(payload);
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
): string {
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

  const ts = formatTimestamp();
  const safeAgentName = payload.agent.replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeScope = (payload.scope ?? payload.dimension).replace(/[^a-zA-Z0-9_-]/g, "-");
  const filename = `${ts}-${safeAgentName}-${safeScope}.md`;
  const filePath = path.join(dir, filename);

  const content = formatHandoffMarkdown(payload);
  const writtenPath = writeFileAtomic(filePath, content);

  return writtenPath;
}

const MAX_HANDOFF_SIZE = 10 * 1024 * 1024;
const SAFE_HANDOFF_FILENAME = /^[a-zA-Z0-9_\-\.]+\.md$/;

export interface HandoffJsonHeaderResult {
  success: boolean;
  data: unknown | null;
  error: string | null;
}

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

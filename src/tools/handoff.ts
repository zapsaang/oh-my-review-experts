import fs from "node:fs";
import path from "node:path";
import type { OmreConfig } from "../config/schema.js";
import { assertSafePath, writeFileAtomic, formatTimestamp } from "./fs-utils.js";
import { redactSecrets } from "./secret-scanner.js";

export interface HandoffPayload {
  agentName: string;
  scope: string;
  status: "completed" | "blocked";
  confidence: "high" | "medium" | "low";
  filesInspected: string[];
  findings: HandoffFinding[];
  suggestedFixes?: string[];
  openQuestions?: string[];
  notesForPrimary?: string;
}

export interface HandoffFinding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  file?: string;
  lines?: string;
  evidence: string;
  impact: string;
  recommendation: string;
}

function formatHandoffMarkdown(payload: HandoffPayload): string {
  const timestamp = new Date().toISOString();

  const findingsSection = payload.findings.length > 0
    ? payload.findings.map((f, i) => `### Finding ${i + 1}

- Severity: ${f.severity}
- Category: ${f.category}
- File: ${f.file || "N/A"}
- Lines: ${f.lines || "N/A"}
- Evidence: ${f.evidence}
- Impact: ${f.impact}
- Recommendation: ${f.recommendation}`).join("\n\n")
    : "No findings.";

  const suggestedFixesSection = payload.suggestedFixes && payload.suggestedFixes.length > 0
    ? payload.suggestedFixes.map((fix) => `- ${fix}`).join("\n")
    : "None.";

  const openQuestionsSection = payload.openQuestions && payload.openQuestions.length > 0
    ? payload.openQuestions.map((q) => `- ${q}`).join("\n")
    : "None.";

  return `# Review Handoff

## Metadata

- Agent: ${payload.agentName}
- Scope: ${payload.scope}
- Timestamp: ${timestamp}
- Status: ${payload.status}
- Confidence: ${payload.confidence}

## Files Inspected

${payload.filesInspected.map((f) => `- \`${f}\``).join("\n") || "- N/A"}

## Findings

${findingsSection}

## Suggested Fixes

${suggestedFixesSection}

## Open Questions

${openQuestionsSection}

## Notes for Primary Agent

${payload.notesForPrimary || "None."}
`;
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
  const safeAgentName = payload.agentName.replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeScope = payload.scope.replace(/[^a-zA-Z0-9_-]/g, "-");
  const filename = `${ts}-${safeAgentName}-${safeScope}.md`;
  const filePath = path.join(dir, filename);

  const markdown = formatHandoffMarkdown(payload);
  const redactedMarkdown = redactSecrets(markdown);
  const writtenPath = writeFileAtomic(filePath, redactedMarkdown);

  return writtenPath;
}

const MAX_HANDOFF_SIZE = 10 * 1024 * 1024;
const SAFE_HANDOFF_FILENAME = /^[a-zA-Z0-9_\-\.]+\.md$/;

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

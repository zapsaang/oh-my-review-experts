import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RawFinding, RawLocation } from "./types.js";

interface MarkdownFinding {
  title: string;
  fields: Record<string, string>;
}

export function extractFromHandoffs(handoffDir: string): RawFinding[] {
  let fileNames: string[];

  try {
    fileNames = readdirSync(handoffDir);
  } catch (error) {
    warnSkip(handoffDir, "list handoff directory", error);
    return [];
  }

  return fileNames
    .filter((fileName) => fileName.endsWith(".md"))
    .sort()
    .flatMap((fileName) => extractFromFile(join(handoffDir, fileName)));
}

function extractFromFile(sourcePath: string): RawFinding[] {
  let content: string;

  try {
    content = readFileSync(sourcePath, "utf8");
  } catch (error) {
    warnSkip(sourcePath, "read handoff file", error);
    return [];
  }

  const header = parseJsonHeader(content, sourcePath);
  const markdownFindings = parseMarkdownFindings(content);

  if (!header && markdownFindings.length === 0) {
    return [];
  }

  const reviewer = stringValue(header?.agent);
  if (!reviewer) {
    return [];
  }

  const structuredFindings = Array.isArray(header?.findings) ? header.findings : [];
  if (structuredFindings.length === 0) {
    return markdownFindings.flatMap((finding) => normalizeMarkdownFinding(finding, reviewer) ?? []);
  }

  return structuredFindings.flatMap(
    (finding, index) => normalizeStructuredFinding(finding, reviewer, markdownFindings[index]) ?? [],
  );
}

function parseJsonHeader(content: string, sourcePath: string): Record<string, unknown> | undefined {
  const match = /^\uFEFF?\s*```json\s*\r?\n([\s\S]*?)\r?\n```/.exec(content);
  if (!match) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[1] ?? "");
    return recordValue(parsed);
  } catch (error) {
    warnSkip(sourcePath, "parse handoff JSON header", error);
    return undefined;
  }
}

function parseMarkdownFindings(content: string): MarkdownFinding[] {
  const findingsHeader = /^## Findings\s*$/m.exec(content);
  if (!findingsHeader || findingsHeader.index === undefined) {
    return [];
  }

  const sectionStart = findingsHeader.index + findingsHeader[0].length;
  const rest = content.slice(sectionStart);
  const nextSection = /\n## [^#]/.exec(rest);
  const section = nextSection?.index === undefined ? rest : rest.slice(0, nextSection.index);

  return section
    .split(/(?=^### Finding\s+\d+)/m)
    .map((block) => parseMarkdownFindingBlock(block))
    .filter((finding): finding is MarkdownFinding => finding !== undefined);
}

function parseMarkdownFindingBlock(block: string): MarkdownFinding | undefined {
  const lines = block.trim().split(/\r?\n/);
  const heading = lines.shift()?.trim();
  const match = /^### Finding\s+(\d+)(?:\s*:\s*(.+))?$/.exec(heading ?? "");
  if (!match) {
    return undefined;
  }

  const fields: Record<string, string> = {};
  for (const line of lines) {
    const fieldMatch = /^-\s*([^:]+):\s*(.*)$/.exec(line.trim());
    if (fieldMatch) {
      fields[fieldMatch[1]!.trim()] = fieldMatch[2]!.trim();
    }
  }

  return {
    title: stringValue(match[2]) ?? `Finding ${match[1]}`,
    fields,
  };
}

function normalizeStructuredFinding(
  finding: unknown,
  reviewer: string,
  markdownFinding: MarkdownFinding | undefined,
): RawFinding | undefined {
  const record = recordValue(finding);
  if (!record) {
    return undefined;
  }

  const severity = stringValue(record.severity) ?? markdownFinding?.fields.Severity;
  const category = stringValue(record.category) ?? stringValue(record.classification) ?? markdownFinding?.fields.Category;
  const title = stringValue(record.title);
  const problem = stringValue(record.impact) ?? markdownFinding?.fields.Impact ?? stringValue(record.description);
  const evidence = stringValue(record.evidence) ?? markdownFinding?.fields.Evidence;
  const recommendation = stringValue(record.recommendation) ?? markdownFinding?.fields.Recommendation;
  const file = stringValue(record.file) ?? markdownFinding?.fields.File;
  const line = record.line ?? markdownFinding?.fields.Lines;

  return buildRawFinding({ reviewer, severity, category, title, problem, evidence, recommendation, file, line });
}

function normalizeMarkdownFinding(finding: MarkdownFinding, reviewer: string): RawFinding | undefined {
  return buildRawFinding({
    reviewer,
    severity: finding.fields.Severity,
    category: finding.fields.Category,
    title: finding.title,
    problem: finding.fields.Impact,
    evidence: finding.fields.Evidence,
    recommendation: finding.fields.Recommendation,
    file: finding.fields.File,
    line: finding.fields.Lines,
  });
}

function buildRawFinding(input: {
  reviewer: string;
  severity: string | undefined;
  category: string | undefined;
  title: string | undefined;
  problem: string | undefined;
  evidence: string | undefined;
  recommendation: string | undefined;
  file: string | undefined;
  line: unknown;
}): RawFinding | undefined {
  if (!input.severity || !input.category || !input.title || !input.problem) {
    return undefined;
  }

  return {
    reviewer: input.reviewer,
    severity: input.severity,
    category: input.category,
    title: input.title,
    problem: input.problem,
    evidence: input.evidence,
    recommendation: input.recommendation,
    locations: buildLocations(input.file, input.line),
  };
}

function buildLocations(file: string | undefined, line: unknown): RawLocation[] {
  if (!file || file === "N/A") {
    return [];
  }

  const parsedLine = parseLine(line);
  return parsedLine === undefined ? [{ path: file }] : [{ path: file, line: parsedLine }];
}

function parseLine(line: unknown): number | string | undefined {
  if (typeof line === "number" && Number.isFinite(line)) {
    return line;
  }

  if (typeof line !== "string") {
    return undefined;
  }

  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function warnSkip(sourcePath: string, action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[memory-extractor] Unable to ${action} at ${sourcePath}; skipping. ${message}`);
}

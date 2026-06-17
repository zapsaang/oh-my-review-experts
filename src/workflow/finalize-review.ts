import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { writeReport, type DegradedSlice } from "../tools/report.js";
import { assertSafePath } from "../tools/fs-utils.js";
import { parseHandoffJsonHeader } from "../tools/handoff.js";
import { severityRank, type SeverityLevel } from "../shared/severity.js";
import { runIndexLatest } from "../memory/indexing.js";
import { checkAutoCompactThreshold } from "../memory/pipeline.js";

/**
 * Server-side report finalization for the review-code workflow.
 *
 * Reads every reviewer handoff under `.omre/handoffs/{runId}/`, merges them
 * deterministically into a single review report, and persists the result via
 * `writeReport`. This is the destination of the `omre_finalize_review` plugin
 * tool: the omre-report-writer subagent calls the tool with a runId, and this
 * module assembles canonical Markdown and JSON from the handoff files —
 * keeping report assembly out of LLM hands while still reusing the existing
 * `writeReport` validation, atomic-write, and history pipeline.
 */

export interface FinalizeReviewInput {
  runId: string;
  cwd: string;
}

export interface FinalizeReviewResult {
  written: string[];
  handoffsConsumed: number;
  degradedSlices: DegradedSlice[];
  missingDimensionsGlobal: string[];
  memoryIndexResult?: {
    success: boolean;
    error?: string;
  };
}

interface ParsedHandoff {
  filename: string;
  sliceId: string;
  agent: string;
  dimension: string;
  status: string;
  target: { kind: string; value: string };
  findings: Array<Record<string, unknown>>;
  notes: string;
  totalFindings: number;
  unreadable: boolean;
}

interface MergedSlice {
  slice_id: string;
  findings: Array<Record<string, unknown>>;
}

interface MergedResult {
  slices: MergedSlice[];
  handoffs: ParsedHandoff[];
  degradedSlices: DegradedSlice[];
  missingDimensionsGlobal: string[];
}

const HANDOFF_FILENAME_PATTERN = /^[a-zA-Z0-9_\-\.]+\.md$/;
// Matches notes phrases like "missing dimensions a, b" or "Degraded: missing dimensions concurrency, security".
const MISSING_DIMENSIONS_NOTE = /missing dimensions?\s*[:\-]?\s*([a-zA-Z0-9_,\s\-]+)/i;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function summarizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}

function parseFindingId(finding: Record<string, unknown>): string {
  const id = finding.id;
  return typeof id === "string" ? id : "";
}

// The map assertion and comparator casts narrow values out of
// Record<string, unknown> and are required for typecheck; do not remove them.
function collectRegressions(merged: MergedResult): Record<string, unknown>[] {
  return merged.slices
    .flatMap((slice) =>
      slice.findings
        .filter((f) => f.isRegression === true)
        .map((f) => ({ ...f, slice_id: slice.slice_id }) as Record<string, unknown>)
    )
    .sort((a, b) => {
      const sliceDiff = (a.slice_id as string).localeCompare(b.slice_id as string);
      if (sliceDiff !== 0) return sliceDiff;
      const sevDiff = (severityRank[a.severity as SeverityLevel] ?? 4) - (severityRank[b.severity as SeverityLevel] ?? 4);
      if (sevDiff !== 0) return sevDiff;
      return parseFindingId(a).localeCompare(parseFindingId(b));
    });
}

function parseHandoffFile(filePath: string, filename: string): ParsedHandoff {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return {
      filename,
      sliceId: filename,
      agent: "unknown",
      dimension: "unknown",
      status: "blocked",
      target: { kind: "unknown", value: "" },
      findings: [],
      notes: "",
      totalFindings: 0,
      unreadable: true,
    };
  }

  const parsed = parseHandoffJsonHeader(content);
  if (!parsed.success) {
    return {
      filename,
      sliceId: filename,
      agent: "unknown",
      dimension: "unknown",
      status: "blocked",
      target: { kind: "unknown", value: "" },
      findings: [],
      notes: "",
      totalFindings: 0,
      unreadable: true,
    };
  }

  const data = asObject(parsed.data);
  if (!data) {
    return {
      filename,
      sliceId: filename,
      agent: "unknown",
      dimension: "unknown",
      status: "blocked",
      target: { kind: "unknown", value: "" },
      findings: [],
      notes: "",
      totalFindings: 0,
      unreadable: true,
    };
  }

  const findingsRaw = Array.isArray(data.findings) ? data.findings : [];
  const findings: Array<Record<string, unknown>> = [];
  for (const f of findingsRaw) {
    const obj = asObject(f);
    if (obj) findings.push(obj);
  }

  const meta = asObject(data.meta) ?? {};
  const notes = asString(meta.notes);
  const totalFindings =
    typeof meta.total_findings === "number" ? meta.total_findings : findings.length;

  const target = asObject(data.target);
  const targetKind = target ? asString(target.kind, "unknown") : "unknown";
  const targetValue = target ? asString(target.value, "") : "";

  return {
    filename,
    sliceId: asString(data.slice_id, filename),
    agent: asString(data.agent, "unknown"),
    dimension: asString(data.dimension, "unknown"),
    status: asString(data.status, "completed"),
    target: { kind: targetKind, value: targetValue },
    findings,
    notes,
    totalFindings,
    unreadable: false,
  };
}

function extractMissingDimensions(notes: string): string[] {
  const match = MISSING_DIMENSIONS_NOTE.exec(notes);
  if (!match) return [];
  return match[1]
    .split(/[,\s]+/)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

function mergeHandoffs(handoffs: ParsedHandoff[]): MergedResult {
  // Deterministic ordering: sort handoffs by sliceId, then agent, then filename.
  const sorted = [...handoffs].sort((a, b) => {
    if (a.sliceId !== b.sliceId) return a.sliceId.localeCompare(b.sliceId);
    if (a.agent !== b.agent) return a.agent.localeCompare(b.agent);
    return a.filename.localeCompare(b.filename);
  });

  const sliceFindings = new Map<string, Array<Record<string, unknown>>>();
  const degradedSlices: DegradedSlice[] = [];
  const missingDimensionsGlobalSet = new Set<string>();

  for (const handoff of sorted) {
    const sliceId = handoff.sliceId;
    if (!sliceFindings.has(sliceId)) {
      sliceFindings.set(sliceId, []);
    }
    const list = sliceFindings.get(sliceId);
    if (!list) continue;
    for (const finding of handoff.findings) {
      list.push(finding);
    }

    const explicitMissing = extractMissingDimensions(handoff.notes);
    const isDegraded = handoff.unreadable || handoff.status === "blocked" || explicitMissing.length > 0;
    if (isDegraded) {
      const missing = handoff.unreadable ? ["unreadable"] : explicitMissing.length > 0 ? explicitMissing : [handoff.dimension];
      degradedSlices.push({ slice_id: sliceId, missing_dimensions: missing });
      for (const dim of missing) {
        missingDimensionsGlobalSet.add(dim);
      }
    }
  }

  // Sort findings within each slice by id for determinism, then build the
  // merged slice array sorted by slice_id.
  const slices: MergedSlice[] = [];
  const sliceIds = Array.from(sliceFindings.keys()).sort();
  for (const sliceId of sliceIds) {
    const list = sliceFindings.get(sliceId);
    if (!list) continue;
    const sortedFindings = [...list].sort((a, b) => parseFindingId(a).localeCompare(parseFindingId(b)));
    slices.push({ slice_id: sliceId, findings: sortedFindings });
  }

  return {
    slices,
    handoffs: sorted,
    degradedSlices,
    missingDimensionsGlobal: Array.from(missingDimensionsGlobalSet).sort(),
  };
}

function renderFindingMarkdown(
  finding: Record<string, unknown>,
  sliceId: string,
  index: number,
): string[] {
  const lines: string[] = [];
  const id = parseFindingId(finding) || `finding-${index + 1}`;
  const severity = asString(finding.severity, "unknown");
  const file = asString(finding.file, "N/A");
  const line = typeof finding.line === "number" ? String(finding.line) : asString(finding.line, "N/A");
  const title = asString(finding.title, "(no title)");
  const description = asString(finding.description, "");
  const evidence = asString(finding.evidence, "");
  const confidence = asString(finding.confidence, "low");
  const classification = asString(finding.classification, "");

  lines.push(`#### ${title}`);
  lines.push("");
  if (finding.isRegression === true) {
    // regressionReason is already redacted upstream (handoff.ts:68); do NOT re-redact here.
    const reason = asString(finding.regressionReason, "");
    const refs = Array.isArray(finding.memoryRefs) ? finding.memoryRefs : [];
    let markerLine = "> 🔴 **Historical Regression**";
    if (reason.length > 0) {
      markerLine += ` — ${reason}`;
    }
    lines.push(markerLine);
    if (refs.length > 0) {
      lines.push(`> Memory refs: ${refs.join(", ")}`);
    }
    lines.push("> ");
  }
  lines.push(`- ID: ${id}`);
  lines.push(`- Slice: ${sliceId}`);
  lines.push(`- Severity: ${severity}`);
  lines.push(`- Confidence: ${confidence}`);
  lines.push(`- Classification: ${classification}`);
  lines.push(`- File: ${file}`);
  lines.push(`- Line: ${line}`);
  if (description.length > 0) {
    lines.push(`- Description: ${description}`);
  }
  if (evidence.length > 0) {
    lines.push(`- Evidence: ${evidence}`);
  }
  lines.push("");
  return lines;
}

function renderMarkdownReport(merged: MergedResult, runId: string): string {
  const lines: string[] = [];
  lines.push("# Code Review Report");
  lines.push("");
  lines.push("## Run");
  lines.push("");
  lines.push(`- Run ID: ${runId}`);
  lines.push(`- Slices reviewed: ${merged.slices.length}`);
  lines.push(`- Handoffs consumed: ${merged.handoffs.length}`);
  const totalFindings = merged.slices.reduce((acc, s) => acc + s.findings.length, 0);
  lines.push(`- Total findings: ${totalFindings}`);
  lines.push("");

  lines.push("## Coverage");
  lines.push("");
  if (merged.degradedSlices.length === 0 && merged.missingDimensionsGlobal.length === 0) {
    lines.push("All requested dimensions completed successfully across every slice.");
    lines.push("No coverage gaps were reported by reviewers.");
  } else {
    lines.push("Coverage is degraded for this review. Some dimensions could not be reviewed:");
    lines.push("");
    for (const slice of merged.degradedSlices) {
      lines.push(`- ${slice.slice_id}: missing ${slice.missing_dimensions.join(", ")}`);
    }
    if (merged.missingDimensionsGlobal.length > 0) {
      lines.push("");
      lines.push(`- Globally missing dimensions: ${merged.missingDimensionsGlobal.join(", ")}`);
    }
  }
  lines.push("");

  lines.push("## Slices");
  lines.push("");
  if (merged.slices.length === 0) {
    lines.push("No slices were assembled from the handoff files.");
  } else {
    for (const slice of merged.slices) {
      lines.push(`- ${slice.slice_id}: ${slice.findings.length} finding(s)`);
    }
  }
  lines.push("");

  lines.push("## Reviewer Handoffs");
  lines.push("");
  for (const handoff of merged.handoffs) {
    lines.push(`### Handoff: ${handoff.filename}`);
    lines.push("");
    lines.push(`- Agent: ${handoff.agent}`);
    lines.push(`- Dimension: ${handoff.dimension}`);
    lines.push(`- Slice: ${handoff.sliceId}`);
    lines.push(`- Status: ${handoff.status}`);
    lines.push(`- Target: ${handoff.target.kind}=${handoff.target.value}`);
    lines.push(`- Findings reported: ${handoff.findings.length}`);
    if (handoff.notes.length > 0) {
      lines.push(`- Notes: ${handoff.notes}`);
    }
    lines.push("");
  }

  lines.push("## Findings");
  lines.push("");
  if (totalFindings === 0) {
    lines.push("No issues found in covered dimensions.");
    lines.push("");
    lines.push("Reviewers completed without raising any actionable findings.");
    lines.push("This may indicate clean code or that no issues were within scope of the assigned dimensions.");
  } else {
    for (const slice of merged.slices) {
      if (slice.findings.length === 0) continue;
      lines.push(`### Slice ${slice.slice_id}`);
      lines.push("");
      const orderedFindings = [...slice.findings].sort((a, b) => {
        const sevDiff = (severityRank[a.severity as SeverityLevel] ?? 4) - (severityRank[b.severity as SeverityLevel] ?? 4);
        if (sevDiff !== 0) return sevDiff;
        return parseFindingId(a).localeCompare(parseFindingId(b));
      });
      for (let i = 0; i < orderedFindings.length; i++) {
        for (const fLine of renderFindingMarkdown(orderedFindings[i], slice.slice_id, i)) {
          lines.push(fLine);
        }
      }
    }
  }
  lines.push("");

  const regressions = collectRegressions(merged);

  if (regressions.length > 0) {
    lines.push("## Historical Regressions");
    lines.push("");
    for (const reg of regressions) {
      const id = parseFindingId(reg) || "unknown";
      const title = asString(reg.title, "(no title)");
      const severity = asString(reg.severity, "unknown");
      const file = asString(reg.file, "N/A");
      const line = typeof reg.line === "number" ? String(reg.line) : asString(reg.line, "N/A");
      const reason = asString(reg.regressionReason, "");
      const refs = Array.isArray(reg.memoryRefs) ? reg.memoryRefs : [];
      lines.push(`- **${title}** (${id}) — ${severity} — ${file}:${line}`);
      if (reason.length > 0) {
        lines.push(`  - Reason: ${reason}`);
      }
      if (refs.length > 0) {
        lines.push(`  - Memory refs: ${refs.join(", ")}`);
      }
    }
    lines.push("");
  }

  lines.push("## Summary");
  lines.push("");
  lines.push("This report was assembled deterministically from reviewer handoff files.");
  lines.push("Each finding above is sourced from a structured handoff JSON header and");
  lines.push("preserved verbatim by the finalizer. Reviewer chat transcripts are not");
  lines.push("consulted; the handoff files are the source of truth.");
  lines.push("");
  lines.push("Use the JSON sibling document (latest.json) for machine-readable access");
  lines.push("to the same content. The slices array there mirrors the structure above.");
  lines.push("");

  lines.push("## Methodology");
  lines.push("");
  lines.push("- Each reviewer subagent ran in isolation with a single dimension assignment.");
  lines.push("- Reviewers wrote their findings to a structured handoff file before any merge.");
  lines.push("- The finalizer reads handoff files in lexicographic order for determinism.");
  lines.push("- Findings are sorted by id within each slice to keep output byte-stable.");
  lines.push("- Slices are emitted in lexicographic order of slice_id.");
  lines.push("- Coverage warnings reflect handoff status and notes-declared missing dimensions.");
  lines.push("- The report is rendered server-side; no LLM authored these section headings.");
  lines.push("");

  return lines.join("\n");
}

function buildReportJson(merged: MergedResult, runId: string): Record<string, unknown> {
  const totalFindings = merged.slices.reduce((acc, s) => acc + s.findings.length, 0);
  const status = merged.degradedSlices.length === 0 ? "completed" : "degraded";
  const regressions = collectRegressions(merged);
  return {
    run_id: runId,
    status,
    slices: merged.slices.map((slice) => ({
      slice_id: slice.slice_id,
      findings: slice.findings,
    })),
    summary: {
      total_slices: merged.slices.length,
      total_findings: totalFindings,
      handoffs_consumed: merged.handoffs.length,
      regression_count: regressions.length,
    },
    degraded_slices: merged.degradedSlices,
    missing_dimensions_global: merged.missingDimensionsGlobal,
    regressions: regressions.map((reg) => ({
      finding_id: parseFindingId(reg) || "unknown",
      slice_id: reg.slice_id as string,
      title: asString(reg.title, "(no title)"),
      severity: asString(reg.severity, "unknown"),
      file: asString(reg.file, "N/A"),
      line: typeof reg.line === "number" ? String(reg.line) : asString(reg.line, "N/A"),
      memory_refs: Array.isArray(reg.memoryRefs) ? reg.memoryRefs : [],
      regression_reason: typeof reg.regressionReason === "string" ? reg.regressionReason : null,
    })),
  };
}

export function finalizeReview(input: FinalizeReviewInput): FinalizeReviewResult {
  const config = loadConfig(input.cwd);

  const resolvedCwd = path.resolve(input.cwd);
  const handoffBase = path.resolve(resolvedCwd, config.handoff.directory);
  const handoffDir = path.resolve(handoffBase, input.runId);

  assertSafePath(handoffDir, handoffBase, "finalizeReview.handoffDir");

  if (!fs.existsSync(handoffDir)) {
    throw new Error(
      `finalizeReview: handoff directory does not exist for runId "${input.runId}" (looked under ${path.relative(resolvedCwd, handoffDir) || handoffDir})`,
    );
  }

  const stat = fs.statSync(handoffDir);
  if (!stat.isDirectory()) {
    throw new Error(`finalizeReview: handoff path is not a directory: ${handoffDir}`);
  }

  const entries = fs.readdirSync(handoffDir);
  const handoffFiles = entries.filter((entry) => HANDOFF_FILENAME_PATTERN.test(entry)).sort();
  if (handoffFiles.length === 0) {
    throw new Error(
      `finalizeReview: no handoff files found in ${path.relative(resolvedCwd, handoffDir) || handoffDir} for runId "${input.runId}"`,
    );
  }

  const parsed: ParsedHandoff[] = [];
  for (const filename of handoffFiles) {
    const filePath = path.join(handoffDir, filename);
    const lstat = fs.lstatSync(filePath);
    if (!lstat.isFile() || lstat.isSymbolicLink()) continue;
    parsed.push(parseHandoffFile(filePath, filename));
  }

  const merged = mergeHandoffs(parsed);
  const markdown = renderMarkdownReport(merged, input.runId);
  const json = buildReportJson(merged, input.runId);

  const written = writeReport(
    config,
    {
      target: "current-change",
      markdown,
      json,
      degradedSlices: merged.degradedSlices,
      missingDimensionsGlobal: merged.missingDimensionsGlobal,
      runId: input.runId,
    },
    input.cwd,
  );

  let memoryIndexResult: FinalizeReviewResult["memoryIndexResult"];
  if (config.memory.enabled) {
    if (config.memory.indexing?.autoIndexAfterReview !== false) {
      try {
        runIndexLatest({ cwd: input.cwd });
        memoryIndexResult = { success: true };
      } catch (err) {
        memoryIndexResult = {
          success: false,
          error: summarizeError(err),
        };
      }
    }

    const compactCheck = checkAutoCompactThreshold(input.cwd, config.memory);
    if (compactCheck.needsCompaction) {
      console.log(`Review memory threshold exceeded (${compactCheck.reason}). Run \`omre memory compact\` to merge segments.`);
    }
  }

  return {
    written,
    handoffsConsumed: merged.handoffs.length,
    degradedSlices: merged.degradedSlices,
    missingDimensionsGlobal: merged.missingDimensionsGlobal,
    memoryIndexResult,
  };
}

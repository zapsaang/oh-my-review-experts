import { severityRank, type SeverityLevel } from "../shared/severity.js";
import { asString, parseFindingId, type MergedResult, type MergedSlice } from "./finalize-handoff-parse.js";

export const REGRESSION_MARKER = "🔴";

// The map assertion and comparator casts narrow values out of
// Record<string, unknown> and are required for typecheck; do not remove them.
export function collectRegressions(merged: MergedResult): Record<string, unknown>[] {
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

export function renderRegressionSection(merged: MergedResult, retrievalActive: boolean): string[] {
  const lines: string[] = [];
  const regressions = collectRegressions(merged);

  if (regressions.length === 0 && !retrievalActive) {
    return [
      "## Historical Regressions",
      "",
      "_Review Memory retrieval was not active for this run. To detect whether any " +
        "findings recur from previously-fixed issues, re-run with `--with-memory` or set " +
        "`memory.retrieval.enabled: true` in your config._",
      "",
    ];
  }

  lines.push("## Historical Regressions");
  lines.push("");

  if (regressions.length > 0) {
    if (!retrievalActive) {
      lines.push("_Review Memory retrieval was not active for this run, but a reviewer reported potential regressions:_");
      lines.push("");
    } else {
      lines.push(`**${regressions.length}** finding(s) recur from previously-fixed issues in Review Memory:`);
      lines.push("");
    }
    for (const reg of regressions) {
      const id = parseFindingId(reg) || "unknown";
      const title = asString(reg.title, "(no title)");
      const severity = asString(reg.severity, "unknown");
      const file = asString(reg.file, "N/A");
      const line = typeof reg.line === "number" ? String(reg.line) : asString(reg.line, "N/A");
      const reason = asString(reg.regressionReason, "");
      const refs = Array.isArray(reg.memoryRefs) ? reg.memoryRefs : [];
      lines.push(`- ${REGRESSION_MARKER} **${title}** (${id}) — ${severity} — ${file}:${line}`);
      if (reason.length > 0) {
        lines.push(`  - Reason: ${reason}`);
      }
      if (refs.length > 0) {
        lines.push(`  - Memory refs: ${refs.join(", ")}`);
      }
    }
    lines.push("");
  } else {
    lines.push("No historical regressions detected. None of this run's findings match previously-fixed issues in Review Memory.");
    lines.push("");
  }

  return lines;
}

export function renderFindingMarkdown(
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
    let markerLine = `> ${REGRESSION_MARKER} **Historical Regression**`;
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

export function renderMarkdownReport(merged: MergedResult, runId: string, retrievalActive: boolean): string {
  const lines: string[] = [];
  lines.push("# Code Review Report");
  lines.push("");
  lines.push("## Run");
  lines.push("");
  lines.push(`- Run ID: ${runId}`);
  lines.push(`- Slices reviewed: ${merged.slices.length}`);
  lines.push(`- Handoffs consumed: ${merged.handoffs.length}`);
  const totalFindings = merged.slices.reduce((acc, s: MergedSlice) => acc + s.findings.length, 0);
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

  for (const l of renderRegressionSection(merged, retrievalActive)) {
    lines.push(l);
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

export function buildReportJson(merged: MergedResult, runId: string): Record<string, unknown> {
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

import fs from "node:fs";
import { parseHandoffJsonHeader } from "../tools/handoff.js";
import type { DegradedSlice } from "../tools/report.js";

export interface ParsedHandoff {
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

export interface MergedSlice {
  slice_id: string;
  findings: Array<Record<string, unknown>>;
}

export interface MergedResult {
  slices: MergedSlice[];
  handoffs: ParsedHandoff[];
  degradedSlices: DegradedSlice[];
  missingDimensionsGlobal: string[];
}

export const HANDOFF_FILENAME_PATTERN = /^[a-zA-Z0-9_\-\.]+\.md$/;
// Matches notes phrases like "missing dimensions a, b" or "Degraded: missing dimensions concurrency, security".
export const MISSING_DIMENSIONS_NOTE = /missing dimensions?\s*[:\-]?\s*([a-zA-Z0-9_,\s\-]+)/i;

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseFindingId(finding: Record<string, unknown>): string {
  const id = finding.id;
  return typeof id === "string" ? id : "";
}

export function parseHandoffFile(filePath: string, filename: string): ParsedHandoff {
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

export function extractMissingDimensions(notes: string): string[] {
  const match = MISSING_DIMENSIONS_NOTE.exec(notes);
  if (!match) return [];
  return match[1]
    .split(/[,\s]+/)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

export function mergeHandoffs(handoffs: ParsedHandoff[]): MergedResult {
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

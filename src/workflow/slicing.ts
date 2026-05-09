import type { OmreConfig, ReviewDimensionType, SliceTypeValue } from "../config/schema.js";
import type { EstimatedPlan, ReviewSlice } from "./types.js";

/** Explicitly ordered classification rules. Earlier rules take precedence. */
const CLASSIFICATION_RULES: { regex: RegExp; type: SliceTypeValue }[] = [
  { regex: /README|CHANGELOG|AGENTS\.md|docs\//i, type: "docs-only" },
  { regex: /\b(test|spec|__tests__)\b/i, type: "test-only" },
  { regex: /migration|migrations|schema\.sql/i, type: "migration" },
  { regex: /proto|openapi|swagger|schema|graphql/i, type: "api-contract" },
  { regex: /package-lock|pnpm-lock|yarn\.lock|package\.json|pom\.xml|build\.gradle|Cargo\.toml|Cargo\.lock/i, type: "dependency-change" },
  { regex: /Dockerfile|docker-compose|\.github\/workflows|k8s|helm|terraform|infra\//i, type: "infra-change" },
  { regex: /common|shared|lib|types/i, type: "shared-library" },
];

function classifyFile(file: string): SliceTypeValue {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.regex.test(file)) return rule.type;
  }
  return "business-module";
}

function moduleKey(file: string): string {
  const parts = file.split("/");
  if (parts[0] === "crates" && parts[1]) return parts.slice(0, 2).join("/");
  if (parts[0] === "src" && parts[1]) return parts.slice(0, 2).join("/");
  return parts[0] || "root";
}

export function heuristicSlices(files: string[], config: OmreConfig): ReviewSlice[] {
  const groups = new Map<string, { type: SliceTypeValue; files: string[] }>();
  for (const file of files) {
    const type = classifyFile(file);
    if (config.slicing.skipDocsOnly && type === "docs-only") continue;
    const key = `${type}:${type === "business-module" || type === "shared-library" ? moduleKey(file) : type}`;
    const group = groups.get(key) ?? { type, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  let i = 1;
  const slices = Array.from(groups.entries()).map(([key, group]) => ({
    slice_id: `slice-${i++}`,
    slice_type: group.type,
    title: key.replace(/^.*?:/, "").replace(/[-_/]/g, " "),
    files: group.files,
  }));
  return slices.slice(0, config.slicing.maxSlices);
}

export function estimatePlan(files: string[], config: OmreConfig): EstimatedPlan {
  let slices: ReviewSlice[];
  if (config.slicing.enabled) {
    slices = heuristicSlices(files, config);
    if (slices.length > config.slicing.forceWholeTargetAboveSlices) {
      slices = [{ slice_id: "whole-target", slice_type: "business-module", title: "Whole target", files }];
    }
  } else {
    slices = [{ slice_id: "whole-target", slice_type: "business-module" as const, title: "Whole target", files }];
  }
  if (slices.length === 0) {
    const filteredFiles = config.slicing.skipDocsOnly
      ? files.filter((f) => classifyFile(f) !== "docs-only")
      : files;
    slices = [{ slice_id: "whole-target", slice_type: "business-module", title: "Whole target", files: filteredFiles }];
  }
  const selectedReviewers: Record<string, ReviewDimensionType[]> = {};
  let estimatedTasks = 2;
  for (const slice of slices) {
    const bySlice = config.reviewers.bySliceType[slice.slice_type];
    let reviewers = bySlice && bySlice.length > 0 ? bySlice : config.reviewers.default;
    if (slice.slice_type === "test-only" && !config.slicing.skipTestOnlyHeavyReview) {
      reviewers = config.reviewers.default;
    }
    selectedReviewers[slice.slice_id] = reviewers;
    estimatedTasks += reviewers.length * 2 + 1;
  }
  const compactMode = config.costGuardrail.enabled && estimatedTasks > config.costGuardrail.compactModeThreshold;
  return { slices, selectedReviewers, estimatedTasks, compactMode };
}

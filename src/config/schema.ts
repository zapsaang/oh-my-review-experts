import { z } from "zod";

// Security: Path traversal prevention helpers
// These patterns ensure user-controlled path segments cannot escape the project directory.

/** Matches safe relative directory paths: no "..", no absolute paths, only alphanumeric + _ - . / */
const SAFE_DIR_PATTERN = /^(?!\/)((?!\.\.)[a-zA-Z0-9_\-\.\/])+$/;

/** Matches safe filename segments: no path separators, no ".." */
const SAFE_FILENAME_PATTERN = /^(?!.*\.\.)[a-zA-Z0-9_\-\.]+$/;

/** Matches safe OpenCode command identifiers: no whitespace, no slashes, no JS prototype keys */
const SAFE_COMMAND_PATTERN = /^[a-zA-Z0-9_-]+$/;

const FORBIDDEN_COMMAND_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export const ReviewDimension = z.enum([
  "spec",
  "quality",
  "security",
  "performance",
  "concurrency",
]);

export const SliceType = z.enum([
  "business-module",
  "migration",
  "api-contract",
  "dependency-change",
  "infra-change",
  "shared-library",
  "test-only",
  "docs-only",
]);

export function sanitizeDefaultModel(raw: string | undefined): string {
  if (!raw) return "minimax-cn/MiniMax-M2.7";
  const cleaned = raw.replace(/[\x00-\x1f\x7f"'\\]/g, "");
  return cleaned || "minimax-cn/MiniMax-M2.7";
}

const DEFAULT_MODEL = sanitizeDefaultModel(process.env.OMRE_DEFAULT_MODEL);

export const ModelConfig = z.object({
  orchestrator: z.string().default(DEFAULT_MODEL).describe("[DEPRECATED — no consumer, kept for config compatibility] Model for the orchestrator agent that coordinates the review pipeline."),
  spec: z.string().default(DEFAULT_MODEL).describe("Model for the spec compliance reviewer."),
  quality: z.string().default(DEFAULT_MODEL).describe("Model for the code quality reviewer."),
  security: z.string().default(DEFAULT_MODEL).describe("Model for the security reviewer."),
  performance: z.string().default(DEFAULT_MODEL).describe("Model for the performance reviewer."),
  concurrency: z.string().default(DEFAULT_MODEL).describe("Model for the concurrency reviewer."),
  slicePlanner: z.string().default(DEFAULT_MODEL).describe("Model for the slice planner agent that groups changed files into coherent slices."),
  validator: z.string().default(DEFAULT_MODEL).describe("Model for the validator agent that checks reviewer output structure."),
  sliceArbiter: z.string().default(DEFAULT_MODEL).describe("Model for the slice arbiter that merges per-slice findings."),
  globalArbiter: z.string().default(DEFAULT_MODEL).describe("Model for the global arbiter that deduplicates across slices."),
  reportWriter: z.string().default(DEFAULT_MODEL).describe("Model for the report writer agent that produces the final markdown report."),
});

const DEFAULT_COMMAND = {
  enabled: true,
  name: "review-code",
  aliases: ["rc"],
  injection: "both" as const,
};

const DEFAULT_MODELS = {
  orchestrator: DEFAULT_MODEL,
  spec: DEFAULT_MODEL,
  quality: DEFAULT_MODEL,
  security: DEFAULT_MODEL,
  performance: DEFAULT_MODEL,
  concurrency: DEFAULT_MODEL,
  slicePlanner: DEFAULT_MODEL,
  validator: DEFAULT_MODEL,
  sliceArbiter: DEFAULT_MODEL,
  globalArbiter: DEFAULT_MODEL,
  reportWriter: DEFAULT_MODEL,
};

const DEFAULT_SLICING = {
  enabled: true,
  maxSlices: 4,
  skipDocsOnly: true,
  skipTestOnlyHeavyReview: true,
  forceWholeTargetAboveSlices: 12,
};

const DEFAULT_PARTIAL_RERUN = {
  enabled: true,
  maxRetriesPerTask: 1,
};

const DEFAULT_COST_GUARDRAIL = {
  enabled: true,
  maxEstimatedTasks: 24,
  compactModeThreshold: 20,
  hardStopThreshold: 60,
};

const DEFAULT_ARBITRATION = {
  hierarchicalThreshold: 3,
};

const DEFAULT_REPORT = {
  enabled: true,
  directory: ".omre/reports",
  latestMarkdown: "latest.md",
  latestJson: "latest.json",
  timestamped: true,
};

const DEFAULT_HANDOFF = {
  enabled: true,
  directory: ".omre/handoffs",
};

const DEFAULT_REVIEWERS: {
  default: Array<"spec" | "quality" | "security" | "performance" | "concurrency">;
  bySliceType: Record<
    "business-module" | "migration" | "api-contract" | "dependency-change" | "infra-change" | "shared-library" | "test-only" | "docs-only",
    Array<"spec" | "quality" | "security" | "performance" | "concurrency">
  >;
} = {
  default: ["spec", "quality", "security", "performance", "concurrency"],
  bySliceType: {
    "api-contract": ["spec", "security", "concurrency"],
    "migration": ["spec", "performance", "concurrency"],
    "business-module": ["spec", "security", "performance", "concurrency"],
    "shared-library": ["spec", "quality", "security", "concurrency"],
    "dependency-change": ["security", "performance"],
    "infra-change": ["security", "performance"],
    "test-only": ["spec", "quality"],
    "docs-only": [],
  },
};

export const OmreConfigSchema = z.object({
  enabled: z.boolean().default(true).describe("Globally enable or disable the review plugin."),
  command: z.object({
    enabled: z.boolean().default(true).describe("Enable the /review-code slash command."),
    name: z.string()
      .regex(SAFE_COMMAND_PATTERN, "command.name must only contain alphanumeric, underscore, or hyphen")
      .refine((val) => !FORBIDDEN_COMMAND_NAMES.has(val), {
        message: `command.name must not be a forbidden name`,
      })
      .default("review-code")
      .describe("Slash command name. Alphanumeric, underscore, or hyphen only. Forbidden names: __proto__, constructor, prototype."),
    aliases: z.array(
      z.string()
        .regex(SAFE_COMMAND_PATTERN, "command.alias must only contain alphanumeric, underscore, or hyphen")
        .refine((val) => !FORBIDDEN_COMMAND_NAMES.has(val), {
          message: `command.alias must not be a forbidden name`,
        })
    ).default(["rc"]).describe("Alternative names for the slash command."),
    injection: z.enum(["hook", "tool", "both", "disabled"]).default("both").describe(
      "How the command is wired: 'both' registers via config hook and intercepts execution; 'hook' same as both; 'disabled' mutes the plugin; 'tool' disables slash commands but keeps plugin tools available."
    ),
  }).default(() => structuredClone(DEFAULT_COMMAND)).describe("Slash command registration settings."),
  models: ModelConfig.default(() => structuredClone(DEFAULT_MODELS)).describe("Model assignments for each agent role in the review pipeline."),
  slicing: z.object({
    enabled: z.boolean().default(true).describe("Enable the file slicing engine that groups changed files into coherent review slices."),
    maxSlices: z.number().int().min(1).max(32).default(4).describe("Maximum number of slices to generate. Range: 1-32."),
    skipDocsOnly: z.boolean().default(true).describe("Skip heavy review for docs-only slices."),
    skipTestOnlyHeavyReview: z.boolean().default(true).describe("Skip heavy review for test-only slices."),
    forceWholeTargetAboveSlices: z.number().int().min(1).max(100).default(12).describe(
      "When the estimated number of slices exceeds this threshold, review the entire target as one unit instead of slicing. Range: 1-100."
    ),
  }).default(() => structuredClone(DEFAULT_SLICING)).describe("File classification and grouping settings."),
  partialRerun: z.object({
    enabled: z.boolean().default(true).describe("Enable partial rerun: when a reviewer fails, re-run only that task instead of the whole pipeline."),
    maxRetriesPerTask: z.number().int().min(0).max(1).default(1).describe("Maximum retry attempts per failed task. Range: 0-1."),
  }).default(() => structuredClone(DEFAULT_PARTIAL_RERUN)).describe("Partial rerun settings for failed reviewer tasks."),
  costGuardrail: z.object({
    enabled: z.boolean().default(true).describe("Enable cost estimation and guardrails before launching the review pipeline."),
    maxEstimatedTasks: z.number().int().min(1).max(1000).default(24).describe("Maximum estimated tasks before switching to compact mode. Range: 1-1000."),
    compactModeThreshold: z.number().int().min(1).max(1000).default(20).describe("Estimated task threshold for compact mode (reduced reviewer matrix). Range: 1-1000."),
    hardStopThreshold: z.number().int().min(1).max(1000).default(60).describe("Absolute maximum estimated tasks; pipeline halts if exceeded. Range: 1-1000."),
  }).default(() => structuredClone(DEFAULT_COST_GUARDRAIL)).describe("Cost guardrail settings to prevent accidental high-cost reviews."),
  arbitration: z.object({
    hierarchicalThreshold: z.number().int().min(1).max(32).default(3).describe(
      "Number of slices above which hierarchical arbitration is used instead of flat merging. Range: 1-32."
    ),
  }).default(() => structuredClone(DEFAULT_ARBITRATION)).describe("Arbitration strategy settings for merging reviewer findings."),
  report: z.object({
    enabled: z.boolean().default(true).describe("Enable report generation and persistence."),
    // SECURITY: directory must be a relative path without ".." segments to prevent path traversal.
    directory: z.string()
      .regex(SAFE_DIR_PATTERN, "report.directory must be a safe relative path (no .., no absolute paths, only a-zA-Z0-9_-./)")
      .default(".omre/reports")
      .describe("Directory for report output. Must be a safe relative path (no .., no absolute paths)."),
    // SECURITY: filenames must not contain path separators to prevent directory escape.
    latestMarkdown: z.string()
      .regex(SAFE_FILENAME_PATTERN, "report.latestMarkdown must be a safe filename (no path separators, no ..)")
      .default("latest.md")
      .describe("Filename for the latest markdown report."),
    latestJson: z.string()
      .regex(SAFE_FILENAME_PATTERN, "report.latestJson must be a safe filename (no path separators, no ..)")
      .default("latest.json")
      .describe("Filename for the latest JSON report."),
    timestamped: z.boolean().default(true).describe("Generate timestamped history copies alongside latest.md/latest.json."),
  }).default(() => structuredClone(DEFAULT_REPORT)).describe("Report output settings."),
  handoff: z.object({
    enabled: z.boolean().default(true).describe("Enable the handoff protocol for structured subagent communication."),
    // SECURITY: directory must be a relative path without ".." segments to prevent path traversal.
    directory: z.string()
      .regex(SAFE_DIR_PATTERN, "handoff.directory must be a safe relative path (no .., no absolute paths, only a-zA-Z0-9_-./)")
      .default(".omre/handoffs")
      .describe("Directory for handoff files. Must be a safe relative path (no .., no absolute paths)."),
  }).default(() => structuredClone(DEFAULT_HANDOFF)).describe("Handoff protocol settings for structured subagent output."),
  reviewers: z.object({
    default: z.array(ReviewDimension).default(["spec", "quality", "security", "performance", "concurrency"]).describe(
      "Default reviewer dimensions applied to all slices."
    ),
    bySliceType: z.object(
      Object.fromEntries(
        SliceType.options.map((key) => [key, z.array(ReviewDimension).default(() => structuredClone(DEFAULT_REVIEWERS.bySliceType[key]))])
      )
    ).strict().default(() => structuredClone(DEFAULT_REVIEWERS.bySliceType)).describe(
      "Reviewer dimensions per slice type. Unknown slice types are rejected by design."
    ),
  }).default(() => structuredClone(DEFAULT_REVIEWERS)).describe("Reviewer dimension assignment settings."),
}).meta({
  $id: "https://raw.githubusercontent.com/zapsaang/oh-my-review-experts/main/schemas/oh-my-review-experts.schema.json",
  title: "Oh My Review Experts Config",
  description: "Configuration schema for the oh-my-review-experts OpenCode plugin.",
});

export type OmreConfig = z.infer<typeof OmreConfigSchema>;
export type ReviewDimensionType = z.infer<typeof ReviewDimension>;
export type SliceTypeValue = z.infer<typeof SliceType>;

export const DEFAULT_CONFIG: OmreConfig = OmreConfigSchema.parse({});

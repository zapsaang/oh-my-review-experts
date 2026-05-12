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

function validateCommandName(name: string, ctx: z.RefinementCtx) {
  if (!name) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "command.name must not be empty" });
    return false;
  }
  if (FORBIDDEN_COMMAND_NAMES.has(name)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `command.name must not be "${name}"` });
    return false;
  }
  if (!SAFE_COMMAND_PATTERN.test(name)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "command.name must only contain alphanumeric, underscore, or hyphen" });
    return false;
  }
  return true;
}

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

function sanitizeDefaultModel(raw: string | undefined): string {
  if (!raw) return "minimax-cn/MiniMax-M2.7";
  const cleaned = raw.replace(/[\x00-\x1f\x7f"'\\]/g, "");
  return cleaned || "minimax-cn/MiniMax-M2.7";
}

const DEFAULT_MODEL = sanitizeDefaultModel(process.env.OMRE_DEFAULT_MODEL);

export const ModelConfig = z.object({
  orchestrator: z.string().default(DEFAULT_MODEL),
  spec: z.string().default(DEFAULT_MODEL),
  quality: z.string().default(DEFAULT_MODEL),
  security: z.string().default(DEFAULT_MODEL),
  performance: z.string().default(DEFAULT_MODEL),
  concurrency: z.string().default(DEFAULT_MODEL),
  slicePlanner: z.string().default(DEFAULT_MODEL),
  validator: z.string().default(DEFAULT_MODEL),
  sliceArbiter: z.string().default(DEFAULT_MODEL),
  globalArbiter: z.string().default(DEFAULT_MODEL),
  reportWriter: z.string().default(DEFAULT_MODEL),
});

export const OmreConfigSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.object({
    enabled: z.boolean().default(true),
    name: z.string()
      .default("review-code")
      .superRefine((val, ctx) => validateCommandName(val, ctx)),
    aliases: z.array(z.string().superRefine((val, ctx) => validateCommandName(val, ctx)))
      .default(["rc"]),
    injection: z.enum(["hook", "tool", "both", "disabled"]).default("both"),
  }).default({}),
  models: ModelConfig.default({}),
  slicing: z.object({
    enabled: z.boolean().default(true),
    maxSlices: z.number().int().min(1).max(32).default(4),
    skipDocsOnly: z.boolean().default(true),
    skipTestOnlyHeavyReview: z.boolean().default(true),
    forceWholeTargetAboveSlices: z.number().int().min(1).default(12),
  }).default({}),
  partialRerun: z.object({
    enabled: z.boolean().default(true),
    maxRetriesPerTask: z.number().int().min(0).max(1).default(1),
  }).default({}),
  costGuardrail: z.object({
    enabled: z.boolean().default(true),
    maxEstimatedTasks: z.number().int().min(1).max(1000).default(24),
    compactModeThreshold: z.number().int().min(1).max(1000).default(20),
    hardStopThreshold: z.number().int().min(1).max(1000).default(60),
  }).default({}),
  arbitration: z.object({
    hierarchicalThreshold: z.number().int().min(1).max(32).default(3),
  }).default({}),
  report: z.object({
    enabled: z.boolean().default(true),
    // SECURITY: directory must be a relative path without ".." segments to prevent path traversal.
    directory: z.string()
      .refine((v) => SAFE_DIR_PATTERN.test(v), {
        message: "report.directory must be a safe relative path (no .., no absolute paths, only a-zA-Z0-9_-./)",
      })
      .default(".omre/reports"),
    // SECURITY: filenames must not contain path separators to prevent directory escape.
    latestMarkdown: z.string()
      .refine((v) => SAFE_FILENAME_PATTERN.test(v), {
        message: "report.latestMarkdown must be a safe filename (no path separators, no ..)",
      })
      .default("latest.md"),
    latestJson: z.string()
      .refine((v) => SAFE_FILENAME_PATTERN.test(v), {
        message: "report.latestJson must be a safe filename (no path separators, no ..)",
      })
      .default("latest.json"),
    timestamped: z.boolean().default(true),
  }).default({}),
  handoff: z.object({
    enabled: z.boolean().default(true),
    // SECURITY: directory must be a relative path without ".." segments to prevent path traversal.
    directory: z.string()
      .refine((v) => SAFE_DIR_PATTERN.test(v), {
        message: "handoff.directory must be a safe relative path (no .., no absolute paths, only a-zA-Z0-9_-./)",
      })
      .default(".omre/handoffs"),
  }).default({}),
  reviewers: z.object({
    default: z.array(ReviewDimension).default(["spec", "quality", "security", "performance", "concurrency"]),
    bySliceType: z.record(SliceType, z.array(ReviewDimension)).default({
      "api-contract": ["spec", "security", "concurrency"],
      "migration": ["spec", "performance", "concurrency"],
      "business-module": ["spec", "security", "performance", "concurrency"],
      "shared-library": ["spec", "quality", "security", "concurrency"],
      "dependency-change": ["security", "performance"],
      "infra-change": ["security", "performance"],
      "test-only": ["spec", "quality"],
      "docs-only": [],
    }),
  }).default({}),
});

export type OmreConfig = z.infer<typeof OmreConfigSchema>;
export type ReviewDimensionType = z.infer<typeof ReviewDimension>;
export type SliceTypeValue = z.infer<typeof SliceType>;

export const DEFAULT_CONFIG: OmreConfig = OmreConfigSchema.parse({});

import { z } from "zod";

const INDEXING_DEFAULTS = {
  maxFileSizeKb: 512,
  includePatterns: ["**/*.{ts,tsx,js,jsx,py,go,rs,java}"],
  excludePatterns: ["node_modules/**", "dist/**", ".git/**", "coverage/**"],
  autoIndexAfterReview: true,
};

const RETRIEVAL_DEFAULTS = {
  enabled: false,
  defaultTopK: 5,
  similarityThreshold: 0.75,
  crossRunDeduplication: true,
  maxContextItems: 6,
  maxContextChars: 8000,
  includeFixedAsRegressionCandidates: true,
  includeFalsePositive: false,
  byReviewer: {},
};

const DEDUPE_DEFAULTS = {
  fingerprintThreshold: 0.92,
  contentHashThreshold: 0.85,
};

const SIMILARITY_DEFAULTS = {
  tokenWeight: 0.6,
  semanticWeight: 0.4,
};

const COMPACTION_DEFAULTS = {
  enabled: true,
  minRawSegments: 50,
  minRawSegmentBytes: 1048576,
  maxCompactDurationMs: 3000,
  autoCompactAfterReview: true,
};

const RETENTION_DEFAULTS = {
  maxEventsPerFinding: 100,
  maxFindings: 5000,
  maxAgeDays: 365,
  rawSegmentKeepDays: 30,
  tmpFileMaxAgeHours: 24,
  maxRawSegments: 200,
  keepConfirmed: true,
  keepHighSeverity: true,
};

const PRIVACY_DEFAULTS = {
  redactEvidence: true,
  redactProblem: false,
  allowedTokensInSearchable: [],
};

const SUGGESTION_DEFAULTS = {
  enabled: true,
  timeDecayDays: 90,
  skipImportSource: true,
};

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  directory: z.string().default(".omre/memory"),
  indexing: z.object({
    maxFileSizeKb: z.number().int().min(1).max(100000).default(INDEXING_DEFAULTS.maxFileSizeKb),
    includePatterns: z.array(z.string()).default(() => structuredClone(INDEXING_DEFAULTS.includePatterns)),
    excludePatterns: z.array(z.string()).default(() => structuredClone(INDEXING_DEFAULTS.excludePatterns)),
    autoIndexAfterReview: z.boolean().default(INDEXING_DEFAULTS.autoIndexAfterReview),
  }).default(() => structuredClone(INDEXING_DEFAULTS)),
  retrieval: z.object({
    enabled: z.boolean().default(RETRIEVAL_DEFAULTS.enabled),
    defaultTopK: z.number().int().min(1).max(100).default(RETRIEVAL_DEFAULTS.defaultTopK),
    similarityThreshold: z.number().min(0).max(1).default(RETRIEVAL_DEFAULTS.similarityThreshold),
    crossRunDeduplication: z.boolean().default(RETRIEVAL_DEFAULTS.crossRunDeduplication),
    maxContextItems: z.number().int().min(1).max(100).default(RETRIEVAL_DEFAULTS.maxContextItems),
    maxContextChars: z.number().int().min(1000).max(100000).default(RETRIEVAL_DEFAULTS.maxContextChars),
    includeFixedAsRegressionCandidates: z.boolean().default(RETRIEVAL_DEFAULTS.includeFixedAsRegressionCandidates),
    includeFalsePositive: z.boolean().default(RETRIEVAL_DEFAULTS.includeFalsePositive),
    byReviewer: z.record(z.string(), z.object({
      topK: z.number().int().min(1).max(100).optional(),
      enabled: z.boolean().optional(),
      includeReviewers: z.array(z.string()).optional(),
    })).default(() => structuredClone(RETRIEVAL_DEFAULTS.byReviewer)),
  }).default(() => structuredClone(RETRIEVAL_DEFAULTS)),
  dedupe: z.object({
    fingerprintThreshold: z.number().min(0).max(1).default(DEDUPE_DEFAULTS.fingerprintThreshold),
    contentHashThreshold: z.number().min(0).max(1).default(DEDUPE_DEFAULTS.contentHashThreshold),
  }).default(() => structuredClone(DEDUPE_DEFAULTS)),
  similarity: z.object({
    tokenWeight: z.number().min(0).max(1).default(SIMILARITY_DEFAULTS.tokenWeight),
    semanticWeight: z.number().min(0).max(1).default(SIMILARITY_DEFAULTS.semanticWeight),
  }).default(() => structuredClone(SIMILARITY_DEFAULTS)),
  compaction: z.preprocess(
    (val) => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const obj = val as Record<string, unknown>;
        if ("maxSegmentsBeforeCompaction" in obj && !("minRawSegments" in obj)) {
          return { ...obj, minRawSegments: obj.maxSegmentsBeforeCompaction };
        }
      }
      return val;
    },
    z.object({
      enabled: z.boolean().default(COMPACTION_DEFAULTS.enabled),
      minRawSegments: z.number().int().min(1).max(10000).default(COMPACTION_DEFAULTS.minRawSegments),
      minRawSegmentBytes: z.number().int().min(1).max(1073741824).default(COMPACTION_DEFAULTS.minRawSegmentBytes),
      maxCompactDurationMs: z.number().int().min(1).max(3600000).default(COMPACTION_DEFAULTS.maxCompactDurationMs),
      autoCompactAfterReview: z.boolean().default(COMPACTION_DEFAULTS.autoCompactAfterReview),
    }).default(() => structuredClone(COMPACTION_DEFAULTS)),
  ),
  retention: z.object({
    maxEventsPerFinding: z.number().int().min(1).max(100000).default(RETENTION_DEFAULTS.maxEventsPerFinding),
    maxFindings: z.number().int().min(1).max(1000000).default(RETENTION_DEFAULTS.maxFindings),
    maxAgeDays: z.number().int().min(1).max(3650).default(RETENTION_DEFAULTS.maxAgeDays),
    rawSegmentKeepDays: z.number().int().min(1).max(3650).default(RETENTION_DEFAULTS.rawSegmentKeepDays),
    tmpFileMaxAgeHours: z.number().int().min(1).max(8760).default(RETENTION_DEFAULTS.tmpFileMaxAgeHours),
    maxRawSegments: z.number().int().min(1).max(100000).default(RETENTION_DEFAULTS.maxRawSegments),
    keepConfirmed: z.boolean().default(RETENTION_DEFAULTS.keepConfirmed),
    keepHighSeverity: z.boolean().default(RETENTION_DEFAULTS.keepHighSeverity),
  }).default(() => structuredClone(RETENTION_DEFAULTS)),
  privacy: z.object({
    redactEvidence: z.boolean().default(PRIVACY_DEFAULTS.redactEvidence),
    redactProblem: z.boolean().default(PRIVACY_DEFAULTS.redactProblem),
    allowedTokensInSearchable: z.array(z.string()).default(() => structuredClone(PRIVACY_DEFAULTS.allowedTokensInSearchable)),
  }).default(() => structuredClone(PRIVACY_DEFAULTS)),
  // Suggestion defaults consumed by the CLI suggestions commands
  // (src/memory/cli.ts), which read these values and pass them to
  // generateSuggestions() via SuggestionOptions. Kept in sync with that
  // function's parameter defaults (timeDecayDays=90, skipImportSource=true).
  suggestions: z.object({
    enabled: z.boolean().default(SUGGESTION_DEFAULTS.enabled),
    timeDecayDays: z.number().int().min(1).max(3650).default(SUGGESTION_DEFAULTS.timeDecayDays),
    skipImportSource: z.boolean().default(SUGGESTION_DEFAULTS.skipImportSource),
  }).default(() => structuredClone(SUGGESTION_DEFAULTS)),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = MemoryConfigSchema.parse({});

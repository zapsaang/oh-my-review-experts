import { z } from "zod";

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  directory: z.string().default(".omre/memory"),
  indexing: z.object({
    maxFileSizeKb: z.number().int().min(1).max(100000).default(512),
    includePatterns: z.array(z.string()).default(["**/*.{ts,tsx,js,jsx,py,go,rs,java}"]),
    excludePatterns: z.array(z.string()).default(["node_modules/**", "dist/**", ".git/**", "coverage/**"]),
    autoIndexAfterReview: z.boolean().default(true),
  }).default(() => structuredClone({
    maxFileSizeKb: 512,
    includePatterns: ["**/*.{ts,tsx,js,jsx,py,go,rs,java}"],
    excludePatterns: ["node_modules/**", "dist/**", ".git/**", "coverage/**"],
    autoIndexAfterReview: true,
  })),
  retrieval: z.object({
    enabled: z.boolean().default(false),
    defaultTopK: z.number().int().min(1).max(100).default(5),
    similarityThreshold: z.number().min(0).max(1).default(0.75),
    crossRunDeduplication: z.boolean().default(true),
    maxContextItems: z.number().int().min(1).max(100).default(6),
    maxContextChars: z.number().int().min(1000).max(100000).default(8000),
    includeFixedAsRegressionCandidates: z.boolean().default(true),
    includeFalsePositive: z.boolean().default(false),
    byReviewer: z.record(z.string(), z.object({
      topK: z.number().int().min(1).max(100).optional(),
      enabled: z.boolean().optional(),
      includeReviewers: z.array(z.string()).optional(),
    })).default({}),
  }).default(() => structuredClone({
    enabled: false,
    defaultTopK: 5,
    similarityThreshold: 0.75,
    crossRunDeduplication: true,
    maxContextItems: 6,
    maxContextChars: 8000,
    includeFixedAsRegressionCandidates: true,
    includeFalsePositive: false,
    byReviewer: {},
  })),
  dedupe: z.object({
    fingerprintThreshold: z.number().min(0).max(1).default(0.92),
    contentHashThreshold: z.number().min(0).max(1).default(0.85),
  }).default(() => structuredClone({
    fingerprintThreshold: 0.92,
    contentHashThreshold: 0.85,
  })),
  similarity: z.object({
    tokenWeight: z.number().min(0).max(1).default(0.6),
    semanticWeight: z.number().min(0).max(1).default(0.4),
  }).default(() => structuredClone({
    tokenWeight: 0.6,
    semanticWeight: 0.4,
  })),
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
      enabled: z.boolean().default(true),
      minRawSegments: z.number().int().min(1).max(10000).default(50),
      minRawSegmentBytes: z.number().int().min(1).max(1073741824).default(1048576),
      maxCompactDurationMs: z.number().int().min(1).max(3600000).default(3000),
      autoCompactAfterReview: z.boolean().default(true),
    }).default(() => structuredClone({
      enabled: true,
      minRawSegments: 50,
      minRawSegmentBytes: 1048576,
      maxCompactDurationMs: 3000,
      autoCompactAfterReview: true,
    })),
  ),
  retention: z.object({
    maxEventsPerFinding: z.number().int().min(1).max(100000).default(100),
    maxFindings: z.number().int().min(1).max(1000000).default(5000),
    maxAgeDays: z.number().int().min(1).max(3650).default(365),
    rawSegmentKeepDays: z.number().int().min(1).max(3650).default(30),
    tmpFileMaxAgeHours: z.number().int().min(1).max(8760).default(24),
    maxRawSegments: z.number().int().min(1).max(100000).default(200),
    keepConfirmed: z.boolean().default(true),
    keepHighSeverity: z.boolean().default(true),
  }).default(() => structuredClone({
    maxEventsPerFinding: 100,
    maxFindings: 5000,
    maxAgeDays: 365,
    rawSegmentKeepDays: 30,
    tmpFileMaxAgeHours: 24,
    maxRawSegments: 200,
    keepConfirmed: true,
    keepHighSeverity: true,
  })),
  privacy: z.object({
    redactEvidence: z.boolean().default(true),
    redactProblem: z.boolean().default(false),
    allowedTokensInSearchable: z.array(z.string()).default([]),
  }).default(() => structuredClone({
    redactEvidence: true,
    redactProblem: false,
    allowedTokensInSearchable: [],
  })),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = MemoryConfigSchema.parse({});

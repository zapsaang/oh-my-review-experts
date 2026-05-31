import { z } from "zod";

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  directory: z.string().default(".omre/memory"),
  indexing: z.object({
    maxFileSizeKb: z.number().int().min(1).max(100000).default(512),
    includePatterns: z.array(z.string()).default(["**/*.{ts,tsx,js,jsx,py,go,rs,java}"]),
    excludePatterns: z.array(z.string()).default(["node_modules/**", "dist/**", ".git/**", "coverage/**"]),
  }).default(() => structuredClone({
    maxFileSizeKb: 512,
    includePatterns: ["**/*.{ts,tsx,js,jsx,py,go,rs,java}"],
    excludePatterns: ["node_modules/**", "dist/**", ".git/**", "coverage/**"],
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
  compaction: z.object({
    enabled: z.boolean().default(true),
    maxSegmentsBeforeCompaction: z.number().int().min(1).max(10000).default(50),
    maxSegmentAgeHours: z.number().int().min(1).max(8760).default(168),
  }).default(() => structuredClone({
    enabled: true,
    maxSegmentsBeforeCompaction: 50,
    maxSegmentAgeHours: 168,
  })),
  retention: z.object({
    maxEventsPerFinding: z.number().int().min(1).max(100000).default(100),
    maxFindingsTotal: z.number().int().min(1).max(1000000).default(10000),
    autoCompactAfterReview: z.boolean().default(true),
  }).default(() => structuredClone({
    maxEventsPerFinding: 100,
    maxFindingsTotal: 10000,
    autoCompactAfterReview: true,
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

export const DEFAULT_MEMORY_CONFIG = MemoryConfigSchema.parse({});

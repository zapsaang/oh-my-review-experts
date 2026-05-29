import { z } from "zod";
import { SEVERITY_VALUES } from "../shared/severity.js";

const MEMORY_FINDING_ID_PATTERN = /^mem_[a-z0-9]{16,64}$/;

export const MemoryStatus = z.enum(["open", "acknowledged", "fixed", "false_positive", "wont_fix"]);

const MemoryFindingIdSchema = z.string().regex(MEMORY_FINDING_ID_PATTERN);

export const MemoryFindingSchema = z.object({
  schemaVersion: z.literal(1),
  id: MemoryFindingIdSchema,
  fingerprint: z.string().min(16),
  repo: z.object({
    rootHash: z.string().min(16),
    packagePath: z.string().default("."),
  }),
  origin: z.object({
    runId: z.string().min(1),
    sourceType: z.enum(["report", "manual", "import"]),
    sourcePath: z.string(),
    createdAt: z.string().datetime(),
  }),
  reviewer: z.string().min(1),
  severity: z.enum(SEVERITY_VALUES),
  status: MemoryStatus,
  category: z.string().min(1),
  title: z.string().min(1).max(240),
  problem: z.string().min(1),
  evidence: z.string().min(1),
  locations: z.array(z.object({
    path: z.string(),
    line: z.union([z.number(), z.string()]).optional(),
  })).max(16),
  occurrence: z.object({
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    count: z.number().int().min(1),
    runIds: z.array(z.string()),
  }),
  searchable: z.object({
    redactedText: z.string(),
    tokens: z.array(z.string()).default([]),
  }),
  metadata: z.object({
    evidenceTruncated: z.boolean().default(false),
    problemTruncated: z.boolean().default(false),
    recommendationTruncated: z.boolean().default(false),
    sourceMalformed: z.boolean().default(false),
  }),
  contentHash: z.string().min(16),
});

const MemoryEventBaseSchema = z.object({
  eventId: z.string(),
  at: z.string().datetime(),
});

export const MemoryEventSchema = z.discriminatedUnion("type", [
  MemoryEventBaseSchema.extend({
    type: z.literal("finding.discovered"),
    finding: MemoryFindingSchema,
  }),
  MemoryEventBaseSchema.extend({
    type: z.literal("finding.seen_again"),
    findingId: z.string(),
    runId: z.string(),
    sourcePath: z.string(),
    matchedBy: z.string(),
  }),
  MemoryEventBaseSchema.extend({
    type: z.literal("finding.status_changed"),
    findingId: z.string(),
    from: MemoryStatus,
    to: MemoryStatus,
    markedBy: z.string(),
  }),
  MemoryEventBaseSchema.extend({
    type: z.literal("finding.regressed"),
    findingId: z.string(),
    fromStatus: MemoryStatus,
    toStatus: MemoryStatus,
    runId: z.string(),
  }),
  MemoryEventBaseSchema.extend({
    type: z.literal("finding.related"),
    findingId: z.string(),
    relatedFindingId: z.string(),
    relationType: z.string(),
  }),
]);

const RelatedRelationSchema = z.object({
  findingId: z.string(),
  relatedFindingId: z.string(),
  relationType: z.string(),
});

export const RelatedIndexSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  relations: z.array(RelatedRelationSchema),
  byFindingId: z.record(z.string(), z.array(RelatedRelationSchema)),
});

export const MemoryManifestSchema = z.object({
  schemaVersion: z.literal(1),
  eventSchemaVersion: z.number(),
  viewSchemaVersion: z.number(),
  lastRebuiltAt: z.string().datetime(),
  materializedHash: z.string().min(16),
  relatedIndexHash: z.string().min(16),
  includedEventFiles: z.array(z.string()),
  compactedInputSegments: z.array(z.string()),
  gcSummary: z.object({
    deletedRawSegments: z.number(),
    deletedTmpFiles: z.number(),
    deletedQuarantineFiles: z.number(),
  }),
  quarantine: z.array(z.string()),
});

export const MemoryVersionSchema = z.object({
  schemaVersion: z.literal(1),
  eventSchemaVersion: z.number(),
  viewSchemaVersion: z.number(),
});

export type MemoryFinding = z.infer<typeof MemoryFindingSchema>;
export type MemoryEvent = z.infer<typeof MemoryEventSchema>;
export type RelatedIndex = z.infer<typeof RelatedIndexSchema>;
export type MemoryManifest = z.infer<typeof MemoryManifestSchema>;
export type MemoryVersion = z.infer<typeof MemoryVersionSchema>;

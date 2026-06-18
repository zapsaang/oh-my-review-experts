import { describe, expect, it } from "vitest";
import { OmreConfigSchema } from "../../src/config/schema.js";
import { MemoryConfigSchema } from "../../src/memory/config.js";

describe("MemoryConfigSchema", () => {
  it("defaults memory to enabled", () => {
    const config = MemoryConfigSchema.parse({});

    expect(config.enabled).toBe(true);
  });

  it("defaults memory directory", () => {
    const config = MemoryConfigSchema.parse({});

    expect(config.directory).toBe(".omre/memory");
  });

  it("defaults indexing autoIndexAfterReview", () => {
    const config = MemoryConfigSchema.parse({});

    expect(config.indexing.autoIndexAfterReview).toBe(true);
  });

  it("defaults retrieval defaultTopK", () => {
    const config = MemoryConfigSchema.parse({});

    expect(config.retrieval.defaultTopK).toBe(5);
  });

  it("defaults retrieval enabled", () => {
    const config = MemoryConfigSchema.parse({});

    expect(config.retrieval.enabled).toBe(false);
  });

  it("defaults retrieval maxContextItems", () => {
    const config = MemoryConfigSchema.parse({});

    expect(config.retrieval.maxContextItems).toBe(6);
  });

  it("defaults retrieval maxContextChars", () => {
    const config = MemoryConfigSchema.parse({});

    expect(config.retrieval.maxContextChars).toBe(8000);
  });

  it("defaults retrieval includeFixedAsRegressionCandidates", () => {
    const config = MemoryConfigSchema.parse({});

    expect(config.retrieval.includeFixedAsRegressionCandidates).toBe(true);
  });

  it("defaults retrieval includeFalsePositive", () => {
    const config = MemoryConfigSchema.parse({});

    expect(config.retrieval.includeFalsePositive).toBe(false);
  });

  it("defaults retrieval byReviewer", () => {
    const config = MemoryConfigSchema.parse({});

    expect(config.retrieval.byReviewer).toEqual({});
  });

  it("merges partial byReviewer overrides", () => {
    const config = MemoryConfigSchema.parse({
      retrieval: {
        byReviewer: {
          security: { topK: 10, includeReviewers: ["security", "spec"] },
          quality: { enabled: false },
        },
      },
    });

    expect(config.retrieval.byReviewer).toEqual({
      security: { topK: 10, includeReviewers: ["security", "spec"] },
      quality: { enabled: false },
    });
    expect(config.retrieval.byReviewer.quality.includeReviewers).toBeUndefined();
    expect(config.retrieval.defaultTopK).toBe(5);
  });

  it("merges partial input with defaults", () => {
    const config = MemoryConfigSchema.parse({
      enabled: false,
      retrieval: { defaultTopK: 12 },
      privacy: { allowedTokensInSearchable: ["ticket"] },
    });

    expect(config.enabled).toBe(false);
    expect(config.directory).toBe(".omre/memory");
    expect(config.retrieval.defaultTopK).toBe(12);
    expect(config.retrieval.similarityThreshold).toBe(0.75);
    expect(config.retrieval.crossRunDeduplication).toBe(true);
    expect(config.privacy.redactEvidence).toBe(true);
    expect(config.privacy.redactProblem).toBe(false);
    expect(config.privacy.allowedTokensInSearchable).toEqual(["ticket"]);
  });

  it("rejects dedupe thresholds above one", () => {
    expect(() => MemoryConfigSchema.parse({
      dedupe: { fingerprintThreshold: 1.5 },
    })).toThrow();
  });

  it("rejects dedupe thresholds below zero", () => {
    expect(() => MemoryConfigSchema.parse({
      dedupe: { contentHashThreshold: -0.1 },
    })).toThrow();
  });

  it("rejects maxContextItems below minimum", () => {
    expect(() => MemoryConfigSchema.parse({
      retrieval: { maxContextItems: 0 },
    })).toThrow();
  });

  it("rejects maxContextItems above maximum", () => {
    expect(() => MemoryConfigSchema.parse({
      retrieval: { maxContextItems: 101 },
    })).toThrow();
  });

  it("rejects maxContextChars below minimum", () => {
    expect(() => MemoryConfigSchema.parse({
      retrieval: { maxContextChars: 999 },
    })).toThrow();
  });

  it("rejects maxContextChars above maximum", () => {
    expect(() => MemoryConfigSchema.parse({
      retrieval: { maxContextChars: 100001 },
    })).toThrow();
  });

  it("preserves old retrieval fields", () => {
    const config = MemoryConfigSchema.parse({
      retrieval: {
        defaultTopK: 8,
        similarityThreshold: 0.8,
        crossRunDeduplication: false,
      },
    });

    expect(config.retrieval.defaultTopK).toBe(8);
    expect(config.retrieval.similarityThreshold).toBe(0.8);
    expect(config.retrieval.crossRunDeduplication).toBe(false);
    expect(config.retrieval.enabled).toBe(false);
    expect(config.retrieval.maxContextItems).toBe(6);
    expect(config.retrieval.maxContextChars).toBe(8000);
  });

  it("should accept new config keys", () => {
    const config = MemoryConfigSchema.parse({
      compaction: {
        minRawSegments: 100,
        minRawSegmentBytes: 2097152,
        maxCompactDurationMs: 5000,
      },
      retention: {
        maxFindings: 5000,
        rawSegmentKeepDays: 30,
        tmpFileMaxAgeHours: 48,
      },
    });

    expect(config.compaction.minRawSegments).toBe(100);
    expect(config.compaction.minRawSegmentBytes).toBe(2097152);
    expect(config.compaction.maxCompactDurationMs).toBe(5000);
    expect(config.retention.maxFindings).toBe(5000);
    expect(config.retention.rawSegmentKeepDays).toBe(30);
    expect(config.retention.tmpFileMaxAgeHours).toBe(48);
  });

  it("should default new config fields correctly", () => {
    const config = MemoryConfigSchema.parse({});

    expect(config.compaction.enabled).toBe(true);
    expect(config.compaction.minRawSegments).toBe(50);
    expect(config.compaction.minRawSegmentBytes).toBe(1048576);
    expect(config.compaction.maxCompactDurationMs).toBe(3000);
    expect(config.compaction.autoCompactAfterReview).toBe(true);
    expect(config.retention.maxEventsPerFinding).toBe(100);
    expect(config.retention.maxFindings).toBe(5000);
    expect(config.retention.maxAgeDays).toBe(365);
    expect(config.retention.rawSegmentKeepDays).toBe(30);
    expect(config.retention.tmpFileMaxAgeHours).toBe(24);
    expect(config.retention.maxRawSegments).toBe(200);
    expect(config.retention.keepConfirmed).toBe(true);
    expect(config.retention.keepHighSeverity).toBe(true);
  });

  it("should accept deprecated alias maxSegmentsBeforeCompaction", () => {
    const config = MemoryConfigSchema.parse({
      compaction: { maxSegmentsBeforeCompaction: 75 },
    });

    expect(config.compaction.minRawSegments).toBe(75);
  });

  it("should prefer new key over deprecated alias", () => {
    const config = MemoryConfigSchema.parse({
      compaction: {
        minRawSegments: 100,
        maxSegmentsBeforeCompaction: 75,
      },
    });

    expect(config.compaction.minRawSegments).toBe(100);
  });
});

describe("MemoryConfigSchema - suggestions", () => {
  it("defaults suggestions.enabled to true", () => {
    expect(MemoryConfigSchema.parse({}).suggestions.enabled).toBe(true);
  });

  it("defaults suggestions.timeDecayDays to 90", () => {
    expect(MemoryConfigSchema.parse({}).suggestions.timeDecayDays).toBe(90);
  });

  it("defaults suggestions.skipImportSource to true", () => {
    expect(MemoryConfigSchema.parse({}).suggestions.skipImportSource).toBe(true);
  });

  it("loads config without suggestions section (backward compat)", () => {
    const c = MemoryConfigSchema.parse({ enabled: false });
    expect(c.suggestions).toEqual({ enabled: true, timeDecayDays: 90, skipImportSource: true });
  });

  it("validates timeDecayDays bounds (1..3650)", () => {
    expect(() => MemoryConfigSchema.parse({ suggestions: { timeDecayDays: 0 } })).toThrow();
    expect(() => MemoryConfigSchema.parse({ suggestions: { timeDecayDays: 3651 } })).toThrow();
    expect(MemoryConfigSchema.parse({ suggestions: { timeDecayDays: 1 } }).suggestions.timeDecayDays).toBe(1);
    expect(MemoryConfigSchema.parse({ suggestions: { timeDecayDays: 3650 } }).suggestions.timeDecayDays).toBe(3650);
  });

  it("fills defaults on partial suggestions override", () => {
    expect(MemoryConfigSchema.parse({ suggestions: { enabled: false } }).suggestions).toEqual({ enabled: false, timeDecayDays: 90, skipImportSource: true });
  });
});

describe("OmreConfigSchema memory integration", () => {
  it("injects default memory config", () => {
    const config = OmreConfigSchema.parse({});

    expect(config.memory.enabled).toBe(true);
    expect(config.memory.directory).toBe(".omre/memory");
    expect(config.memory.retrieval.defaultTopK).toBe(5);
  });

  it("overrides only provided memory fields", () => {
    const config = OmreConfigSchema.parse({ memory: { enabled: false } });

    expect(config.memory.enabled).toBe(false);
    expect(config.memory.directory).toBe(".omre/memory");
    expect(config.memory.retrieval.defaultTopK).toBe(5);
  });

  it("does not add configSchemaVersion", () => {
    const config = OmreConfigSchema.parse({});

    expect("configSchemaVersion" in config).toBe(false);
  });
});

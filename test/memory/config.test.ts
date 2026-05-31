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
          security: { topK: 10 },
        },
      },
    });

    expect(config.retrieval.byReviewer).toEqual({
      security: { topK: 10 },
    });
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

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

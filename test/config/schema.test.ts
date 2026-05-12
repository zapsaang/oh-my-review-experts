import { describe, it, expect } from "vitest";
import { OmreConfigSchema, DEFAULT_CONFIG, ReviewDimension, SliceType } from "../../src/config/schema.js";

describe("OmreConfigSchema", () => {
  it("parses empty object with defaults", () => {
    const result = OmreConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.command.name).toBe("review-code");
    expect(result.slicing.maxSlices).toBe(4);
    expect(result.costGuardrail.maxEstimatedTasks).toBe(24);
    expect(result.report.timestamped).toBe(true);
  });

  it("accepts valid full config", () => {
    const cfg = {
      enabled: false,
      command: { enabled: false, name: "review", aliases: ["r"], injection: "disabled" },
      models: { orchestrator: "gpt-4", spec: "gpt-4" },
      slicing: { enabled: false, maxSlices: 1, skipDocsOnly: false, skipTestOnlyHeavyReview: false, forceWholeTargetAboveSlices: 8 },
      partialRerun: { enabled: false, maxRetriesPerTask: 0 },
      costGuardrail: { enabled: false, maxEstimatedTasks: 10, compactModeThreshold: 5, hardStopThreshold: 20 },
      report: { enabled: false, directory: "reports", latestMarkdown: "out.md", latestJson: "out.json", timestamped: false },
      reviewers: { default: ["spec", "security"], bySliceType: { "docs-only": [] } },
    };
    const result = OmreConfigSchema.parse(cfg);
    expect(result.enabled).toBe(false);
    expect(result.command.name).toBe("review");
    expect(result.models.orchestrator).toBe("gpt-4");
    expect(result.reviewers.default).toEqual(["spec", "security"]);
  });

  it("rejects invalid maxSlices", () => {
    expect(() => OmreConfigSchema.parse({ slicing: { maxSlices: 0 } })).toThrow();
    expect(() => OmreConfigSchema.parse({ slicing: { maxSlices: 100 } })).toThrow();
  });

  it("rejects invalid maxRetriesPerTask above contract limit", () => {
    expect(() => OmreConfigSchema.parse({ partialRerun: { maxRetriesPerTask: 2 } })).toThrow();
    expect(() => OmreConfigSchema.parse({ partialRerun: { maxRetriesPerTask: 3 } })).toThrow();
  });

  it("accepts valid maxRetriesPerTask within contract limit", () => {
    expect(() => OmreConfigSchema.parse({ partialRerun: { maxRetriesPerTask: 0 } })).not.toThrow();
    expect(() => OmreConfigSchema.parse({ partialRerun: { maxRetriesPerTask: 1 } })).not.toThrow();
  });

  it("rejects invalid injection value", () => {
    expect(() => OmreConfigSchema.parse({ command: { injection: "invalid" } })).toThrow();
  });

  it("rejects empty command name", () => {
    expect(() => OmreConfigSchema.parse({ command: { name: "" } })).toThrow();
  });

  it("rejects command name with whitespace", () => {
    expect(() => OmreConfigSchema.parse({ command: { name: "review code" } })).toThrow();
  });

  it("rejects command name with slash", () => {
    expect(() => OmreConfigSchema.parse({ command: { name: "review/code" } })).toThrow();
  });

  it("rejects command name __proto__", () => {
    expect(() => OmreConfigSchema.parse({ command: { name: "__proto__" } })).toThrow();
  });

  it("rejects command alias with invalid characters", () => {
    expect(() => OmreConfigSchema.parse({ command: { aliases: ["rc", "review code"] } })).toThrow();
  });

  it("fills missing model fields with default", () => {
    const result = OmreConfigSchema.parse({ models: { orchestrator: "custom-model" } });
    expect(result.models.orchestrator).toBe("custom-model");
    expect(result.models.spec).toBeDefined();
  });

  it("parses arbitration config with default hierarchicalThreshold", () => {
    const result = OmreConfigSchema.parse({});
    expect(result.arbitration.hierarchicalThreshold).toBe(3);
  });

  it("accepts custom arbitration config", () => {
    const result = OmreConfigSchema.parse({ arbitration: { hierarchicalThreshold: 5 } });
    expect(result.arbitration.hierarchicalThreshold).toBe(5);
  });

  it("rejects invalid hierarchicalThreshold", () => {
    expect(() => OmreConfigSchema.parse({ arbitration: { hierarchicalThreshold: 0 } })).toThrow();
    expect(() => OmreConfigSchema.parse({ arbitration: { hierarchicalThreshold: 33 } })).toThrow();
  });

  it("uses DEFAULT_CONFIG as valid baseline", () => {
    expect(() => OmreConfigSchema.parse(DEFAULT_CONFIG)).not.toThrow();
  });
});

describe("ReviewDimension enum", () => {
  it("contains expected values", () => {
    const values = ReviewDimension.options;
    expect(values).toContain("spec");
    expect(values).toContain("quality");
    expect(values).toContain("security");
    expect(values).toContain("performance");
    expect(values).toContain("concurrency");
  });
});

describe("SliceType enum", () => {
  it("contains expected values", () => {
    const values = SliceType.options;
    expect(values).toContain("business-module");
    expect(values).toContain("docs-only");
    expect(values).toContain("test-only");
  });
});

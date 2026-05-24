import { describe, it, expect } from "vitest";
import { OmreConfigSchema, AgentConfigSchema, DEFAULT_CONFIG, ReviewDimension, SliceType } from "../../src/config/schema.js";

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
      slicing: { enabled: false, maxSlices: 1, skipDocsOnly: false, skipTestOnlyHeavyReview: false, forceWholeTargetAboveSlices: 8 },
      partialRerun: { enabled: false, maxRetriesPerTask: 0 },
      costGuardrail: { enabled: false, maxEstimatedTasks: 10, compactModeThreshold: 5, hardStopThreshold: 20 },
      report: { enabled: false, directory: "reports", latestMarkdown: "out.md", latestJson: "out.json", timestamped: false },
      reviewers: { default: ["spec", "security"], bySliceType: { "docs-only": [] } },
    };
    const result = OmreConfigSchema.parse(cfg);
    expect(result.enabled).toBe(false);
    expect(result.command.name).toBe("review");
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

  it("returns isolated defaults across parse calls", () => {
    const config1 = OmreConfigSchema.parse({});
    config1.command.aliases.push("hack");
    config1.reviewers.bySliceType["business-module"].push("concurrency");

    const config2 = OmreConfigSchema.parse({});
    expect(config2.command.aliases).toEqual(["rc"]);
    expect(config2.reviewers.bySliceType["business-module"]).toEqual([
      "spec", "security", "performance", "concurrency"
    ]);
  });

  it("preserves default reviewers for omitted slice types in partial config", () => {
    const config = OmreConfigSchema.parse({
      reviewers: {
        bySliceType: { "docs-only": [] }
      }
    });

    expect(config.reviewers.bySliceType["docs-only"]).toEqual([]);
    expect(config.reviewers.bySliceType["business-module"]).toEqual([
      "spec", "security", "performance", "concurrency"
    ]);
    expect(config.reviewers.bySliceType["migration"]).toEqual([
      "spec", "performance", "concurrency"
    ]);
    expect(config.reviewers.bySliceType["test-only"]).toEqual([
      "spec", "quality"
    ]);
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

describe("Forbidden command names", () => {
  it("rejects command name constructor with custom code", () => {
    const result = OmreConfigSchema.safeParse({ command: { name: "constructor" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("name"));
      expect(issue).toBeDefined();
      expect(issue!.path).toContain("name");
      expect(issue!.code).toBe("custom");
    }
  });

  it("rejects command name prototype with custom code", () => {
    const result = OmreConfigSchema.safeParse({ command: { name: "prototype" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("name"));
      expect(issue).toBeDefined();
      expect(issue!.path).toContain("name");
      expect(issue!.code).toBe("custom");
    }
  });

  it("rejects forbidden alias __proto__ with custom code", () => {
    const result = OmreConfigSchema.safeParse({ command: { aliases: ["__proto__"] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("aliases"));
      expect(issue).toBeDefined();
      expect(issue!.path).toContain("aliases");
      expect(issue!.code).toBe("custom");
    }
  });

  it("rejects forbidden alias constructor with custom code", () => {
    const result = OmreConfigSchema.safeParse({ command: { aliases: ["rc", "constructor"] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("aliases"));
      expect(issue).toBeDefined();
      expect(issue!.path).toContain("aliases");
      expect(issue!.code).toBe("custom");
    }
  });

  it("rejects forbidden alias prototype with custom code", () => {
    const result = OmreConfigSchema.safeParse({ command: { aliases: ["prototype"] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("aliases"));
      expect(issue).toBeDefined();
      expect(issue!.path).toContain("aliases");
      expect(issue!.code).toBe("custom");
    }
  });
});

describe("AgentConfigSchema", () => {
  it("accepts a minimal agent config with model only", () => {
    const result = OmreConfigSchema.parse({ agents: { "omre-reviewer-spec": { model: "anthropic/claude-opus-4-7" } } });
    expect(result.agents["omre-reviewer-spec"]!.model).toBe("anthropic/claude-opus-4-7");
  });

  it("accepts all valid parameters", () => {
    const result = OmreConfigSchema.parse({
      agents: {
        "omre-reviewer-spec": {
          model: "anthropic/claude-opus-4-7",
          variant: "max",
          temperature: 0.7,
          top_p: 0.9,
        },
      },
    });
    const agent = result.agents["omre-reviewer-spec"]!;
    expect(agent.variant).toBe("max");
    expect(agent.temperature).toBe(0.7);
    expect(agent.top_p).toBe(0.9);
  });

  it("rejects unknown agent names", () => {
    const result = OmreConfigSchema.safeParse({ agents: { "omre-reviewer-typo": { model: "x" } } });
    expect(result.success).toBe(false);
  });

  it("rejects invalid variant values", () => {
    const result = AgentConfigSchema.safeParse({ model: "x", variant: "ultra!" });
    expect(result.success).toBe(false);
  });

  describe("variant accepts any valid passthrough string", () => {
    it("accepts xhigh", () => {
      const result = AgentConfigSchema.safeParse({ model: "x", variant: "xhigh" });
      expect(result.success).toBe(true);
      expect(result.data?.variant).toBe("xhigh");
    });

    it("accepts turbo", () => {
      const result = AgentConfigSchema.safeParse({ model: "x", variant: "turbo" });
      expect(result.success).toBe(true);
      expect(result.data?.variant).toBe("turbo");
    });

    it("accepts high", () => {
      const result = AgentConfigSchema.safeParse({ model: "x", variant: "high" });
      expect(result.success).toBe(true);
      expect(result.data?.variant).toBe("high");
    });

    it("accepts max", () => {
      const result = AgentConfigSchema.safeParse({ model: "x", variant: "max" });
      expect(result.success).toBe(true);
      expect(result.data?.variant).toBe("max");
    });
  });

  describe("variant rejects malformed strings", () => {
    it("rejects empty string", () => {
      const result = AgentConfigSchema.safeParse({ model: "x", variant: "" });
      expect(result.success).toBe(false);
    });

    it("rejects whitespace", () => {
      const result = AgentConfigSchema.safeParse({ model: "x", variant: "max " });
      expect(result.success).toBe(false);
    });

    it("rejects zero-width space", () => {
      const result = AgentConfigSchema.safeParse({ model: "x", variant: "xhigh\u200B" });
      expect(result.success).toBe(false);
    });

    it("rejects >32 chars", () => {
      const result = AgentConfigSchema.safeParse({ model: "x", variant: "a".repeat(33) });
      expect(result.success).toBe(false);
    });

    it("rejects special chars", () => {
      const result = AgentConfigSchema.safeParse({ model: "x", variant: "max!" });
      expect(result.success).toBe(false);
    });
  });

  it("accepts temperature: 0", () => {
    const result = AgentConfigSchema.safeParse({ model: "x", temperature: 0 });
    expect(result.success).toBe(true);
    expect(result.data?.temperature).toBe(0);
  });

  it("accepts top_p: 0", () => {
    const result = AgentConfigSchema.safeParse({ model: "x", top_p: 0 });
    expect(result.success).toBe(true);
    expect(result.data?.top_p).toBe(0);
  });
});

describe("OmreConfigSchema agents field", () => {
  it("default is empty object when not provided", () => {
    const result = OmreConfigSchema.parse({});
    expect(result.agents).toEqual({});
  });

  it("parses empty agents object", () => {
    const result = OmreConfigSchema.parse({ agents: {} });
    expect(result.agents).toEqual({});
  });

  it("strips unknown top-level keys (old models, provider, disable_provider_inference)", () => {
    const result = OmreConfigSchema.parse({ models: { spec: "x" }, provider: "anthropic", disable_provider_inference: true });
    const keys = Object.keys(result);
    expect(keys).not.toContain("models");
    expect(keys).not.toContain("provider");
    expect(keys).not.toContain("disable_provider_inference");
  });
});

import { describe, it, expect } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import {
  resolveModelForAgent,
  resolveModelsWithInference,
  resolveProviderFromOpenCodeConfig,
} from "../../src/config/provider-presets.js";

describe("resolveProviderFromOpenCodeConfig", () => {
  it("returns provider prefix from model string with slash", () => {
    const config = { model: "openai/gpt-5.5" } as Config;
    expect(resolveProviderFromOpenCodeConfig(config)).toBe("openai");
  });

  it("returns provider prefix from another model string with slash", () => {
    const config = { model: "anthropic/claude-opus-4-7" } as Config;
    expect(resolveProviderFromOpenCodeConfig(config)).toBe("anthropic");
  });

  it("returns undefined when model has no slash", () => {
    const config = { model: "noslash" } as Config;
    expect(resolveProviderFromOpenCodeConfig(config)).toBeUndefined();
  });

  it("returns single provider key when model is undefined and no enabled/disabled lists", () => {
    const config = { model: undefined, provider: { openai: {} } } as Config;
    expect(resolveProviderFromOpenCodeConfig(config)).toBe("openai");
  });

  it("returns enabled provider when enabled_providers filters multiple providers", () => {
    const config = {
      provider: { openai: {}, anthropic: {} },
      enabled_providers: ["openai"],
    } as Config;
    expect(resolveProviderFromOpenCodeConfig(config)).toBe("openai");
  });

  it("returns undefined when the only provider is disabled", () => {
    const config = {
      provider: { openai: {} },
      disabled_providers: ["openai"],
    } as Config;
    expect(resolveProviderFromOpenCodeConfig(config)).toBeUndefined();
  });

  it("disabled_providers wins over enabled_providers", () => {
    const config = {
      provider: { openai: {}, anthropic: {} },
      enabled_providers: ["openai", "anthropic"],
      disabled_providers: ["anthropic"],
    } as Config;
    expect(resolveProviderFromOpenCodeConfig(config)).toBe("openai");
  });

  it("returns undefined for empty config and does not throw on null or non-object values", () => {
    expect(resolveProviderFromOpenCodeConfig({} as Config)).toBeUndefined();
    expect(() => resolveProviderFromOpenCodeConfig(null as unknown as Config)).not.toThrow();
    expect(() => resolveProviderFromOpenCodeConfig("string" as unknown as Config)).not.toThrow();
    expect(() => resolveProviderFromOpenCodeConfig(42 as unknown as Config)).not.toThrow();
  });
});

import type { ModelKey } from "../../src/agents/registry.js";

describe("ModelKey export", () => {
  it("ModelKey exports include all 11 keys (compile-time)", () => {
    const probe: Record<ModelKey, true> = {
      orchestrator: true, spec: true, quality: true, security: true,
      performance: true, concurrency: true, slicePlanner: true,
      validator: true, sliceArbiter: true, globalArbiter: true, reportWriter: true,
    };
    expect(Object.keys(probe).length).toBe(11);
  });
});

const DEFAULT_MODEL = "minimax-cn/MiniMax-M2.7";

function defaultModels(): Record<ModelKey, string> {
  return {
    orchestrator: DEFAULT_MODEL,
    spec: DEFAULT_MODEL,
    quality: DEFAULT_MODEL,
    security: DEFAULT_MODEL,
    performance: DEFAULT_MODEL,
    concurrency: DEFAULT_MODEL,
    slicePlanner: DEFAULT_MODEL,
    validator: DEFAULT_MODEL,
    sliceArbiter: DEFAULT_MODEL,
    globalArbiter: DEFAULT_MODEL,
    reportWriter: DEFAULT_MODEL,
  };
}

const openAiModels: Record<ModelKey, string> = {
  orchestrator: "openai/gpt-5.4-mini",
  spec: "openai/gpt-5.5",
  quality: "openai/gpt-5.5",
  security: "openai/gpt-5.5",
  performance: "openai/gpt-5.5",
  concurrency: "openai/gpt-5.5",
  slicePlanner: "openai/gpt-5.4-mini",
  validator: "openai/gpt-5.4-nano",
  sliceArbiter: "openai/gpt-5.4-mini",
  globalArbiter: "openai/gpt-5.4-mini",
  reportWriter: "openai/gpt-5.4-nano",
};

describe("resolveModelForAgent", () => {
  it("resolves critical OpenAI agents to the critical preset", () => {
    expect(resolveModelForAgent("spec", "openai", {} as Config, DEFAULT_MODEL)).toBe("openai/gpt-5.5");
  });

  it("resolves utility OpenAI agents to the utility preset", () => {
    expect(resolveModelForAgent("reportWriter", "openai", {} as Config, DEFAULT_MODEL)).toBe("openai/gpt-5.4-nano");
  });

  it("honors same-provider small_model for utility agents", () => {
    const config = { small_model: "openai/gpt-5.4-mini" } as Config;
    expect(resolveModelForAgent("reportWriter", "openai", config, DEFAULT_MODEL)).toBe("openai/gpt-5.4-mini");
  });

  it("ignores different-provider small_model for utility agents", () => {
    const config = { small_model: "anthropic/claude-haiku-4-5" } as Config;
    expect(resolveModelForAgent("reportWriter", "openai", config, DEFAULT_MODEL)).toBe("openai/gpt-5.4-nano");
  });

  it("ignores small_model for critical agents", () => {
    const config = { small_model: "openai/gpt-5.4-mini" } as Config;
    expect(resolveModelForAgent("spec", "openai", config, DEFAULT_MODEL)).toBe("openai/gpt-5.5");
  });

  it("falls back for unknown providers", () => {
    expect(resolveModelForAgent("spec", "unknown-provider", {} as Config, DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
  });

  it("resolves orchestrator to the coordination preset", () => {
    expect(resolveModelForAgent("orchestrator", "openai", {} as Config, DEFAULT_MODEL)).toBe("openai/gpt-5.4-mini");
  });
});

describe("resolveModelsWithInference", () => {
  it("replaces all default models with OpenAI presets when no keys are explicit", () => {
    const models = defaultModels();
    const result = resolveModelsWithInference(models, "openai", {} as Config, new Set<ModelKey>());

    expect(result).toEqual(openAiModels);
    expect(models).toEqual(defaultModels());
  });

  it("retains explicit spec override and replaces other models", () => {
    const result = resolveModelsWithInference(defaultModels(), "openai", {} as Config, new Set<ModelKey>(["spec"]));

    expect(result).toEqual({ ...openAiModels, spec: DEFAULT_MODEL });
  });

  it("retains explicit spec override even when the user value equals the default model", () => {
    const models = { ...defaultModels(), spec: DEFAULT_MODEL };
    const result = resolveModelsWithInference(models, "openai", {} as Config, new Set<ModelKey>(["spec"]));

    expect(result.spec).toBe(DEFAULT_MODEL);
    expect(result.quality).toBe("openai/gpt-5.5");
  });

  it("leaves all models unchanged for unknown providers", () => {
    const models = defaultModels();
    const result = resolveModelsWithInference(models, "azure-mystery", {} as Config, new Set<ModelKey>());

    expect(result).toEqual(defaultModels());
  });

  it("uses Anthropic presets with same-provider small_model for utility and coordination tiers", () => {
    const config = { small_model: "anthropic/claude-haiku-4-5" } as Config;
    const result = resolveModelsWithInference(defaultModels(), "anthropic", config, new Set<ModelKey>());

    expect(result).toEqual({
      orchestrator: "anthropic/claude-haiku-4-5",
      spec: "anthropic/claude-opus-4-7",
      quality: "anthropic/claude-sonnet-4-6",
      security: "anthropic/claude-opus-4-7",
      performance: "anthropic/claude-sonnet-4-6",
      concurrency: "anthropic/claude-sonnet-4-6",
      slicePlanner: "anthropic/claude-haiku-4-5",
      validator: "anthropic/claude-haiku-4-5",
      sliceArbiter: "anthropic/claude-haiku-4-5",
      globalArbiter: "anthropic/claude-haiku-4-5",
      reportWriter: "anthropic/claude-haiku-4-5",
    });
  });
});

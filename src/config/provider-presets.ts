import type { Config } from "@opencode-ai/plugin";
import type { ModelKey } from "../agents/registry.js";
import type { OmreConfig } from "./schema.js";

export type Tier = "critical" | "standard" | "coordination" | "utility";

export const AGENT_TIER_MAP: Record<ModelKey, Tier> = {
  spec: "critical",
  security: "critical",
  quality: "standard",
  performance: "standard",
  concurrency: "standard",
  slicePlanner: "coordination",
  sliceArbiter: "coordination",
  globalArbiter: "coordination",
  validator: "utility",
  reportWriter: "utility",
  orchestrator: "coordination",
};

export const PROVIDER_MODEL_PRESETS: Record<string, Record<Tier, string>> = {
  openai: {
    critical: "openai/gpt-5.5",
    standard: "openai/gpt-5.5",
    coordination: "openai/gpt-5.4-mini",
    utility: "openai/gpt-5.4-nano",
  },
  anthropic: {
    critical: "anthropic/claude-opus-4-7",
    standard: "anthropic/claude-sonnet-4-6",
    coordination: "anthropic/claude-sonnet-4-6",
    utility: "anthropic/claude-haiku-4-5",
  },
  google: {
    critical: "google/gemini-2.5-pro",
    standard: "google/gemini-2.5-pro",
    coordination: "google/gemini-2.5-flash",
    utility: "google/gemini-2.5-flash-lite",
  },
  "minimax-cn": {
    critical: "minimax-cn/MiniMax-M2.7",
    standard: "minimax-cn/MiniMax-M2.7",
    coordination: "minimax-cn/MiniMax-M2.7",
    utility: "minimax-cn/MiniMax-M2.7",
  },
  deepseek: {
    critical: "deepseek/deepseek-reasoner",
    standard: "deepseek/deepseek-chat",
    coordination: "deepseek/deepseek-chat",
    utility: "deepseek/deepseek-chat",
  },
};

export function resolveProviderFromOpenCodeConfig(c: Config | undefined | null): string | undefined {
  if (!c || typeof c !== "object" || Array.isArray(c)) return undefined;

  if (typeof c.model === "string" && c.model.includes("/")) {
    return c.model.split("/")[0];
  }

  if (c.provider && typeof c.provider === "object" && !Array.isArray(c.provider)) {
    const keys = Object.keys(c.provider);
    if (keys.length === 1) return keys[0];
  }

  return undefined;
}

export function resolveModelForAgent(
  modelKey: ModelKey,
  providerID: string,
  ocConfig: Config,
  fallback: string,
): string {
  const tier = AGENT_TIER_MAP[modelKey];
  const preset = PROVIDER_MODEL_PRESETS[providerID];

  if (!preset) return fallback;

  if (
    (tier === "utility" || tier === "coordination") &&
    typeof ocConfig.small_model === "string" &&
    ocConfig.small_model.startsWith(`${providerID}/`)
  ) {
    return ocConfig.small_model;
  }

  return preset[tier] ?? fallback;
}

export function resolveModelsWithInference(
  models: OmreConfig["models"],
  providerID: string,
  ocConfig: Config,
  explicitOverrides: ReadonlySet<ModelKey>,
): OmreConfig["models"] {
  const result = { ...models };
  for (const key of Object.keys(result) as ModelKey[]) {
    if (explicitOverrides.has(key)) continue;
    result[key] = resolveModelForAgent(key, providerID, ocConfig, models[key]);
  }
  return result;
}

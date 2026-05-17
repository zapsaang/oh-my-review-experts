import { describe, it, expect, beforeEach } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import {
  registerAgents,
  AGENT_NAMES,
  REVIEWER_AGENTS,
  COORDINATOR_AGENTS,
  ALL_AGENTS,
  type RegistrationResult,
} from "../../src/agents/registry.js";
import { DEFAULT_CONFIG, type OmreConfig } from "../../src/config/schema.js";
import { clearLoadConfigCache } from "../../src/config/load-config.js";

const REVIEWER_NAMES = REVIEWER_AGENTS.map((a) => a.name);

function freshOmreConfig(): OmreConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function freshConfig(): Config {
  return {} as Config;
}

beforeEach(() => {
  clearLoadConfigCache();
});

describe("registry: registerAgents", () => {
  it("[step 1] registerAgents exists and returns RegistrationResult", () => {
    const config = freshConfig();
    const result: RegistrationResult = registerAgents(config, freshOmreConfig());
    expect(result).toBeDefined();
    expect(Array.isArray(result.registered)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
  });
});

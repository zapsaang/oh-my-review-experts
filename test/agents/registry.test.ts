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

  it("[step 2] registers exactly 11 agents (5 reviewers + 6 coordinators)", () => {
    const config = freshConfig();
    const result = registerAgents(config, freshOmreConfig());

    expect(REVIEWER_AGENTS.length).toBe(5);
    expect(COORDINATOR_AGENTS.length).toBe(6);
    expect(ALL_AGENTS.length).toBe(11);
    expect(AGENT_NAMES.length).toBe(11);

    const expected = [
      "reviewer-spec",
      "reviewer-quality",
      "reviewer-security",
      "reviewer-performance",
      "reviewer-concurrency",
      "slice-planner",
      "slice-plan-validator",
      "result-validator",
      "slice-arbiter",
      "global-arbiter",
      "report-writer",
    ];
    expect([...AGENT_NAMES].sort()).toEqual([...expected].sort());
    expect([...result.registered].sort()).toEqual([...expected].sort());
    expect(result.skipped).toEqual([]);
  });
});

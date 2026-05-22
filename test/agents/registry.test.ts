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
      "omre-reviewer-spec",
      "omre-reviewer-quality",
      "omre-reviewer-security",
      "omre-reviewer-performance",
      "omre-reviewer-concurrency",
      "omre-slice-planner",
      "omre-slice-plan-validator",
      "omre-result-validator",
      "omre-slice-arbiter",
      "omre-global-arbiter",
      "omre-report-writer",
    ];
    expect([...AGENT_NAMES].sort()).toEqual([...expected].sort());
    expect([...result.registered].sort()).toEqual([...expected].sort());
    expect(result.skipped).toEqual([]);
  });
});

describe.each(AGENT_NAMES)("registry: agent %s shape", (name) => {
  function registeredSlot(): Record<string, unknown> {
    const config = freshConfig();
    registerAgents(config, freshOmreConfig());
    const slot = (config.agent as Record<string, unknown>)[name];
    expect(slot).toBeDefined();
    return slot as Record<string, unknown>;
  }

  it("[step 3] mode === 'subagent'", () => {
    expect(registeredSlot().mode).toBe("subagent");
  });

  it("[step 4] hidden === false && disable === false", () => {
    const slot = registeredSlot();
    expect(slot.hidden).toBe(false);
    expect(slot.disable).toBe(false);
  });

  it("[step 5] model resolves from agents[name] or DEFAULT_MODEL", () => {
    const omre = freshOmreConfig();
    omre.agents["omre-reviewer-spec"] = { model: "test-model-spec" };
    const config = freshConfig();
    registerAgents(config, omre);
    const slot = (config.agent as Record<string, unknown>)["omre-reviewer-spec"] as Record<string, unknown>;
    expect(slot.model).toBe("test-model-spec");
  });

  it("[step 7] prompt does not contain a runId timestamp", () => {
    const slot = registeredSlot();
    const prompt = String(slot.prompt ?? "");
    expect(prompt).not.toMatch(/\d{8}-\d{6}-\d{3}/);
  });

  it("[step 11] permission denies edit, bash, webfetch, websearch, doom_loop, external_directory", () => {
    const slot = registeredSlot();
    const permission = slot.permission as Record<string, string>;
    expect(permission.edit).toBe("deny");
    expect(permission.bash).toBe("deny");
    expect(permission.webfetch).toBe("deny");
    expect(permission.websearch).toBe("deny");
    expect(permission.doom_loop).toBe("deny");
    expect(permission.external_directory).toBe("deny");
  });
});

describe.each(REVIEWER_NAMES)("registry: reviewer %s prompt + tools", (name) => {
  function reviewerSlot(): Record<string, unknown> {
    const config = freshConfig();
    registerAgents(config, freshOmreConfig());
    return (config.agent as Record<string, unknown>)[name] as Record<string, unknown>;
  }

  it("[step 6] prompt contains the FILE_HANDOFF_CONTRACT signature", () => {
    const prompt = String(reviewerSlot().prompt ?? "");
    expect(prompt).toContain("Output strict JSON only when asked");
  });

  it("[L2 fix] reviewer staticPrompt embeds the file-output channel rules", () => {
    const prompt = String(reviewerSlot().prompt ?? "");
    expect(prompt, name).toContain("omre_write_handoff");
    expect(prompt, name).toMatch(/```json/);
    expect(prompt, name).toContain("HANDOFF_FILE:");
  });

  it("[L2 fix] reviewer staticPrompt is template-only (no runId or absolute handoff path)", () => {
    const prompt = String(reviewerSlot().prompt ?? "");
    expect(prompt, name).not.toMatch(/\d{8}-\d{6}-\d{3}/);
    expect(prompt, name).toMatch(/\{handoffDir\}\/\{runId\}/);
  });

  it("[L2 fix] reviewer staticPrompt explicitly forbids emitting a json fence in chat", () => {
    const prompt = String(reviewerSlot().prompt ?? "");
    expect(prompt, name).toMatch(/never include[^.]*json fence[^.]*chat/i);
  });

  it("[step 8] tools deny baseline (task, skill, edit, write, bash, webfetch, todowrite, websearch)", () => {
    const slot = reviewerSlot();
    const tools = slot.tools as Record<string, boolean>;
    expect(tools.task).toBe(false);
    expect(tools.skill).toBe(false);
    expect(tools.edit).toBe(false);
    expect(tools.write).toBe(false);
    expect(tools.bash).toBe(false);
    expect(tools.webfetch).toBe(false);
    expect(tools.todowrite).toBe(false);
    expect(tools.websearch).toBe(false);
  });
});

describe("registry: tool-flag uniqueness", () => {
  function allSlots(): Array<{ name: string; tools: Record<string, boolean> }> {
    const config = freshConfig();
    registerAgents(config, freshOmreConfig());
    return ALL_AGENTS.map((a) => ({
      name: a.name,
      tools: ((config.agent as Record<string, unknown>)[a.name] as Record<string, unknown>).tools as Record<string, boolean>,
    }));
  }

  it("[step 9] only omre-report-writer has omre_write_report === true", () => {
    const slots = allSlots();
    const writers = slots.filter((s) => s.tools.omre_write_report === true).map((s) => s.name);
    expect(writers).toEqual(["omre-report-writer"]);
    for (const s of slots) {
      if (s.name !== "omre-report-writer") {
        expect(s.tools.omre_write_report ?? false).toBe(false);
      }
    }
  });

  it("[step 10] only the 5 reviewers have omre_write_handoff === true", () => {
    const slots = allSlots();
    const writers = slots.filter((s) => s.tools.omre_write_handoff === true).map((s) => s.name).sort();
    expect(writers).toEqual([...REVIEWER_NAMES].sort());
    for (const s of slots) {
      if (!REVIEWER_NAMES.includes(s.name as typeof REVIEWER_NAMES[number])) {
        expect(s.tools.omre_write_handoff ?? false).toBe(false);
      }
    }
  });
});

describe("registry: coordinator chat-only output contract [L3 fix]", () => {
  function coordinatorSlot(name: string): Record<string, unknown> {
    const config = freshConfig();
    registerAgents(config, freshOmreConfig());
    return (config.agent as Record<string, unknown>)[name] as Record<string, unknown>;
  }

  const COORDINATOR_NAMES_FOR_CHAT = COORDINATOR_AGENTS
    .filter((a) => a.name !== "omre-report-writer")
    .map((a) => a.name);

  it.each(COORDINATOR_NAMES_FOR_CHAT)(
    "%s prompt declares the chat-only contract (no fence, no outside-JSON prose)",
    (name) => {
      const prompt = String(coordinatorSlot(name).prompt ?? "");
      expect(prompt, name).toContain("Output exactly one JSON object as your entire chat reply");
      expect(prompt, name).toContain("Do not wrap in markdown fences");
      expect(prompt, name).toContain("Do not emit any text outside the JSON");
    },
  );

  it.each(COORDINATOR_NAMES_FOR_CHAT)(
    "%s prompt explicitly tells the agent it has no write tool",
    (name) => {
      const prompt = String(coordinatorSlot(name).prompt ?? "");
      const hasWriteTool = (COORDINATOR_AGENTS.find((a) => a.name === name)?.toolsAllow ?? [])
        .some((t) => t === "omre_write_handoff" || t === "omre_write_report");
      if (hasWriteTool) return;
      expect(prompt, name).toMatch(/do not (call|use|invoke)\s+omre_write_handoff/i);
    },
  );

  it("omre-report-writer prompt does NOT declare chat-only (it persists via omre_write_report)", () => {
    const prompt = String(coordinatorSlot("omre-report-writer").prompt ?? "");
    expect(prompt).not.toContain("Output exactly one JSON object as your entire chat reply");
  });
});

describe("registry: behavioral guarantees", () => {
  it("[step 12] user override at config.agent[name] is preserved (skip-on-conflict)", () => {
    const userEntry = { prompt: "USER_OVERRIDE_MARKER" };
    const config = { agent: { "omre-reviewer-security": userEntry } } as unknown as Config;

    const result = registerAgents(config, freshOmreConfig());

    const slot = (config.agent as Record<string, unknown>)["omre-reviewer-security"];
    expect(slot).toBe(userEntry);
    expect((slot as { prompt: string }).prompt).toBe("USER_OVERRIDE_MARKER");
    expect(result.skipped).toContain("omre-reviewer-security");
    expect(result.registered).not.toContain("omre-reviewer-security");
    expect(result.registered.length).toBe(10);
  });

  it("[step 13] re-invocation is idempotent and preserves object identity", () => {
    const config = freshConfig();
    const first = registerAgents(config, freshOmreConfig());
    expect(first.registered.length).toBe(11);
    expect(first.skipped).toEqual([]);

    const snapshots = new Map<string, unknown>();
    for (const name of AGENT_NAMES) {
      snapshots.set(name, (config.agent as Record<string, unknown>)[name]);
    }

    const second = registerAgents(config, freshOmreConfig());
    expect(second.registered).toEqual([]);
    expect([...second.skipped].sort()).toEqual([...AGENT_NAMES].sort());

    for (const name of AGENT_NAMES) {
      const after = (config.agent as Record<string, unknown>)[name];
      expect(Object.is(snapshots.get(name), after)).toBe(true);
    }
  });

  it("[step 14] enabled === false short-circuits and does not mutate config.agent", () => {
    const omre = freshOmreConfig();
    omre.enabled = false;
    const config = freshConfig();

    const result = registerAgents(config, omre);

    expect(result).toEqual({ registered: [], skipped: [] });
    expect(config.agent).toBeUndefined();
  });

  it.each(["tool" as const, "disabled" as const, "hook" as const, "both" as const])(
    "[step 15] registers regardless of command.injection mode (%s)",
    (mode) => {
      const omre = freshOmreConfig();
      omre.command.injection = mode;
      const config = freshConfig();

      const result = registerAgents(config, omre);

      expect(result.registered.length).toBe(11);
      expect(Object.keys(config.agent ?? {}).sort()).toEqual([...AGENT_NAMES].sort());
    },
  );

  it("[step 16] handles config without an `agent` key (no crash, populates it)", () => {
    const config: Config = {} as Config;
    expect(config.agent).toBeUndefined();

    const result = registerAgents(config, freshOmreConfig());

    expect(result.registered.length).toBe(11);
    expect(config.agent).toBeDefined();
    expect(typeof config.agent).toBe("object");
    expect(Object.keys(config.agent ?? {}).sort()).toEqual([...AGENT_NAMES].sort());
  });
});

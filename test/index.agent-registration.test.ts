import { describe, it, expect, beforeEach } from "vitest";
import pluginModule from "../src/index.js";
import { AGENT_NAMES } from "../src/agents/registry.js";
import { clearLoadConfigCache } from "../src/config/load-config.js";

const OhMyReviewExperts = pluginModule.server;

function stubPluginInput(directory: string) {
  return {
    client: {
      app: {
        log: async () => undefined,
      },
    } as any,
    project: {} as any,
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: {} as any,
  };
}

beforeEach(() => {
  clearLoadConfigCache();
});

describe("[step 17] config hook registers all 11 review subagents", () => {
  it("populates config.agent with the 11 expected names", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    const config = {} as Record<string, any>;
    await hooks.config!(config);

    expect(config.agent).toBeDefined();
    const names = Object.keys(config.agent).sort();
    const expected = [...AGENT_NAMES].sort();
    expect(names).toEqual(expected);
  });

  it("registers each agent with mode='subagent' (never primary or all)", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    const config = {} as Record<string, any>;
    await hooks.config!(config);

    for (const name of AGENT_NAMES) {
      const slot = config.agent[name];
      expect(slot, `${name} missing`).toBeDefined();
      expect(slot.mode, `${name} must be subagent`).toBe("subagent");
    }
  });

  it("preserves user override at config.agent[name]", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    const userOverride = { prompt: "USER_OVERRIDE_MARKER" };
    const config = {
      agent: {
        "reviewer-security": userOverride,
      },
    } as Record<string, any>;
    await hooks.config!(config);

    expect(config.agent["reviewer-security"]).toBe(userOverride);
    expect(config.agent["reviewer-security"].prompt).toBe("USER_OVERRIDE_MARKER");
    expect(Object.keys(config.agent).length).toBe(AGENT_NAMES.length);
  });

  it("is idempotent: invoking the hook twice does not duplicate or replace entries", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    const config = {} as Record<string, any>;
    await hooks.config!(config);
    const firstSnapshot: Record<string, unknown> = {};
    for (const name of AGENT_NAMES) {
      firstSnapshot[name] = config.agent[name];
    }

    await hooks.config!(config);

    for (const name of AGENT_NAMES) {
      expect(config.agent[name]).toBe(firstSnapshot[name]);
    }
    expect(Object.keys(config.agent).length).toBe(AGENT_NAMES.length);
  });
});

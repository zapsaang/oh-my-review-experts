import { describe, it, expect, beforeEach } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pluginModule from "../src/index.js";
import { AGENT_NAMES } from "../src/agents/registry.js";
import { clearLoadConfigCache } from "../src/config/load-config.js";
import { stubPluginInput } from "./_helpers/plugin-input.js";

const DEFAULT_MODEL = "minimax-cn/MiniMax-M2.7";

const OhMyReviewExperts = pluginModule.server;

beforeEach(() => {
  clearLoadConfigCache();
});

describe("[step 17] config hook registers all 11 review subagents", () => {
  it("populates config.agent with the 11 expected names", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    const config = {} as Config;
    await hooks.config!(config);

    expect(config.agent).toBeDefined();
    const names = Object.keys(config.agent!).sort();
    const expected = [...AGENT_NAMES].sort();
    expect(names).toEqual(expected);
  });

  it("registers each agent with mode='subagent' (never primary or all)", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    const config = {} as Config;
    await hooks.config!(config);

    for (const name of AGENT_NAMES) {
      const slot = config.agent![name];
      expect(slot, `${name} missing`).toBeDefined();
      expect(slot!.mode, `${name} must be subagent`).toBe("subagent");
    }
  });

  it("preserves user override at config.agent[name]", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    const userOverride = { prompt: "USER_OVERRIDE_MARKER" };
    const config = {
      agent: {
        "omre-reviewer-security": userOverride,
      },
    } as Config;
    await hooks.config!(config);

    expect(config.agent!["omre-reviewer-security"]).toBe(userOverride);
    expect(config.agent!["omre-reviewer-security"]!.prompt).toBe("USER_OVERRIDE_MARKER");
    expect(Object.keys(config.agent!).length).toBe(AGENT_NAMES.length);
  });

  it("is idempotent: invoking the hook twice does not duplicate or replace entries", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    const config = {} as Config;
    await hooks.config!(config);
    const firstSnapshot: Record<string, unknown> = {};
    for (const name of AGENT_NAMES) {
      firstSnapshot[name] = config.agent![name];
    }

    await hooks.config!(config);

    for (const name of AGENT_NAMES) {
      expect(config.agent![name]).toBe(firstSnapshot[name]);
    }
    expect(Object.keys(config.agent!).length).toBe(AGENT_NAMES.length);
  });
});

describe("config hook agent-level model assignment", () => {
  it("assigns DEFAULT_MODEL when no agent config is set", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-agent-default-"));
    try {
      const hooks = await OhMyReviewExperts(stubPluginInput(tmpDir));
      const config = {
        model: "anthropic/claude-opus-4-7",
      } as Config;
      await hooks.config!(config);

      for (const name of AGENT_NAMES) {
        expect(config.agent![name]!.model, `${name} model`).toBe(DEFAULT_MODEL);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("assigns per-agent model from OMRE agents field", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-agent-model-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".omre", "config.json"),
        JSON.stringify({
          agents: {
            "omre-reviewer-spec": { model: "anthropic/claude-opus-4-7" },
          },
        }),
        "utf8"
      );
      const hooks = await OhMyReviewExperts(stubPluginInput(tmpDir));
      const config = {
        model: "openai/gpt-5.5",
      } as Config;
      await hooks.config!(config);

      expect(config.agent!["omre-reviewer-spec"]!.model).toBe("anthropic/claude-opus-4-7");
      for (const name of AGENT_NAMES) {
        if (name === "omre-reviewer-spec") continue;
        expect(config.agent![name]!.model, `${name} model`).toBe(DEFAULT_MODEL);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("forwards variant and temperature parameters", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-agent-variant-temp-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".omre", "config.json"),
        JSON.stringify({
          agents: {
            "omre-reviewer-spec": { model: "x", variant: "max", temperature: 0.5 },
          },
        }),
        "utf8"
      );
      const hooks = await OhMyReviewExperts(stubPluginInput(tmpDir));
      const config = {
        model: "openai/gpt-5.5",
      } as Config;
      await hooks.config!(config);

      expect(config.agent!["omre-reviewer-spec"]!.variant).toBe("max");
      expect(config.agent!["omre-reviewer-spec"]!.temperature).toBe(0.5);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("forwards top_p parameter", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-agent-top-p-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".omre", "config.json"),
        JSON.stringify({
          agents: {
            "omre-reviewer-spec": { model: "x", top_p: 0.9 },
          },
        }),
        "utf8"
      );
      const hooks = await OhMyReviewExperts(stubPluginInput(tmpDir));
      const config = {
        model: "openai/gpt-5.5",
      } as Config;
      await hooks.config!(config);

      expect(config.agent!["omre-reviewer-spec"]!.top_p).toBe(0.9);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves skip-on-conflict when opencode.json has pre-populated agent", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-agent-skip-conflict-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".omre", "config.json"),
        JSON.stringify({
          agents: {
            "omre-reviewer-spec": { model: "omre/y" },
          },
        }),
        "utf8"
      );
      const hooks = await OhMyReviewExperts(stubPluginInput(tmpDir));
      const config = {
        model: "openai/gpt-5.5",
        agent: {
          "omre-reviewer-spec": { model: "native/x" },
        },
      } as Config;
      await hooks.config!(config);

      expect(config.agent!["omre-reviewer-spec"]!.model).toBe("native/x");
      for (const name of AGENT_NAMES) {
        if (name === "omre-reviewer-spec") continue;
        expect(config.agent![name]!.model, `${name} model`).toBe(DEFAULT_MODEL);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

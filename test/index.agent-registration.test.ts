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

describe("config hook auto provider inference", () => {
  it("infers anthropic models from OpenCode config.model", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-inference-anthropic-"));
    try {
      const hooks = await OhMyReviewExperts(stubPluginInput(tmpDir));
      const config = {
        model: "anthropic/claude-opus-4-7",
      } as Config;
      await hooks.config!(config);

      expect(config.agent!["omre-reviewer-spec"]!.model).toBe("anthropic/claude-opus-4-7");
      expect(config.agent!["omre-report-writer"]!.model).toBe("anthropic/claude-haiku-4-5");
      expect(config.agent!["omre-slice-plan-validator"]!.model).toBe("anthropic/claude-haiku-4-5");
      expect(config.agent!["omre-result-validator"]!.model).toBe("anthropic/claude-haiku-4-5");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("honors OpenCode small_model for utility and coordination tiers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-inference-small-model-"));
    try {
      const hooks = await OhMyReviewExperts(stubPluginInput(tmpDir));
      const config = {
        model: "openai/gpt-5.5",
        small_model: "openai/gpt-5.4-mini",
      } as Config;
      await hooks.config!(config);

      expect(config.agent!["omre-report-writer"]!.model).toBe("openai/gpt-5.4-mini");
      expect(config.agent!["omre-reviewer-spec"]!.model).toBe("openai/gpt-5.5");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses OMRE provider when explicitly set, ignoring OpenCode config.model", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-inference-provider-override-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".omre", "config.json"),
        JSON.stringify({ provider: "google" }),
        "utf8"
      );
      const hooks = await OhMyReviewExperts(stubPluginInput(tmpDir));
      const config = {
        model: "openai/gpt-5.5",
      } as Config;
      await hooks.config!(config);

      expect(config.agent!["omre-reviewer-spec"]!.model).toBe("google/gemini-2.5-pro");
      expect(config.agent!["omre-slice-plan-validator"]!.model).toBe("google/gemini-2.5-flash-lite");
      expect(config.agent!["omre-result-validator"]!.model).toBe("google/gemini-2.5-flash-lite");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves explicit OMRE model overrides while inferring the rest", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-inference-explicit-override-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".omre", "config.json"),
        JSON.stringify({ models: { spec: "custom/x" } }),
        "utf8"
      );
      const hooks = await OhMyReviewExperts(stubPluginInput(tmpDir));
      const config = {
        model: "anthropic/claude-opus-4-7",
      } as Config;
      await hooks.config!(config);

      expect(config.agent!["omre-reviewer-spec"]!.model).toBe("custom/x");
      expect(config.agent!["omre-report-writer"]!.model).toBe("anthropic/claude-haiku-4-5");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips inference when provider is disabled in OpenCode config", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-inference-disabled-"));
    try {
      const hooks = await OhMyReviewExperts(stubPluginInput(tmpDir));
      const config = {
        provider: { openai: {} },
        enabled_providers: ["openai"],
        disabled_providers: ["openai"],
      } as Config;
      await hooks.config!(config);

      for (const name of AGENT_NAMES) {
        expect(config.agent![name]!.model).toBe(DEFAULT_MODEL);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips inference when disable_provider_inference is true in OMRE config", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-inference-kill-switch-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".omre", "config.json"),
        JSON.stringify({ disable_provider_inference: true }),
        "utf8"
      );
      const hooks = await OhMyReviewExperts(stubPluginInput(tmpDir));
      const config = {
        model: "anthropic/claude-opus-4-7",
      } as Config;
      await hooks.config!(config);

      for (const name of AGENT_NAMES) {
        expect(config.agent![name]!.model).toBe(DEFAULT_MODEL);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

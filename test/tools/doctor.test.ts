import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Config } from "@opencode-ai/plugin";
import {
  checkAgentRegistration,
  checkAgentToolWhitelist,
  checkAgentToolWhitelistForAgents,
  checkOmrePermissions,
  checkOpencodeConfig,
  checkPromptExampleSchemaIdentity,
  checkPromptExampleSchemaIdentityForExamples,
} from "../../src/tools/doctor.js";
import { AGENT_NAMES, type AgentRegistration } from "../../src/agents/registry.js";
import { SLICE_PLANNER_JSON, SlicePlannerSchema } from "../../src/agents/schemas.js";
import pluginModule from "../../src/index.js";
import { clearLoadConfigCache } from "../../src/config/load-config.js";
import { stubPluginInput } from "../_helpers/plugin-input.js";

const OhMyReviewExperts = pluginModule.server;

describe("checkOmrePermissions", () => {
  it("returns no warnings when omre_* is explicitly allowed", () => {
    const config = {
      permission: { "omre_*": "allow" },
    };
    expect(checkOmrePermissions(config)).toEqual([]);
  });

  it("returns no warnings when each omre tool is individually allowed", () => {
    const config = {
      permission: {
        omre_write_handoff: "allow",
        omre_validate_handoff: "allow",
        omre_write_report: "allow",
      },
    };
    expect(checkOmrePermissions(config)).toEqual([]);
  });

  it("warns when no omre_* permission rule is present", () => {
    const config = {
      permission: { bash: "allow" },
    };
    const warnings = checkOmrePermissions(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/omre_\*/);
  });

  it("warns when permission key is missing entirely", () => {
    const config = { plugin: ["oh-my-review-experts"] };
    const warnings = checkOmrePermissions(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/omre_\*/);
  });

  it("warns when omre_* is set to deny", () => {
    const config = {
      permission: { "omre_*": "deny" },
    };
    const warnings = checkOmrePermissions(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/deny/i);
  });

  it("warns when omre_* is set to ask (subagents may not be able to call tools without prompt)", () => {
    const config = {
      permission: { "omre_*": "ask" },
    };
    const warnings = checkOmrePermissions(config);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/ask/i);
  });

  it("returns no warnings for null config (treated as no permission constraint)", () => {
    expect(checkOmrePermissions(null)).toEqual([]);
  });

  it("returns no warnings for non-object config", () => {
    expect(checkOmrePermissions("string-config")).toEqual([]);
    expect(checkOmrePermissions(42)).toEqual([]);
    expect(checkOmrePermissions([])).toEqual([]);
  });

  it("treats permission.subagent.<name>.<tool> with allow as covered", () => {
    const config = {
      permission: {
        subagent: {
          general: { "omre_*": "allow" },
        },
      },
    };
    expect(checkOmrePermissions(config)).toEqual([]);
  });
});

describe("checkOpencodeConfig", () => {
  function withTempFile<T>(contents: string | undefined, fn: (filePath: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-doctor-"));
    const filePath = path.join(dir, "opencode.json");
    if (contents !== undefined) fs.writeFileSync(filePath, contents, "utf-8");
    try {
      return fn(filePath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("returns exists=false for a missing file (regression: !== null was always true)", () => {
    const status = checkOpencodeConfig(path.join(os.tmpdir(), "definitely-not-here.json"));
    expect(status.exists).toBe(false);
    expect(status.pluginRegistered).toBe(false);
    expect(status.permissionWarnings).toEqual([]);
  });

  it("returns exists=true and detects plugin registration", () => {
    withTempFile(
      JSON.stringify({ plugin: ["oh-my-review-experts"], permission: { "omre_*": "allow" } }),
      (filePath) => {
        const status = checkOpencodeConfig(filePath);
        expect(status.exists).toBe(true);
        expect(status.pluginRegistered).toBe(true);
        expect(status.permissionWarnings).toEqual([]);
      },
    );
  });

  it("returns exists=true with permission warnings when omre_* not allowed", () => {
    withTempFile(JSON.stringify({ plugin: ["oh-my-review-experts"] }), (filePath) => {
      const status = checkOpencodeConfig(filePath);
      expect(status.exists).toBe(true);
      expect(status.permissionWarnings.length).toBeGreaterThan(0);
    });
  });

  it("returns exists=false for empty file", () => {
    withTempFile("", (filePath) => {
      const status = checkOpencodeConfig(filePath);
      expect(status.exists).toBe(false);
    });
  });

  it("returns exists=true but pluginRegistered=false when plugin not listed", () => {
    withTempFile(JSON.stringify({ plugin: ["other-plugin"], permission: { "omre_*": "allow" } }), (filePath) => {
      const status = checkOpencodeConfig(filePath);
      expect(status.exists).toBe(true);
      expect(status.pluginRegistered).toBe(false);
    });
  });

  it("supports both 'plugin' and 'plugins' keys (back-compat)", () => {
    withTempFile(
      JSON.stringify({ plugins: ["oh-my-review-experts"], permission: { "omre_*": "allow" } }),
      (filePath) => {
        const status = checkOpencodeConfig(filePath);
        expect(status.pluginRegistered).toBe(true);
      },
    );
  });
});

describe("[step 18] checkAgentRegistration", () => {
  it("reports zero registered when config has no agent map", () => {
    const result = checkAgentRegistration({} as Config);
    expect(result.expected).toBe(11);
    expect(result.registered).toBe(0);
    expect([...result.missing].sort()).toEqual([...AGENT_NAMES].sort());
  });

  it("reports a partial registration when only one agent is present", () => {
    const config = {
      agent: {
        "reviewer-spec": { mode: "subagent" },
      },
    } as unknown as Config;
    const result = checkAgentRegistration(config);
    expect(result.expected).toBe(11);
    expect(result.registered).toBe(1);
    expect(result.missing).not.toContain("reviewer-spec");
    expect(result.missing.length).toBe(10);
  });

  it("reports 11/11 after the plugin's config hook runs on an empty config", async () => {
    clearLoadConfigCache();
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    const config = {} as Config;
    await hooks.config!(config);
    const result = checkAgentRegistration(config);
    expect(result.expected).toBe(11);
    expect(result.registered).toBe(11);
    expect(result.missing).toEqual([]);
  });
});

describe("checkPromptExampleSchemaIdentity", () => {
  const slicePlannerEntry = {
    name: "SLICE_PLANNER_JSON",
    schemaName: "SlicePlannerSchema",
    schema: SlicePlannerSchema,
  };

  it("returns no warnings when prompt examples match their schemas", () => {
    expect(checkPromptExampleSchemaIdentity()).toEqual([]);
  });

  it("warns when a prompt example drops a top-level schema field", () => {
    const tamperedExample = JSON.parse(SLICE_PLANNER_JSON) as Record<string, unknown>;
    delete tamperedExample.reason;

    const warnings = checkPromptExampleSchemaIdentityForExamples([
      {
        ...slicePlannerEntry,
        example: JSON.stringify(tamperedExample, null, 2),
      },
    ]);

    expect(warnings).toContain(
      "SLICE_PLANNER_JSON: drifted from SlicePlannerSchema; regenerate by re-importing schemas.ts",
    );
  });

  it("warns when a prompt example adds an unknown top-level field", () => {
    const tamperedExample = {
      ...(JSON.parse(SLICE_PLANNER_JSON) as Record<string, unknown>),
      unknown_top_level_key: "unexpected",
    };

    const warnings = checkPromptExampleSchemaIdentityForExamples([
      {
        ...slicePlannerEntry,
        example: JSON.stringify(tamperedExample, null, 2),
      },
    ]);

    expect(warnings).toContain(
      "SLICE_PLANNER_JSON: drifted from SlicePlannerSchema; regenerate by re-importing schemas.ts",
    );
  });
});

describe("checkAgentToolWhitelist", () => {
  function fakeAgent(name: string, toolsAllow: readonly string[]): AgentRegistration {
    return {
      name,
      modelKey: "spec",
      staticPrompt: "test prompt",
      description: "test agent",
      toolsAllow,
    };
  }

  const requiredDenies = {
    bash: "deny",
    edit: "deny",
    webfetch: "deny",
    websearch: "deny",
  };

  it("returns no warnings for the clean agent registry", () => {
    expect(checkAgentToolWhitelist()).toEqual([]);
  });

  it("warns when an agent allows tools from the forbidden baseline", () => {
    const warnings = checkAgentToolWhitelistForAgents(
      [fakeAgent("bad-reviewer", ["read", "bash", "edit"])],
      { "bad-reviewer": requiredDenies },
    );

    expect(warnings).toContain("bad-reviewer: allows forbidden tools [bash, edit]");
  });

  it("warns when a non-authorized agent is granted a writer tool", () => {
    const warnings = checkAgentToolWhitelistForAgents(
      [fakeAgent("slice-planner", ["read", "omre_write_report"])],
      { "slice-planner": requiredDenies },
    );

    expect(warnings).toContain("slice-planner: writer tool omre_write_report is not allowed for this agent");
  });

  it("warns when an effective agent registration is missing a required permission deny", () => {
    const warnings = checkAgentToolWhitelistForAgents(
      [fakeAgent("reviewer-spec", ["read"])],
      {
        "reviewer-spec": {
          bash: "allow",
          edit: "deny",
          webfetch: "deny",
          websearch: "deny",
        },
      },
    );

    expect(warnings).toContain("reviewer-spec: missing deny for bash");
  });
});

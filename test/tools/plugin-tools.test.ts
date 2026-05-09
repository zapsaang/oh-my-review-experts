import { describe, it, expect } from "vitest";
import { tools } from "../../src/tools/plugin-tools.js";

describe("plugin tools", () => {
  it("exports required tools", () => {
    expect(tools.omre_build_review_code_prompt).toBeDefined();
    expect(tools.omre_write_report).toBeDefined();
    expect(tools.omre_dry_run).toBeDefined();
    expect(tools.omre_config).toBeDefined();
  });

  it("omre_dry_run returns markdown", async () => {
    const result = await tools.omre_dry_run({ args: "", cwd: process.cwd() });
    expect(result.markdown).toContain("Review Code Dry Run");
  });

  it("omre_config loads default config", async () => {
    const result = await tools.omre_config({ cwd: process.cwd() });
    expect(result.enabled).toBe(true);
    expect(result.command.name).toBe("review-code");
  });
});

import pluginModule from "../../src/index.js";
const OhMyReviewExperts = pluginModule.server;

function stubPluginInput(directory: string) {
  return {
    client: {} as any,
    project: {} as any,
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: {} as any,
  };
}

describe("plugin factory integration", () => {
  it("returns Hooks object with command.execute.before", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    expect(typeof hooks["command.execute.before"]).toBe("function");
  });

  it("does not include legacy name property", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    expect((hooks as any).name).toBeUndefined();
  });
});

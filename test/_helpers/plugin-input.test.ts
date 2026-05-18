import { describe, it, expect } from "vitest";
import { stubPluginInput, expectHooks } from "./plugin-input.js";

describe("stubPluginInput", () => {
  it("returns a PluginInput with the given directory", () => {
    const input = stubPluginInput("/tmp");
    expect(input.directory).toBe("/tmp");
    expect(input.worktree).toBe("/tmp");
    expect(input.serverUrl).toEqual(new URL("http://localhost"));
    expect(input.experimental_workspace.register).toBeTypeOf("function");
  });
});

describe("expectHooks", () => {
  it("returns the hooks object", () => {
    const hooks: import("@opencode-ai/plugin").Hooks = {};
    const result = expectHooks(hooks);
    expect(result).toBe(hooks);
  });
});

import { describe, it, expect } from "vitest";
import pluginModule from "../src/index.js";

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

describe("tool hook registration", () => {
  it("registers all expected tools", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    expect(hooks.tool).toBeDefined();
    expect(hooks.tool?.omre_write_report).toBeDefined();
    expect(hooks.tool?.omre_validate_handoff).toBeDefined();
    expect(hooks.tool?.omre_build_review_code_prompt).toBeDefined();
    expect(hooks.tool?.omre_dry_run).toBeDefined();
    expect(hooks.tool?.omre_config).toBeDefined();
  });

  it("omre_write_report tool has correct shape", async () => {
    const hooks = await OhMyReviewExperts(stubPluginInput(process.cwd()));
    const writeReportTool = hooks.tool?.omre_write_report;
    expect(writeReportTool).toBeDefined();
    expect(writeReportTool?.description).toContain("report");
    expect(writeReportTool?.args).toBeDefined();
    expect(writeReportTool?.execute).toBeTypeOf("function");
  });
});

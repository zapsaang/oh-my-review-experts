import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildReviewCodePrompt } from "../../src/workflow/run-review-code.js";
import { clearLoadConfigCache } from "../../src/config/load-config.js";
import { withCleanGitRepo } from "../_helpers/fixture-repo.js";

function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/\d{8}-\d{6}-\d{3}/g, "RUN_ID")
    .replace(/^[a-f0-9]{7,40} init$/gm, "COMMIT_HASH init")
    .replace(/index 0000000\.[.][a-f0-9]{7,40}/g, "index 0000000..COMMIT_HASH");
}

function buildPromptWithGuidanceOnly(args: string): string {
  return withCleanGitRepo((cwd) => {
    fs.mkdirSync(path.join(cwd, ".omre"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".omre", "config.json"),
      JSON.stringify({ command: { scopeResolution: "guidance-only" } }),
      "utf8"
    );
    clearLoadConfigCache();
    const bundle = buildReviewCodePrompt({ args, cwd }, true);
    return normalizePrompt(bundle.prompt);
  });
}

describe("T17: scopeResolution=guidance-only snapshot tests", () => {
  it('args="" produces stable prompt with default scope', () => {
    const prompt = buildPromptWithGuidanceOnly("");
    expect(prompt).toMatchSnapshot();
  });

  it('args="focus on security" produces stable prompt with guidance text', () => {
    const prompt = buildPromptWithGuidanceOnly("focus on security");
    expect(prompt).toMatchSnapshot();
  });

  it('args="branch:main" is treated as guidance (default scope)', () => {
    const prompt = buildPromptWithGuidanceOnly("branch:main");
    expect(prompt).toMatchSnapshot();
  });

  it('args="src/auth" is treated as guidance (default scope)', () => {
    const prompt = buildPromptWithGuidanceOnly("src/auth");
    expect(prompt).toMatchSnapshot();
  });

  it('args="HEAD~3" is treated as guidance (default scope)', () => {
    const prompt = buildPromptWithGuidanceOnly("HEAD~3");
    expect(prompt).toMatchSnapshot();
  });
});

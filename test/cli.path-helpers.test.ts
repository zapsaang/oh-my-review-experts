import { describe, expect, it } from "vitest";
import {
  getOpencodeConfigPath,
  getPluginConfigPath,
} from "../src/cli.js";

describe("getOpencodeConfigPath", () => {
  it("returns global config path when global=true", () => {
    const result = getOpencodeConfigPath(true, "/ignored", "/fake/home");
    expect(result).toBe("/fake/home/.config/opencode/opencode.json");
  });

  it("returns project config path when global=false", () => {
    const result = getOpencodeConfigPath(false, "/fake/cwd", "/ignored");
    expect(result).toBe("/fake/cwd/opencode.json");
  });
});

describe("getPluginConfigPath", () => {
  it("returns global plugin config path when global=true", () => {
    const result = getPluginConfigPath(true, "/ignored", "/fake/home");
    expect(result).toBe("/fake/home/.config/opencode/oh-my-review-experts.jsonc");
  });

  it("returns project plugin config path when global=false", () => {
    const result = getPluginConfigPath(false, "/fake/cwd", "/ignored");
    expect(result).toBe("/fake/cwd/.opencode/oh-my-review-experts.jsonc");
  });
});

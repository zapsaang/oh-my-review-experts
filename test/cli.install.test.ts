import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { runInstall } from "../src/cli.js";
import { OmreConfigSchema } from "../src/config/schema.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omre-cfg-"));
  tempDirs.push(dir);
  return dir;
}

describe("runInstall", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
    vi.restoreAllMocks();
  });

  it("runInstall returns InstallResult with all 4 fields", () => {
    const tmpDir = makeTempDir();
    const tmpHome = makeTempDir();

    const result = runInstall({ project: true, cwd: tmpDir, homeDir: tmpHome });

    expect(Object.keys(result).sort()).toEqual([
      "configCreated",
      "opencodeConfigPath",
      "pluginChanged",
      "pluginConfigPath",
    ]);
    expect(result.pluginChanged).toBe(true);
    expect(result.configCreated).toBe(true);
    expect(result.opencodeConfigPath).toBe(path.join(tmpDir, "opencode.json"));
    expect(result.pluginConfigPath).toBe(path.join(tmpDir, ".opencode", "oh-my-review-experts.jsonc"));
  });

  it("runInstall is idempotent for project install", () => {
    const tmpDir = makeTempDir();
    const tmpHome = makeTempDir();

    const first = runInstall({ project: true, cwd: tmpDir, homeDir: tmpHome });
    const initialConfig = parseJsonc(readFileSync(first.opencodeConfigPath, "utf8"));
    const initialPlugins = (initialConfig as { plugin?: string[] }).plugin ?? [];

    const second = runInstall({ project: true, cwd: tmpDir, homeDir: tmpHome });
    const updatedConfig = parseJsonc(readFileSync(second.opencodeConfigPath, "utf8"));
    const updatedPlugins = (updatedConfig as { plugin?: string[] }).plugin ?? [];

    expect(second.pluginChanged).toBe(false);
    expect(second.configCreated).toBe(false);
    expect(updatedPlugins).toContain("oh-my-review-experts");
    expect(updatedPlugins).toHaveLength(initialPlugins.length);
  });

  it("runInstall global writes to homeDir-based paths", () => {
    const tmpDir = makeTempDir();
    const tmpHome = makeTempDir();

    const result = runInstall({ global: true, cwd: tmpDir, homeDir: tmpHome });
    const opencodeConfigPath = path.join(tmpHome, ".config", "opencode", "opencode.json");
    const pluginConfigPath = path.join(tmpHome, ".config", "opencode", "oh-my-review-experts.jsonc");
    const opencodeConfig = parseJsonc(readFileSync(opencodeConfigPath, "utf8"));

    expect(result.opencodeConfigPath).toBe(opencodeConfigPath);
    expect(existsSync(opencodeConfigPath)).toBe(true);
    expect((opencodeConfig as { plugin?: string[] }).plugin).toContain("oh-my-review-experts");
    expect(result.pluginConfigPath).toBe(pluginConfigPath);
    expect(existsSync(pluginConfigPath)).toBe(true);
  });

  it("runInstall throws clear error for invalid JSONC in opencode.json", () => {
    const tmpDir = makeTempDir();
    const tmpHome = makeTempDir();
    writeFileSync(path.join(tmpDir, "opencode.json"), "this is not json [ broken", "utf8");

    expect(() => runInstall({ project: true, cwd: tmpDir, homeDir: tmpHome })).toThrow(/invalid|jsonc|expected/i);
  });

  it("defaultConfigJsonc output passes OmreConfigSchema.parse", () => {
    const tmpDir = makeTempDir();
    const tmpHome = makeTempDir();

    const result = runInstall({ project: true, cwd: tmpDir, homeDir: tmpHome });
    const parsed = parseJsonc(readFileSync(result.pluginConfigPath, "utf8"));

    expect(() => OmreConfigSchema.parse(parsed)).not.toThrow();
  });
});

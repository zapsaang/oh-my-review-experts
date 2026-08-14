import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deepMerge, findConfigFiles, loadConfig, loadConfigUnsafe, clearLoadConfigCache, defaultConfigJsonc, ConfigLoader } from "../../src/config/load-config.js";
import { OmreConfigSchema, DEFAULT_CONFIG } from "../../src/config/schema.js";
import fs from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";

describe("deepMerge", () => {
  it("returns base when override is not an object", () => {
    const base = { a: 1 };
    expect(deepMerge(base, null)).toEqual(base);
    expect(deepMerge(base, "string")).toEqual(base);
    expect(deepMerge(base, [1, 2])).toEqual(base);
  });

  it("returns base when override is undefined", () => {
    const base = { a: 1 };
    expect(deepMerge(base, undefined)).toEqual(base);
  });

  it("shallow merges top-level properties", () => {
    const base = { a: 1, b: 2 };
    const override = { b: 3, c: 4 };
    expect(deepMerge(base, override)).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("deeply merges nested objects", () => {
    const base = { a: { x: 1, y: 2 }, b: 3 };
    const override = { a: { y: 20, z: 30 } };
    expect(deepMerge(base, override)).toEqual({ a: { x: 1, y: 20, z: 30 }, b: 3 });
  });

  it("replaces arrays instead of merging", () => {
    const base = { arr: [1, 2] };
    const override = { arr: [3, 4] };
    expect(deepMerge(base, override)).toEqual({ arr: [3, 4] });
  });

  it("does not mutate base object", () => {
    const base = { a: { x: 1 } };
    const override = { a: { y: 2 } };
    const result = deepMerge(base, override);
    expect(base).toEqual({ a: { x: 1 } });
    expect(result).toEqual({ a: { x: 1, y: 2 } });
  });

  it("does not share nested references when override does not touch nested keys", () => {
    const base = { a: { x: 1 }, b: 2 };
    const override = { b: 3 };
    const result = deepMerge(base, override);
    expect(result.a).not.toBe(base.a);
    expect(result).toEqual({ a: { x: 1 }, b: 3 });
  });

});

describe("findConfigFiles", () => {
  it("returns empty array for non-existent cwd", () => {
    const spy = vi.spyOn(os, "homedir").mockReturnValue("/nonexistent/home");
    try {
      const files = findConfigFiles("/nonexistent/path/12345");
      expect(files).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("finds project-level configs when they exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".omre-test-"));
    const configPath = path.join(tmpDir, ".omre", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{}", "utf8");

    try {
      const files = findConfigFiles(tmpDir);
      expect(files).toContain(configPath);
    } finally {
      try {
        fs.unlinkSync(configPath);
      } catch { /* file may not exist */ }
      try {
        fs.rmdirSync(path.dirname(configPath));
      } catch { /* directory may not exist */ }
      try {
        fs.rmdirSync(tmpDir);
      } catch { /* directory may not exist */ }
    }
  });

  it("findConfigFiles uses passed homeDir over os.homedir() default", () => {
    const fakeHomeDir = fs.mkdtempSync(path.join(process.cwd(), "omre-cfg-"));
    const globalDir = path.join(fakeHomeDir, ".config", "opencode");
    fs.mkdirSync(globalDir, { recursive: true });
    const globalConfigPath = path.join(globalDir, "oh-my-review-experts.jsonc");
    fs.writeFileSync(globalConfigPath, "{}", "utf8");

    const spy = vi.spyOn(os, "homedir").mockReturnValue("/never/used");

    try {
      const files = findConfigFiles(process.cwd(), fakeHomeDir);
      expect(files).toContain(globalConfigPath);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      fs.rmSync(fakeHomeDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  // slop-fix: fails until B1 fix lands
  it("surfaces non-ENOENT access errors instead of treating the config as absent", () => {
    const missingError = Object.assign(new Error("config not found"), { code: "ENOENT" });
    const accessError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const targetSuffix = path.join(".omre", "config.json");
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation((filePath) => {
      if (String(filePath).endsWith(targetSuffix)) {
        throw accessError;
      }
      throw missingError;
    });

    try {
      expect(() => findConfigFiles("/repo", "/home")).toThrow("permission denied");
    } finally {
      accessSpy.mockRestore();
    }
  });
});

describe("loadConfig cache", () => {
  beforeEach(() => {
    clearLoadConfigCache();
  });

  it("returns same config from cache on repeated calls", () => {
    const config1 = loadConfig("nonexistent-path-12345-for-test");
    const config2 = loadConfig("nonexistent-path-12345-for-test");
    expect(config1).toEqual(config2);
    expect(config1).not.toBe(config2);
  });

  it("invalidates cache when config file changes", () => {
    const relativeTmpDir = `.omre-cache-test-${Date.now()}`;
    const tmpDir = path.join(process.cwd(), relativeTmpDir);
    const configPath = path.join(tmpDir, ".omre", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ enabled: true }), "utf8");

    try {
      const config1 = loadConfig(relativeTmpDir);
      expect(config1.enabled).toBe(true);

      fs.writeFileSync(configPath, JSON.stringify({ enabled: false }), "utf8");
      fs.utimesSync(configPath, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
      const config2 = loadConfig(relativeTmpDir);
      expect(config2.enabled).toBe(false);
    } finally {
      try {
        fs.unlinkSync(configPath);
      } catch { /* file may not exist */ }
      try {
        fs.rmdirSync(path.dirname(configPath));
      } catch { /* directory may not exist */ }
      try {
        fs.rmdirSync(tmpDir);
      } catch { /* directory may not exist */ }
    }
  });

  it("loadConfig forwards homeDir to findConfigFiles", () => {
    const absoluteTmpDir = fs.mkdtempSync(path.join(tmpdir(), "omre-cfg-"));
    const fakeHomeDir = fs.mkdtempSync(path.join(tmpdir(), "omre-cfg-"));
    const emptyHomeDir = fs.mkdtempSync(path.join(tmpdir(), "omre-cfg-"));
    const globalDir = path.join(fakeHomeDir, ".config", "opencode");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, "oh-my-review-experts.jsonc"), JSON.stringify({ enabled: false }), "utf8");

    try {
      const config = loadConfigUnsafe(absoluteTmpDir, fakeHomeDir);
      expect(config.enabled).toBe(false);

      const defaultConfig = loadConfigUnsafe(absoluteTmpDir, emptyHomeDir);
      expect(defaultConfig.enabled).toBe(true);
    } finally {
      fs.rmSync(absoluteTmpDir, { recursive: true, force: true, maxRetries: 3 });
      fs.rmSync(fakeHomeDir, { recursive: true, force: true, maxRetries: 3 });
      fs.rmSync(emptyHomeDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("loadConfig cache differentiates by homeDir", () => {
    const absoluteTmpDir = fs.mkdtempSync(path.join(tmpdir(), "omre-cfg-"));
    const homeA = fs.mkdtempSync(path.join(tmpdir(), "omre-cfg-"));
    const homeB = fs.mkdtempSync(path.join(tmpdir(), "omre-cfg-"));
    const globalDirA = path.join(homeA, ".config", "opencode");
    const globalDirB = path.join(homeB, ".config", "opencode");
    fs.mkdirSync(globalDirA, { recursive: true });
    fs.mkdirSync(globalDirB, { recursive: true });
    fs.writeFileSync(path.join(globalDirA, "oh-my-review-experts.jsonc"), JSON.stringify({ enabled: false }), "utf8");
    fs.writeFileSync(path.join(globalDirB, "oh-my-review-experts.jsonc"), JSON.stringify({ command: { name: "review-alt" } }), "utf8");

    try {
      const configA = loadConfigUnsafe(absoluteTmpDir, homeA);
      const configB = loadConfigUnsafe(absoluteTmpDir, homeB);

      expect(configA.enabled).toBe(false);
      expect(configB.enabled).toBe(true);
      expect(configB.command.name).toBe("review-alt");
      expect(configA).not.toEqual(configB);
    } finally {
      fs.rmSync(absoluteTmpDir, { recursive: true, force: true, maxRetries: 3 });
      fs.rmSync(homeA, { recursive: true, force: true, maxRetries: 3 });
      fs.rmSync(homeB, { recursive: true, force: true, maxRetries: 3 });
    }
  });

});

describe("assertSafeCwd security", () => {
  it("rejects paths containing ..", () => {
    expect(() => loadConfig("../../etc")).toThrow("Path traversal is not allowed");
    expect(() => loadConfig("foo/../bar")).toThrow("Path traversal is not allowed");
  });

  it("rejects absolute paths", () => {
    expect(() => loadConfig("/etc")).toThrow("Absolute paths are not allowed");
    expect(() => loadConfig("/tmp")).toThrow("Absolute paths are not allowed");
    expect(() => loadConfig("/")).toThrow("Absolute paths are not allowed");
  });

  it("allows process.cwd() itself", () => {
    expect(() => loadConfig(process.cwd())).not.toThrow();
  });

  it("allows relative subdirectories", () => {
    expect(() => loadConfig("src")).not.toThrow();
    expect(() => loadConfig("test/config")).not.toThrow();
  });

  it("rejects path traversal via normalization", () => {
    // /a/../../b contains .. which triggers the first guard
    expect(() => loadConfig("/a/../../b")).toThrow("Path traversal is not allowed");
    // A path that normalizes to an escape but does not contain raw ..
    expect(() => loadConfig("foo/bar/baz/../../../etc")).toThrow("Path traversal is not allowed");
  });
});

describe("defaultConfigJsonc", () => {
  it("generates valid JSON", () => {
    const jsonc = defaultConfigJsonc();
    expect(() => JSON.parse(jsonc)).not.toThrow();
  });

  it("generates config that passes OmreConfigSchema validation", () => {
    const jsonc = defaultConfigJsonc();
    const parsed = JSON.parse(jsonc);
    expect(() => OmreConfigSchema.parse(parsed)).not.toThrow();
  });

  it("includes $schema field", () => {
    const jsonc = defaultConfigJsonc();
    expect(jsonc).toContain('"$schema"');
  });

  it("matches DEFAULT_CONFIG values", () => {
    const jsonc = defaultConfigJsonc();
    const parsed = JSON.parse(jsonc);
    const { $schema: _, ...configForComparison } = parsed;
    expect(configForComparison).toEqual(DEFAULT_CONFIG);
  });

  it("is idempotent", () => {
    const jsonc1 = defaultConfigJsonc();
    const jsonc2 = defaultConfigJsonc();
    expect(jsonc1).toBe(jsonc2);
  });

  it("includes memory with enabled: true", () => {
    const jsonc = defaultConfigJsonc();
    const parsed = JSON.parse(jsonc);
    expect(parsed).toHaveProperty("memory");
    expect(parsed.memory).toHaveProperty("enabled", true);
  });
});

describe("agents field deep-merge", () => {
  beforeEach(() => {
    clearLoadConfigCache();
  });

  it("merges agents across config files", () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".omre-test-"));
    const file1 = path.join(tmpDir, ".opencode", "oh-my-review-experts.jsonc");
    const file2 = path.join(tmpDir, ".omre", "config.json");

    fs.mkdirSync(path.dirname(file1), { recursive: true });
    fs.writeFileSync(file1, JSON.stringify({ agents: { "omre-reviewer-spec": { model: "a/b" } } }), "utf8");

    fs.mkdirSync(path.dirname(file2), { recursive: true });
    fs.writeFileSync(file2, JSON.stringify({ agents: { "omre-reviewer-quality": { model: "c/d" } } }), "utf8");

    try {
      const config = loadConfigUnsafe(tmpDir);
      expect(config.agents).toBeDefined();
      expect(config.agents["omre-reviewer-spec"]).toEqual({ model: "a/b" });
      expect(config.agents["omre-reviewer-quality"]).toEqual({ model: "c/d" });
    } finally {
      try { fs.unlinkSync(file1); } catch { /* ignore */ }
      try { fs.rmdirSync(path.dirname(file1)); } catch { /* ignore */ }
      try { fs.unlinkSync(file2); } catch { /* ignore */ }
      try { fs.rmdirSync(path.dirname(file2)); } catch { /* ignore */ }
      try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
    }
  });

  it("later config file overrides agent model but preserves other parameters", () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".omre-test-"));
    const file1 = path.join(tmpDir, ".opencode", "oh-my-review-experts.jsonc");
    const file2 = path.join(tmpDir, ".omre", "config.json");

    fs.mkdirSync(path.dirname(file1), { recursive: true });
    fs.writeFileSync(file1, JSON.stringify({ agents: { "omre-reviewer-spec": { model: "a/b", variant: "max" } } }), "utf8");

    fs.mkdirSync(path.dirname(file2), { recursive: true });
    fs.writeFileSync(file2, JSON.stringify({ agents: { "omre-reviewer-spec": { model: "c/d" } } }), "utf8");

    try {
      const config = loadConfigUnsafe(tmpDir);
      expect(config.agents).toBeDefined();
      expect(config.agents["omre-reviewer-spec"]).toEqual({ model: "c/d", variant: "max" });
    } finally {
      try { fs.unlinkSync(file1); } catch { /* ignore */ }
      try { fs.rmdirSync(path.dirname(file1)); } catch { /* ignore */ }
      try { fs.unlinkSync(file2); } catch { /* ignore */ }
      try { fs.rmdirSync(path.dirname(file2)); } catch { /* ignore */ }
      try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
    }
  });

  it("defaultConfigJsonc() emits agents: {}", () => {
    const jsonc = defaultConfigJsonc();
    const parsed = JSON.parse(jsonc);
    expect(parsed).toHaveProperty("agents", {});
    expect(parsed).not.toHaveProperty("models");
    expect(parsed).not.toHaveProperty("provider");
    expect(parsed).not.toHaveProperty("disable_provider_inference");
  });
});

describe("loadConfig hierarchy", () => {
  let cwd: string;
  let homeDir: string;

  beforeEach(() => {
    clearLoadConfigCache();
    cwd = fs.mkdtempSync(path.join(tmpdir(), "omre-cfg-"));
    homeDir = fs.mkdtempSync(path.join(tmpdir(), "omre-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 3 });
  });

  function writeConfig(file: string, config: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config), "utf8");
  }

  function writeRawConfig(file: string, contents: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf8");
  }

  it("project config wins over global config for same agent", () => {
    writeConfig(path.join(homeDir, ".config", "opencode", "oh-my-review-experts.jsonc"), {
      agents: { "omre-reviewer-spec": { model: "global-model" } },
    });
    writeConfig(path.join(cwd, ".opencode", "oh-my-review-experts.jsonc"), {
      agents: { "omre-reviewer-spec": { model: "project-model" } },
    });

    const config = loadConfigUnsafe(cwd, homeDir);

    expect(config.agents["omre-reviewer-spec"]?.model).toBe("project-model");
  });

  it("global and project agents deep-merge across files", () => {
    writeConfig(path.join(homeDir, ".config", "opencode", "oh-my-review-experts.jsonc"), {
      agents: { "omre-reviewer-spec": { model: "global-model" } },
    });
    writeConfig(path.join(cwd, ".opencode", "oh-my-review-experts.jsonc"), {
      agents: { "omre-reviewer-quality": { model: "project-model" } },
    });

    const config = loadConfigUnsafe(cwd, homeDir);

    expect(config.agents["omre-reviewer-spec"]).toEqual({ model: "global-model" });
    expect(config.agents["omre-reviewer-quality"]).toEqual({ model: "project-model" });
  });

  it("all 6 documented file positions are loaded in correct order", () => {
    const files = [
      [path.join(homeDir, ".config", "opencode", "oh-my-review-experts.jsonc"), "global-jsonc"],
      [path.join(homeDir, ".config", "opencode", "oh-my-review-experts.json"), "global-json"],
      [path.join(cwd, ".opencode", "oh-my-review-experts.jsonc"), "project-jsonc"],
      [path.join(cwd, ".opencode", "oh-my-review-experts.json"), "project-json"],
      [path.join(cwd, ".omre", "config.jsonc"), "omre-jsonc"],
      [path.join(cwd, ".omre", "config.json"), "omre-json"],
    ] as const;

    for (const [file, name] of files) {
      writeConfig(file, { command: { name } });
    }

    const config = loadConfigUnsafe(cwd, homeDir);

    expect(config.command.name).toBe("omre-json");
  });

  it("malformed global JSONC is ignored when parser recovers", () => {
    writeRawConfig(path.join(homeDir, ".config", "opencode", "oh-my-review-experts.jsonc"), "{");
    writeConfig(path.join(cwd, ".opencode", "oh-my-review-experts.jsonc"), {
      command: { name: "project-valid" },
    });

    const config = loadConfigUnsafe(cwd, homeDir);

    expect(config.command.name).toBe("project-valid");
  });
});

describe("ConfigLoader", () => {
  it("creates isolated cache instances", () => {
    const loaderA = new ConfigLoader();
    const loaderB = new ConfigLoader();

    const configA = loaderA.load("nonexistent-path-12345-for-test");
    expect(loaderA.cacheSize).toBe(1);
    expect(loaderB.cacheSize).toBe(0);

    const configB = loaderB.load("nonexistent-path-12345-for-test");
    expect(configB).toEqual(configA);
    expect(loaderB.cacheSize).toBe(1);
  });

  it("respects maxCacheSize option", () => {
    const loader = new ConfigLoader({ maxCacheSize: 2 });
    loader.load("nonexistent-path-1");
    loader.load("nonexistent-path-2");
    loader.load("nonexistent-path-3");
    expect(loader.cacheSize).toBe(2);
  });

  it("clearCache removes all entries", () => {
    const loader = new ConfigLoader();
    loader.load("nonexistent-path-12345-for-test");
    expect(loader.cacheSize).toBe(1);
    loader.clearCache();
    expect(loader.cacheSize).toBe(0);
  });

  it("does not share cache with defaultLoader", () => {
    clearLoadConfigCache();
    const loader = new ConfigLoader();

    loadConfig("nonexistent-path-12345-for-test");
    expect(loader.cacheSize).toBe(0);

    loader.load("nonexistent-path-12345-for-test");
    expect(loader.cacheSize).toBe(1);
  });
});

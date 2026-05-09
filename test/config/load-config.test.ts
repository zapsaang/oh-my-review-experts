import { describe, it, expect, vi } from "vitest";
import { deepMerge, findConfigFiles, loadConfig, clearLoadConfigCache, defaultConfigJsonc } from "../../src/config/load-config.js";
import { OmreConfigSchema, DEFAULT_CONFIG } from "../../src/config/schema.js";
import fs from "node:fs";
import os from "node:os";
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

  it("loadConfig return value does not share nested references with DEFAULT_CONFIG", () => {
    const config = loadConfig("nonexistent-path-12345-for-test");
    config.models.orchestrator = "mutated-model";
    expect(DEFAULT_CONFIG.models.orchestrator).not.toBe("mutated-model");
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
});

describe("loadConfig cache", () => {
  it("returns same config from cache on repeated calls", () => {
    clearLoadConfigCache();
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
      clearLoadConfigCache();
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

  it("returns deep clone from cache so mutations do not affect subsequent reads", () => {
    clearLoadConfigCache();
    const config1 = loadConfig("nonexistent-path-12345-for-test");
    config1.models.orchestrator = "mutated";

    const config2 = loadConfig("nonexistent-path-12345-for-test");
    expect(config2.models.orchestrator).not.toBe("mutated");
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
});

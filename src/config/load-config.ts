import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { DEFAULT_CONFIG, OmreConfig, OmreConfigSchema } from "./schema.js";

const CONFIG_NAMES = [
  ".opencode/oh-my-review-experts.jsonc",
  ".opencode/oh-my-review-experts.json",
  ".omre/config.jsonc",
  ".omre/config.json",
];

function assertSafeCwd(cwd: string): void {
  if (/\.\./.test(cwd)) {
    throw new Error(`Invalid cwd: "${cwd}". Path traversal is not allowed.`);
  }

  const currentCwd = path.resolve(process.cwd());
  const resolved = path.resolve(cwd);

  if (resolved === currentCwd) {
    return;
  }

  if (path.isAbsolute(cwd) && !resolved.startsWith(currentCwd + path.sep)) {
    throw new Error(
      `Invalid cwd: "${cwd}". Absolute paths are not allowed. ` +
      `Only relative paths within the current working directory are permitted.`,
    );
  }
}

export function deepMerge<T extends Record<string, unknown>>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) return structuredClone(base);
  const out: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      key in base && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])
    ) {
      out[key] = deepMerge(base[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

export function readJsonc(file: string): unknown | undefined {
  try {
    const text = fs.readFileSync(file, "utf8");
    return parseJsonc(text);
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Failed to read JSONC from ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function findConfigFiles(cwd = process.cwd(), homeDir = os.homedir()): string[] {
  const files: string[] = [];
  const globalDir = path.join(homeDir, ".config", "opencode");
  for (const name of ["oh-my-review-experts.jsonc", "oh-my-review-experts.json"]) {
    const p = path.join(globalDir, name);
    try {
      fs.accessSync(p, fs.constants.R_OK);
      files.push(p);
    } catch { }
  }
  for (const name of CONFIG_NAMES) {
    const p = path.join(cwd, name);
    try {
      fs.accessSync(p, fs.constants.R_OK);
      files.push(p);
    } catch { }
  }
  return files;
}

interface CacheEntry {
  config: OmreConfig;
  mtimes: Map<string, number>;
}

function getCacheKey(cwd: string, homeDir: string, files: string[]): string {
  return `${cwd}:${homeDir}:${files.join(",")}`;
}

function isCacheValid(entry: CacheEntry, files: string[]): boolean {
  if (entry.mtimes.size !== files.length) return false;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (entry.mtimes.get(file) !== stat.mtimeMs) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export interface ConfigLoaderOptions {
  maxCacheSize?: number;
}

export class ConfigLoader {
  private cache = new Map<string, CacheEntry>();
  private maxCacheSize: number;

  constructor(options: ConfigLoaderOptions = {}) {
    this.maxCacheSize = options.maxCacheSize ?? 50;
  }

  load(cwd: string, homeDir: string = os.homedir()): OmreConfig {
    const files = findConfigFiles(cwd, homeDir);
    const cacheKey = getCacheKey(cwd, homeDir, files);
    const cached = this.cache.get(cacheKey);

    if (cached && isCacheValid(cached, files)) {
      return structuredClone(cached.config);
    }

    let merged: Record<string, unknown> = structuredClone(DEFAULT_CONFIG);
    const mtimes = new Map<string, number>();

    for (const file of files) {
      const raw = readJsonc(file);
      if (raw !== undefined) {
        merged = deepMerge(merged, raw);
      }
      try {
        mtimes.set(file, fs.statSync(file).mtimeMs);
      } catch (err) {
        throw new Error(`Failed to stat config file ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const config = OmreConfigSchema.parse(merged);

    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }

    this.cache.set(cacheKey, { config: structuredClone(config), mtimes });
    return config;
  }

  clearCache(): void {
    this.cache.clear();
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}

// Default instance for backward compatibility
const defaultLoader = new ConfigLoader();

/**
 * Load OMRE configuration with path traversal guards.
 * This is the safe public API — always validates cwd before reading files.
 */
export function loadConfig(cwd = process.cwd(), homeDir = os.homedir()): OmreConfig {
  assertSafeCwd(cwd);
  return defaultLoader.load(cwd, homeDir);
}

/**
 * Load OMRE configuration without path traversal guards.
 * For internal use only (e.g. plugin boot where OpenCode has already validated the directory).
 * @internal
 */
export function loadConfigUnsafe(cwd: string, homeDir?: string): OmreConfig {
  return defaultLoader.load(cwd, homeDir ?? os.homedir());
}

/**
 * Clear the default ConfigLoader cache.
 * @deprecated Use `new ConfigLoader()` for test isolation instead.
 */
export function clearLoadConfigCache(): void {
  defaultLoader.clearCache();
}

export function defaultConfigJsonc(): string {
  const defaults = OmreConfigSchema.parse({});
  const config = {
    $schema: "https://raw.githubusercontent.com/zapsaang/oh-my-review-experts/main/schemas/oh-my-review-experts.schema.json",
    enabled: defaults.enabled,
    command: defaults.command,
    agents: defaults.agents,
    slicing: defaults.slicing,
    partialRerun: defaults.partialRerun,
    costGuardrail: defaults.costGuardrail,
    arbitration: defaults.arbitration,
    report: defaults.report,
    handoff: defaults.handoff,
    reviewers: defaults.reviewers,
    memory: defaults.memory,
  };
  return JSON.stringify(config, null, 2) + "\n";
}

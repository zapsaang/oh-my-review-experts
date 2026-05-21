import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { DEFAULT_CONFIG, OmreConfig, OmreConfigSchema } from "./schema.js";
import type { ModelKey } from "../agents/registry.js";
import { ZodError } from "zod";

const CONFIG_NAMES = [
  ".opencode/oh-my-review-experts.jsonc",
  ".opencode/oh-my-review-experts.json",
  ".omre/config.jsonc",
  ".omre/config.json",
];

function assertSafeCwd(cwd: string): void {
  // SECURITY: Check the original path for ".." before normalization.
  // path.normalize resolves ".." segments, e.g. "/a/../../b" normalizes to "/b",
  // which would bypass a post-normalization regex check.
  if (/\.\./.test(cwd)) {
    throw new Error(`Invalid cwd: "${cwd}". Path traversal is not allowed.`);
  }

  const currentCwd = path.resolve(process.cwd());
  const resolved = path.resolve(cwd);

  // process.cwd() itself is always allowed (default behavior).
  if (resolved === currentCwd) {
    return;
  }

  // SECURITY: Reject absolute paths that are not process.cwd().
  // Allowing arbitrary absolute paths (e.g. "/etc") enables arbitrary file writes
  // via downstream tools like omre_write_report.
  if (path.isAbsolute(cwd)) {
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

export function findConfigFiles(cwd = process.cwd()): string[] {
  const files: string[] = [];
  const globalDir = path.join(os.homedir(), ".config", "opencode");
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
  explicitModelOverrides: Set<ModelKey>;
  mtimes: Map<string, number>;
}

const MAX_CACHE_SIZE = 50;
const configCache = new Map<string, CacheEntry>();

function getCacheKey(cwd: string, files: string[]): string {
  return `${cwd}:${files.join(",")}`;
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isModelKey(key: string): key is ModelKey {
  return key in DEFAULT_CONFIG.models;
}

function collectExplicitModelOverrides(raw: unknown, explicitModelOverrides: Set<ModelKey>): void {
  if (!isPlainObject(raw) || !isPlainObject(raw.models)) return;
  for (const key of Object.keys(raw.models)) {
    if (isModelKey(key)) {
      explicitModelOverrides.add(key);
    }
  }
}

export function clearLoadConfigCache(): void {
  configCache.clear();
}

export function loadConfig(cwd = process.cwd(), trusted = false): OmreConfig {
  return loadConfigWithOverrides(cwd, trusted).config;
}

export function loadConfigWithOverrides(
  cwd = process.cwd(),
  trusted = false,
): { config: OmreConfig; explicitModelOverrides: Set<ModelKey> } {
  if (!trusted) assertSafeCwd(cwd);
  const files = findConfigFiles(cwd);
  const cacheKey = getCacheKey(cwd, files);
  const cached = configCache.get(cacheKey);

  if (cached && isCacheValid(cached, files)) {
    return {
      config: structuredClone(cached.config),
      explicitModelOverrides: new Set(cached.explicitModelOverrides),
    };
  }

  let merged: Record<string, unknown> = structuredClone(DEFAULT_CONFIG);
  const explicitModelOverrides = new Set<ModelKey>();
  const mtimes = new Map<string, number>();

  for (const file of files) {
    const raw = readJsonc(file);
    if (raw !== undefined) {
      collectExplicitModelOverrides(raw, explicitModelOverrides);
      merged = deepMerge(merged, raw);
    }
    try {
      mtimes.set(file, fs.statSync(file).mtimeMs);
    } catch (err) {
      throw new Error(`Failed to stat config file ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let config: OmreConfig;
  try {
    config = OmreConfigSchema.parse(merged);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Config validation failed: ${issues}`);
    }
    throw err;
  }

  if (configCache.size >= MAX_CACHE_SIZE) {
    const firstKey = configCache.keys().next().value;
    if (firstKey !== undefined) {
      configCache.delete(firstKey);
    }
  }

  configCache.set(cacheKey, {
    config: structuredClone(config),
    explicitModelOverrides: new Set(explicitModelOverrides),
    mtimes,
  });
  return { config, explicitModelOverrides };
}

export function defaultConfigJsonc(): string {
  const defaults = OmreConfigSchema.parse({});
  // models.orchestrator is deprecated (no consumer; orchestrator runs as the
  // user's primary agent). Omit it from the scaffold so fresh configs do not
  // advertise an inactive field. Existing configs with the field still parse.
  const { orchestrator: _orchestrator, ...activeModels } = defaults.models;
  const config = {
    $schema: "https://raw.githubusercontent.com/zapsaang/oh-my-review-experts/main/schemas/oh-my-review-experts.schema.json",
    enabled: defaults.enabled,
    command: defaults.command,
    models: activeModels,
    slicing: defaults.slicing,
    partialRerun: defaults.partialRerun,
    costGuardrail: defaults.costGuardrail,
    arbitration: defaults.arbitration,
    report: defaults.report,
    handoff: defaults.handoff,
    reviewers: defaults.reviewers,
  };
  return JSON.stringify(config, null, 2) + "\n";
}

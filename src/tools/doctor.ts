/**
 * Inspect an OpenCode user/project config object and return warnings about
 * permissions that may prevent reviewer subagents from invoking omre_* tools.
 *
 * Recognized permission shapes (any one is enough to suppress the warning):
 * - `permission["omre_*"] === "allow"`                   (wildcard allow)
 * - `permission["omre_<tool_name>"] === "allow"` for each writer/validator
 * - `permission.subagent.<name>["omre_*"] === "allow"`   (per-subagent allow)
 *
 * `"deny"` is reported as a hard problem.
 * `"ask"` is reported as a soft warning because non-interactive subagent
 * sessions cannot answer permission prompts.
 *
 * The function is intentionally tolerant of unknown shapes and returns
 * `[]` (no warnings) for input that is not a plain object.
 *
 * KNOWN LIMITATION: this only inspects opencode.json. OpenCode also supports
 * permission overrides in agent frontmatter (`agents/<name>.md`) and other
 * locations; those are not analyzed here. Doctor output should reflect this
 * limitation so users do not interpret a clean check as proof of full coverage.
 */
import fs from "node:fs";
import { parse as parseJsonc } from "jsonc-parser";
import type { Config } from "@opencode-ai/plugin";
import { AGENT_NAMES } from "../agents/registry.js";

const PLUGIN_NAME = "oh-my-review-experts";

export function checkOmrePermissions(config: unknown): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [];
  }

  const root = config as Record<string, unknown>;
  const permission = root.permission;
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) {
    return [
      "permission rules do not include an entry for omre_* tools. Add `\"permission\": { \"omre_*\": \"allow\" }` to opencode.json so reviewer subagents can call plugin tools.",
    ];
  }

  const top = permission as Record<string, unknown>;
  const requiredTools = ["omre_write_handoff", "omre_validate_handoff", "omre_write_report"];

  const directDeny = top["omre_*"] === "deny";
  if (directDeny) {
    return ['permission["omre_*"] is set to "deny"; reviewer subagents will be unable to call plugin tools.'];
  }

  const directAsk = top["omre_*"] === "ask";
  if (directAsk) {
    return ['permission["omre_*"] is set to "ask"; non-interactive subagents cannot answer permission prompts.'];
  }

  if (top["omre_*"] === "allow") return [];

  const allIndividuallyAllowed = requiredTools.every((tool) => top[tool] === "allow");
  if (allIndividuallyAllowed) return [];

  const subagent = top.subagent;
  if (subagent && typeof subagent === "object" && !Array.isArray(subagent)) {
    for (const value of Object.values(subagent as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if ((value as Record<string, unknown>)["omre_*"] === "allow") {
          return [];
        }
      }
    }
  }

  return [
    "permission rules do not allow omre_* tools. Add `\"permission\": { \"omre_*\": \"allow\" }` to opencode.json so reviewer subagents can call plugin tools.",
  ];
}

export interface OpencodeConfigStatus {
  exists: boolean;
  pluginRegistered: boolean;
  permissionWarnings: string[];
}

function readConfigFile(filePath: string): string | undefined {
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export function checkOpencodeConfig(filePath: string): OpencodeConfigStatus {
  const text = readConfigFile(filePath);
  if (text === undefined) {
    return { exists: false, pluginRegistered: false, permissionWarnings: [] };
  }
  const parsed = parseJsonc(text);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { exists: true, pluginRegistered: false, permissionWarnings: [] };
  }
  const root = parsed as Record<string, unknown>;
  const pluginArray = Array.isArray(root.plugin)
    ? root.plugin
    : Array.isArray(root.plugins)
      ? root.plugins
      : [];
  const pluginRegistered = (pluginArray as unknown[]).includes(PLUGIN_NAME);
  const permissionWarnings = checkOmrePermissions(parsed);
  return { exists: true, pluginRegistered, permissionWarnings };
}

export interface AgentRegistrationStatus {
  registered: number;
  expected: number;
  missing: string[];
}

export function checkAgentRegistration(config: Config): AgentRegistrationStatus {
  const expected = AGENT_NAMES.length;
  const agentMap = (config.agent ?? {}) as Record<string, unknown>;
  const missing = AGENT_NAMES.filter((name) => !agentMap[name]);
  const registered = expected - missing.length;
  return { registered, expected, missing: [...missing] };
}

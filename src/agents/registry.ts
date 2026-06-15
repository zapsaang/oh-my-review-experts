import type { Config } from "@opencode-ai/plugin";
import type { OmreConfig } from "../config/schema.js";
import { DEFAULT_MODEL } from "../config/schema.js";
import {
  COMPLETE_REVIEWER_PROMPTS,
  SLICE_PLANNER_PROMPT,
  SLICE_PLAN_VALIDATOR_PROMPT,
  RESULT_VALIDATOR_PROMPT,
  SLICE_ARBITER_PROMPT,
  GLOBAL_ARBITER_PROMPT,
  REPORT_WRITER_PROMPT,
} from "./prompts.js";

export interface AgentRegistration {
  readonly name: keyof OmreConfig["agents"];
  readonly staticPrompt: string;
  readonly description: string;
  readonly toolsAllow: readonly string[];
  readonly toolsDenyExtra?: readonly string[];
}

/**
 * Tools denied for every registered subagent unless explicitly allowed.
 * Enforces leaf guardrails via the runtime tool whitelist, not just prompt prose.
 */
export const TOOL_DENY_BASELINE = [
  "task",
  "skill",
  "edit",
  "write",
  "bash",
  "webfetch",
  "todowrite",
  "websearch",
] as const;

/**
 * Permission denies applied to every registered subagent. Defense in depth on
 * top of the tool whitelist: even if a tool slips through, the permission
 * layer rejects the action.
 */
export const PERMISSION_DENIES = {
  edit: "deny",
  bash: "deny",
  webfetch: "deny",
  websearch: "deny",
  doom_loop: "deny",
  external_directory: "deny",
} as const;

/**
 * Tools every reviewer agent is allowed to call. Reviewers read source
 * (read/grep/glob) and write a single handoff file via omre_write_handoff.
 */
const REVIEWER_TOOLS_ALLOW = ["read", "grep", "glob", "omre_write_handoff"] as const;

export const REVIEWER_AGENTS: readonly AgentRegistration[] = [
  {
    name: "omre-reviewer-spec",
    staticPrompt: COMPLETE_REVIEWER_PROMPTS.spec,
    description: "Validates specification compliance, API contracts, schema compatibility, and silent behavior drift.",
    toolsAllow: REVIEWER_TOOLS_ALLOW,
  },
  {
    name: "omre-reviewer-quality",
    staticPrompt: COMPLETE_REVIEWER_PROMPTS.quality,
    description: "Validates maintainability and design quality: cohesion, coupling, duplication, error handling, and testability.",
    toolsAllow: REVIEWER_TOOLS_ALLOW,
  },
  {
    name: "omre-reviewer-security",
    staticPrompt: COMPLETE_REVIEWER_PROMPTS.security,
    description: "Validates cybersecurity risk: authn/authz, injection, traversal, secret leakage, and unsafe defaults.",
    toolsAllow: REVIEWER_TOOLS_ALLOW,
  },
  {
    name: "omre-reviewer-performance",
    staticPrompt: COMPLETE_REVIEWER_PROMPTS.performance,
    description: "Validates performance risk: algorithmic regressions, blocking IO, N+1 queries, and tail latency.",
    toolsAllow: REVIEWER_TOOLS_ALLOW,
  },
  {
    name: "omre-reviewer-concurrency",
    staticPrompt: COMPLETE_REVIEWER_PROMPTS.concurrency,
    description: "Validates race conditions, atomicity violations, ordering issues, and distributed inconsistency.",
    toolsAllow: REVIEWER_TOOLS_ALLOW,
  },
];

export const COORDINATOR_AGENTS: readonly AgentRegistration[] = [
  {
    name: "omre-slice-planner",
    staticPrompt: SLICE_PLANNER_PROMPT,
    description: "Partitions code changes into coherent review slices by module boundary and risk profile.",
    toolsAllow: ["read", "grep", "glob"],
  },
  {
    name: "omre-slice-plan-validator",
    staticPrompt: SLICE_PLAN_VALIDATOR_PROMPT,
    description: "Validates slice planner JSON output for structural correctness.",
    toolsAllow: ["read"],
  },
  {
    name: "omre-result-validator",
    staticPrompt: RESULT_VALIDATOR_PROMPT,
    description: "Validates reviewer JSON outputs for dimension matching and completeness.",
    toolsAllow: ["read", "omre_validate_handoff"],
  },
  {
    name: "omre-slice-arbiter",
    staticPrompt: SLICE_ARBITER_PROMPT,
    description: "Merges and deduplicates reviewer outputs for one slice.",
    toolsAllow: ["read", "omre_validate_handoff"],
  },
  {
    name: "omre-global-arbiter",
    staticPrompt: GLOBAL_ARBITER_PROMPT,
    description: "Consumes all slice arbiter outputs and produces a globally merged result.",
    toolsAllow: ["read", "omre_validate_handoff"],
  },
  {
    name: "omre-report-writer",
    staticPrompt: REPORT_WRITER_PROMPT,
    description: "Persists the final merged results to configured report paths.",
    toolsAllow: ["read", "omre_write_report", "omre_finalize_review"],
  },
];

export const ALL_AGENTS: readonly AgentRegistration[] = [
  ...REVIEWER_AGENTS,
  ...COORDINATOR_AGENTS,
];

export const AGENT_NAMES: readonly string[] = ALL_AGENTS.map((a) => a.name);

export interface RegistrationResult {
  registered: string[];
  skipped: string[];
}

export function buildAgentConfig(agent: AgentRegistration, omreConfig: OmreConfig): Record<string, unknown> {
  const tools: Record<string, boolean> = {};
  for (const t of TOOL_DENY_BASELINE) tools[t] = false;
  for (const t of agent.toolsDenyExtra ?? []) tools[t] = false;
  // Allowlist must iterate last: explicit allow overrides the deny baseline.
  for (const t of agent.toolsAllow) tools[t] = true;

  const agentOverride = omreConfig.agents?.[agent.name];

  return {
    mode: "subagent",
    hidden: false,
    disable: false,
    model: agentOverride?.model ?? DEFAULT_MODEL,
    ...(agentOverride?.variant !== undefined && { variant: agentOverride.variant }),
    ...(agentOverride?.temperature !== undefined && { temperature: agentOverride.temperature }),
    ...(agentOverride?.top_p !== undefined && { top_p: agentOverride.top_p }),
    prompt: agent.staticPrompt,
    description: agent.description,
    tools,
    permission: { ...PERMISSION_DENIES },
  };
}

type AgentSlot = NonNullable<Config["agent"]>[string];

/**
 * Register the 11 review subagents into config.agent.
 *
 * - Honors `omreConfig.enabled`: short-circuits when disabled.
 * - Idempotent: re-invoking with the same input is a no-op for existing
 *   entries (object identity preserved between calls).
 * - User overrides win: any pre-populated `config.agent[name]` is left
 *   untouched and reported in `skipped`.
 */
export function registerAgents(config: Config, omreConfig: OmreConfig): RegistrationResult {
  const result: RegistrationResult = { registered: [], skipped: [] };

  if (!omreConfig.enabled) {
    return result;
  }

  // Defense: an empty Config has no `agent` key; without this guard the loop
  // below would crash on `config.agent[name]`.
  config.agent = config.agent ?? {};
  const agentMap = config.agent;

  for (const agent of ALL_AGENTS) {
    if (agentMap[agent.name]) {
      result.skipped.push(agent.name);
      continue;
    }
    agentMap[agent.name] = buildAgentConfig(agent, omreConfig) as AgentSlot;
    result.registered.push(agent.name);
  }

  return result;
}

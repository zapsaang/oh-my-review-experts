import type { Config } from "@opencode-ai/plugin";
import type { OmreConfig } from "../config/schema.js";

export interface AgentRegistration {
  readonly name: string;
}

export const REVIEWER_AGENTS: readonly AgentRegistration[] = [];
export const COORDINATOR_AGENTS: readonly AgentRegistration[] = [];
export const ALL_AGENTS: readonly AgentRegistration[] = [];
export const AGENT_NAMES: readonly string[] = [];

export interface RegistrationResult {
  registered: string[];
  skipped: string[];
}

export function registerAgents(_config: Config, _omreConfig: OmreConfig): RegistrationResult {
  return { registered: [], skipped: [] };
}

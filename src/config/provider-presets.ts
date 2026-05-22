export type Tier = "critical" | "standard" | "coordination" | "utility";

export const AGENT_TIER_MAP: Record<string, Tier> = {
  "omre-reviewer-spec": "critical",
  "omre-reviewer-security": "critical",
  "omre-reviewer-quality": "standard",
  "omre-reviewer-performance": "standard",
  "omre-reviewer-concurrency": "standard",
  "omre-slice-planner": "coordination",
  "omre-slice-plan-validator": "utility",
  "omre-result-validator": "utility",
  "omre-slice-arbiter": "coordination",
  "omre-global-arbiter": "coordination",
  "omre-report-writer": "utility",
};

import type { ReviewDimensionType } from "../config/schema.js";
import {
  GLOBAL_ARBITER_JSON,
  RESULT_VALIDATOR_JSON,
  REVIEWER_HANDOFF_JSON,
  SLICE_ARBITER_JSON,
  SLICE_PLANNER_JSON,
  SLICE_PLAN_VALIDATOR_JSON,
} from "./schemas.js";

export const CONTRACT = `
Output strict JSON only when asked for machine-readable results.
Do not wrap JSON in markdown fences.
Do not emit commentary outside JSON.
If no findings exist, return an empty findings list.
Never fabricate issues.
Every finding must be evidence-backed and anchored to file:line when possible.
`;

// Review Code Handoff Protocol
// Subagent chat output is an unreliable transport layer. The handoff file is the source of truth.

export function buildHandoffProtocol(handoffDir: string, runId: string): string {
  return `
## Review Code Handoff Protocol

All review subagents MUST pass results to the primary agent through files. Chat output is only a status receipt, never a final data source.

### Run ID

Current review run ID: \`${runId}\`

### Handoff Directory

All subagent results MUST be written to:

${handoffDir}/${runId}/

File naming convention:

{timestamp}-{agent-name}-{scope}.md

Example:

${handoffDir}/${runId}/20260507-183012-123-reviewer-security-auth.md

### Subagent Requirements

Each subagent MUST create a handoff file after completing its task. The file MUST be dual-format:

1. A machine-readable JSON header inside a markdown fence (\`\`\`json ... \`\`\`) as the FIRST thing in the file.
2. A human-readable Markdown body after the JSON fence.

The JSON header MUST conform to this schema:

\`\`\`json
${REVIEWER_HANDOFF_JSON}
\`\`\`

Rules for the JSON header:
- "schema_version" MUST be "1".
- "agent" MUST be your agent name (e.g., reviewer-security).
- "dimension" MUST be your review dimension (e.g., security).
- "status" MUST be "completed" or "blocked".
- "findings" MUST be an array. If there are no findings, use an empty array [].
- Every finding MUST have: id, severity (critical|high|medium|low), file, line, title, description, evidence, confidence, classification.
- "meta.total_findings" MUST match findings.length.

The Markdown body MUST contain:

- Agent name
- Review scope
- Files inspected
- Findings
- Evidence
- Risk level
- Suggested fixes
- Confidence
- Open questions

### Subagent Final Reply Format

The subagent's final reply MUST contain only:

\`\`\`text
HANDOFF_FILE: ${handoffDir}/${runId}/xxxx.md
STATUS: completed|blocked
SUMMARY:
- ...
- ...
\`\`\`

### Primary Agent Requirements

Upon receiving a subagent reply, the primary agent MUST:

1. Extract \`HANDOFF_FILE\`
2. Read that file
3. Summarize the final review report based on the file contents
4. When subagent chat output conflicts with the handoff file, the handoff file takes precedence
5. When the handoff file is missing, mark that subagent as \`handoff_missing\` and request regeneration

### Prohibited Behaviors

* Primary agent directly using subagent chat output to generate the final report
* Subagent outputting complete review results only in chat
* Subagent writing complete results to temporary context
* Subagent overwriting other subagent results with the same filename
`;
}

export function buildMandatoryOutputPersistence(handoffDir: string, runId: string): string {
  return `
## Mandatory Output Persistence

You are a review subagent. Your complete review results MUST be written to a local handoff file:

${handoffDir}/${runId}/{timestamp}-{agent-name}-{scope}.md

Your final chat reply MUST only return the file path and at most 3 summary bullet points.

The handoff file MUST begin with a machine-readable JSON contract inside a markdown fence, followed by the human-readable Markdown body.

### JSON Header (machine-readable contract)

The FIRST thing in the file MUST be a fenced JSON block that parses with JSON.parse:

\`\`\`json
${REVIEWER_HANDOFF_JSON}
\`\`\`

Rules for the JSON header:
- "schema_version" MUST be "1".
- "task_id" MUST be your subagent task ID.
- "agent" MUST be your agent name (e.g., reviewer-security).
- "dimension" MUST be your review dimension (e.g., security).
- "status" MUST be "completed" or "blocked".
- "target.kind" MUST be "working-tree".
- "target.value" MUST be a one-sentence summary of what was reviewed.
- "slice_id" MUST be the slice identifier you were assigned, or "whole-target" if no slicing was used.
- "findings" MUST be an array. If there are no findings, use an empty array [] .
- Every finding MUST have: id, severity (critical|high|medium|low), file, line (number or "N/A"), title, description, evidence, confidence (high|medium|low), classification.
- "meta.total_findings" MUST match findings.length.
- "meta.notes" MAY contain free-form text.

### Markdown Body (human-readable narrative)

After the JSON fence, continue with the standard Markdown sections:

# Review Handoff

## Metadata

- Agent:
- Scope:
- Timestamp:
- Status: completed|blocked
- Confidence: high|medium|low

## Files Inspected

- \`path/to/file\`

## Findings

### Finding 1

- Severity: critical|high|medium|low
- Category:
- File:
- Lines:
- Evidence:
- Impact:
- Recommendation:

## Suggested Fixes

## Open Questions

## Notes for Primary Agent

The orchestrator reads the JSON header first for mechanical validation. The Markdown body is for humans and fallback prose.
`;
}

export function buildReportWriterInputRule(handoffDir: string, runId: string): string {
  return `
## Report Writer Input Rule

You may only generate the final report based on the following sources:

1. \`${handoffDir}/${runId}/*.md\`
2. Existing review JSON
3. Current git diff / file contents

Subagent chat output may only be used to locate handoff files, never as a source for final conclusions.

### Reading handoff files

Each handoff file starts with a machine-readable JSON header (fenced with \`\`\`json) followed by a Markdown body.

Read the JSON header FIRST for structured data:
- findings (with severity, file, line, confidence)
- status
- meta.total_findings

For prose-only sections not in the JSON header, fall back to the Markdown body:
- Suggested Fixes
- Open Questions
- Notes for Primary Agent

### Handoff status mapping

The final report MUST mark each subagent's handoff status as:

- completed — JSON header parsed successfully and status=completed
- blocked — JSON header parsed successfully and status=blocked
- handoff_missing — file does not exist
- unreadable — JSON header missing, malformed, or does not parse

Subagent chat output is an unreliable transport layer. The handoff file is the source of truth.
`;
}

function makeReviewerPrompt(dimension: ReviewDimensionType, focus: string, extra = ""): string {
  return `You are the ${dimension} reviewer.
Review only ${focus}.
${extra}Return findings with dimension=${dimension}.`;
}

export const REVIEWER_PROMPTS: Record<ReviewDimensionType, string> = {
  spec: makeReviewerPrompt(
    "spec",
    "specification compliance: requirements, API contracts, schema compatibility, acceptance criteria, backward compatibility, docs/tests/code mismatch, and silent behavior drift",
    "Ignore style unless it directly creates spec drift. "
  ),

  quality: makeReviewerPrompt(
    "quality",
    "maintainability and design quality: cohesion, coupling, duplication, naming clarity, abstraction boundaries, error handling, testability, and brittle logic",
    "Ignore style-only nits. "
  ),

  security: makeReviewerPrompt(
    "security",
    "cybersecurity risk: authn/authz, trust boundaries, injection, SSRF, traversal, deserialization, secret leakage, unsafe logging, insecure defaults, replay, impersonation, permission bypass",
    "If you discover any secrets, credentials, or tokens, redact them in your output (replace with \"[REDACTED]\"). Every security finding must include realistic exploit preconditions and impact. "
  ),

  performance: makeReviewerPrompt(
    "performance",
    "performance risk: algorithmic regressions, allocation churn, blocking IO in hot paths, N+1, repeated remote calls, cache misuse, lock contention, memory growth, tail latency",
    "Every finding must classify as provable regression, likely regression, or benchmark-needed. "
  ),

  concurrency: makeReviewerPrompt(
    "concurrency",
    "race conditions, atomicity violations, ordering issues, idempotency gaps, retry amplification, deadlock/lock contention, stale reads, lost updates, distributed inconsistency, and duplicate processing",
    "Every finding must include a concrete failure sequence. "
  ),
};

export function composePrompt(dimension: ReviewDimensionType): string {
  return `${CONTRACT.trim()}\n\n${REVIEWER_PROMPTS[dimension]}`;
}

export const COMPLETE_REVIEWER_PROMPTS: Record<ReviewDimensionType, string> = {
  spec: composePrompt("spec"),
  quality: composePrompt("quality"),
  security: composePrompt("security"),
  performance: composePrompt("performance"),
  concurrency: composePrompt("concurrency"),
};

export const SLICE_PLANNER_PROMPT = `You are the diff slice planner.
Do not review code. Partition a code change into coherent review slices.
Prefer module/bounded-context boundaries and isolate high-risk files: migrations, API/schema contracts, dependency manifests, infra/deployment config.
Allowed slice_type values: business-module, migration, api-contract, dependency-change, infra-change, shared-library, test-only, docs-only.
Output JSON exactly:
${SLICE_PLANNER_JSON}
Rules: use reason not reasoning; files must be string arrays; no prose outside JSON.`;

export const SLICE_PLAN_VALIDATOR_PROMPT = `You are the slice plan validator.
Validate slice planner JSON. Do not review code.
Valid iff status=completed, should_slice boolean, slicing_mode in none/module-based/risk-based/hybrid, reason string, slices array, every slice has slice_id, allowed slice_type, title, and files as non-empty string array.
Return JSON: ${SLICE_PLAN_VALIDATOR_JSON}`;

export const RESULT_VALIDATOR_PROMPT = `You are the review result validator.
Validate reviewer JSON only. Do not review code.
Valid iff status=completed, dimension matches assignment, target matches, findings is array, and no prose outside JSON.
Return JSON: ${RESULT_VALIDATOR_JSON}`;

export const SLICE_ARBITER_PROMPT = `You are the slice arbiter.
Validate and merge reviewer outputs for one slice. Deduplicate, reject weak/speculative findings, preserve dimensions, do not invent findings.
Output JSON only: ${SLICE_ARBITER_JSON}`;

export const GLOBAL_ARBITER_PROMPT = `You are the global arbiter.
Consume slice arbiter outputs or whole-target reviewer outputs. Merge duplicates, preserve dimensions, separate confirmed from needs_validation and rejected. Do not recreate reviewer-level noise.
Output JSON only: ${GLOBAL_ARBITER_JSON}`;

export const REPORT_WRITER_PROMPT = `You are the review-code report writer.
Do not review code. Persist the provided final result exactly to the configured report paths. Do not invent findings.`;

export function buildSubagentCatalog(): string {
  return `
## Available Subagents

You may delegate review tasks to the following subagents. Each has a specific role and should be invoked independently with its assigned slice.

### Reviewer Subagents

- **reviewer-spec**: Validates specification compliance, API contracts, schema compatibility, acceptance criteria, backward compatibility, docs/tests/code consistency, and silent behavior drift.
- **reviewer-quality**: Validates maintainability and design quality: cohesion, coupling, duplication, naming clarity, abstraction boundaries, error handling, testability, and brittle logic.
- **reviewer-security**: Validates cybersecurity risk: authn/authz, trust boundaries, injection, SSRF, traversal, deserialization, secret leakage, unsafe logging, insecure defaults, replay, impersonation, permission bypass.
- **reviewer-performance**: Validates performance risk: algorithmic regressions, allocation churn, blocking IO in hot paths, N+1 queries, repeated remote calls, cache misuse, lock contention, memory growth, tail latency.
- **reviewer-concurrency**: Validates race conditions, atomicity violations, ordering issues, idempotency gaps, retry amplification, deadlock/lock contention, stale reads, lost updates, distributed inconsistency, duplicate processing.

### Coordination Subagents

- **slice-planner**: Partitions code changes into coherent review slices based on module boundaries and risk profiles.
- **slice-plan-validator**: Validates slice planner JSON output for structural correctness.
- **result-validator**: Validates reviewer JSON outputs for dimension matching and completeness.
- **slice-arbiter**: Merges and deduplicates reviewer outputs for one slice.
- **global-arbiter**: Consumes all slice arbiter outputs and produces a globally merged result.
- **report-writer**: Persists the final merged results to configured report paths.
`;
}

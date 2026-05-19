import type { ReviewDimensionType } from "../config/schema.js";
import {
  CONCURRENCY_CLASSIFICATION_VALUES,
  CONFIDENCE_VALUES,
  GLOBAL_ARBITER_JSON,
  PERFORMANCE_CLASSIFICATION_VALUES,
  REJECTION_REASON_VALUES,
  RESULT_VALIDATOR_JSON,
  REVIEWER_HANDOFF_JSON,
  SCHEMA_VERSION,
  SEVERITY_VALUES,
  SLICE_ARBITER_JSON,
  SLICE_PLANNER_JSON,
  SLICE_PLAN_VALIDATOR_JSON,
  SLICE_TYPE_VALUES,
} from "./schemas.js";

/**
 * Base rules every JSON-emitting subagent must follow, regardless of channel.
 * Channel-specific rules (chat-only vs file-primary) live in CHAT_JSON_CONTRACT
 * and FILE_HANDOFF_CONTRACT below.
 */
const BASE_JSON_RULES = `
Output strict JSON only when asked for machine-readable results.
If no findings exist, return an empty findings list.
Never fabricate issues.
Every finding must be evidence-backed and anchored to file:line when possible.
`;

/**
 * Coordinator-facing contract: bare JSON in chat, no markdown fences, no prose.
 * Used by slice-planner / slice-plan-validator / result-validator / slice-arbiter
 * / global-arbiter — agents that emit transient intermediate computations the
 * orchestrator consumes once in the same turn.
 */
export const CHAT_JSON_CONTRACT = `${BASE_JSON_RULES.trim()}
Do not wrap JSON in markdown fences.
Do not emit commentary outside JSON.
`;

/**
 * Reviewer-facing contract: persistent artifact via omre_write_handoff. The
 * handoff file requires a markdown ```json fence + Markdown body, and the chat
 * reply is a small fixed receipt. Therefore "no fences" and "no outside-JSON
 * prose" do NOT apply — those rules belong to CHAT_JSON_CONTRACT only.
 */
export const FILE_HANDOFF_CONTRACT = `${BASE_JSON_RULES.trim()}
`;

export const LEAF_GUARDRAIL = `You are a leaf reviewer. Do not invoke the task tool. Do not invoke the skill tool. Do not delegate to any subagent. Your output must be a single handoff file per the handoff protocol, followed by the short chat reply specified by that protocol.`;

export const LEAF_COORDINATOR_GUARDRAIL = `You are a leaf coordinator. Do not invoke the task tool. Do not invoke the skill tool. Do not delegate to any subagent. Your output must follow the exact format specified in your instructions, with no additional commentary.`;

// Review Code Handoff Protocol
// Subagent chat output is an unreliable transport layer. The handoff file is the source of truth.

const HANDOFF_DIR_TEMPLATE = "{handoffDir}";
const RUN_ID_TEMPLATE = "{runId}";

/**
 * Channel and format rules for reviewer handoffs, with runtime values
 * (handoffDir, runId) replaced by the literal placeholders {handoffDir}
 * and {runId}. This string is embedded into reviewer staticPrompt at
 * registration time so the system-channel contract matches the user-channel
 * delegation; the per-run path values are then injected through
 * buildHandoffRuntime() in the orchestrator's user-turn prompt.
 */
export const STATIC_HANDOFF_PROTOCOL = renderHandoffProtocol(
  HANDOFF_DIR_TEMPLATE,
  RUN_ID_TEMPLATE,
);

/**
 * Per-run path stanza naming the actual handoff directory and runId for the
 * current review run. Used by the orchestrator to remind subagents which
 * directory their files belong in. The full channel/format rules already
 * live in each reviewer's staticPrompt via STATIC_HANDOFF_PROTOCOL.
 */
export function buildHandoffRuntime(handoffDir: string, runId: string): string {
  return `
## Review Code Handoff Runtime

Current review run ID: \`${runId}\`

All subagent results for this run MUST be written under:

${handoffDir}/${runId}/

The full handoff protocol (file format, receipt format, chat output rule,
prohibited behaviors) is embedded in each reviewer subagent's prompt and is
not duplicated here.
`;
}

/**
 * @deprecated Compose `STATIC_HANDOFF_PROTOCOL` (in reviewer staticPrompt) and
 * `buildHandoffRuntime(handoffDir, runId)` (in orchestrator prompt) instead.
 * Kept so legacy callers and existing tests continue to receive the combined
 * runtime+protocol text in one string.
 */
export function buildHandoffProtocol(handoffDir: string, runId: string): string {
  return renderHandoffProtocol(handoffDir, runId);
}

function renderHandoffProtocol(handoffDir: string, runId: string): string {
  return `
## Review Code Handoff Protocol

All review subagents MUST pass results to the primary agent through files. Chat output is only a status receipt, never a final data source.

### Run ID

Current review run ID: \`${runId}\`

### Handoff Directory

All subagent results MUST be written to:

${handoffDir}/${runId}/

**YOU MUST use the \`omre_write_handoff\` tool to write handoff files. Do NOT use the \`write\` tool directly.** The \`omre_write_handoff\` tool handles file naming and location automatically. When calling \`omre_write_handoff\`, pass the current \`runId\` as the top-level \`runId\` argument so the file lands inside the per-run handoff directory.

### Subagent Requirements

Each subagent MUST create a handoff file after completing its task. The file MUST be dual-format:

1. A machine-readable JSON header inside a markdown fence (\`\`\`json ... \`\`\`) as the FIRST thing in the file.
2. A human-readable Markdown body after the JSON fence.

The JSON header MUST conform to this schema:

\`\`\`json
${REVIEWER_HANDOFF_JSON}
\`\`\`

Rules for the JSON header:
- "schema_version" MUST be "${SCHEMA_VERSION}".
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

The subagent's final reply MUST consist of EXACTLY this block, with no text before it and no text after it:

\`\`\`text
HANDOFF_FILE: ${handoffDir}/${runId}/xxxx.md
STATUS: completed|blocked
SUMMARY:
- ...
- ...
\`\`\`

Replace \`xxxx.md\` with the filename returned by \`omre_write_handoff\`. Replace the SUMMARY bullets with one-line descriptions of your findings (or "no findings" if none).

### Chat output rule (critical)

NEVER include a \`\`\`json fence in your chat reply. The handoff JSON header lives in the file ONLY. Recovery from a missing or invalid file is the primary agent's responsibility, not yours; do not try to "help" by duplicating the JSON in chat.

If \`omre_write_handoff\` returns \`{ "ok": false, "errors": [...] }\`, do NOT emit a JSON fence in chat — instead, set STATUS to \`blocked\` and list the tool errors in the SUMMARY bullets. The primary agent will retry.

### Primary Agent Requirements

Upon receiving a subagent reply, the primary agent MUST:

1. Extract \`HANDOFF_FILE\` from the receipt block
2. Read that file
3. Summarize the final review report based on the file contents
4. When the handoff file is missing or fails validation, call \`omre_validate_handoff\` with the \`filePath\`. If the result reports the file is missing or invalid, mark the subagent as \`handoff_missing\` and request regeneration. The chat-fence fallback path inside \`omre_validate_handoff\` exists for legacy callers; new code should treat the file as the only source of truth.

### Prohibited Behaviors

* Primary agent directly using subagent chat output as a data source — only the receipt block (\`HANDOFF_FILE\` / \`STATUS\` / \`SUMMARY\`) is consumed from chat
* Subagent skipping \`omre_write_handoff\` and emitting only chat output
* Subagent emitting a \`\`\`json fence in chat for any reason
* Subagent writing complete results to temporary context
* Subagent overwriting other subagent results with the same filename
* Subagent using the \`write\` tool directly to create handoff files instead of \`omre_write_handoff\`
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

### Degraded coverage propagation

If any reviewer handoff fails validation after one retry, the arbiter MUST:
1. Add the slice to \`degraded_slices\` with its \`slice_id\` and the \`missing_dimensions\` array.
2. Add the missing dimension(s) to \`missing_dimensions_global\`.

The report writer MUST render a \`## Coverage warning\` section at the top of the final Markdown report when either field is non-empty. The warning must list each degraded slice and its missing dimensions, plus any globally missing dimensions.

When coverage is degraded, the report headline must NOT say "No issues found"; use "No confirmed issues found in covered dimensions" instead.

Subagent chat output is an unreliable transport layer. The handoff file is the source of truth.
`;
}

function makeReviewerPrompt(dimension: ReviewDimensionType, focus: string, extra = ""): string {
  return `${LEAF_GUARDRAIL}

You are the ${dimension} reviewer.
Review only ${focus}.
${extra}Return findings with dimension=${dimension}.

Every finding MUST use severity from: ${SEVERITY_VALUES.join(", ")}.
Every finding MUST use confidence from: ${CONFIDENCE_VALUES.join(", ")}.
Use only values from these enums. If a finding does not match any classification, lower its confidence or drop it.`;
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
    `Every finding must classify as one of: ${PERFORMANCE_CLASSIFICATION_VALUES.join(", ")}.
Use only values from this enum. If a finding does not match any classification, lower its confidence or drop it. `
  ),

  concurrency: makeReviewerPrompt(
    "concurrency",
    "race conditions, atomicity violations, ordering issues, idempotency gaps, retry amplification, deadlock/lock contention, stale reads, lost updates, distributed inconsistency, and duplicate processing",
    `Every finding must classify as one of: ${CONCURRENCY_CLASSIFICATION_VALUES.join(", ")}.
Use only values from this enum. If a finding does not match any classification, lower its confidence or drop it.
Every finding must include a concrete failure sequence. `
  ),
};

export function composePrompt(dimension: ReviewDimensionType): string {
  return `${FILE_HANDOFF_CONTRACT.trim()}\n\n${REVIEWER_PROMPTS[dimension]}\n${STATIC_HANDOFF_PROTOCOL}`;
}

export const COMPLETE_REVIEWER_PROMPTS: Record<ReviewDimensionType, string> = {
  spec: composePrompt("spec"),
  quality: composePrompt("quality"),
  security: composePrompt("security"),
  performance: composePrompt("performance"),
  concurrency: composePrompt("concurrency"),
};

const COORDINATOR_CHAT_DIRECTIVE = `### Output channel (critical)

Output exactly one JSON object as your entire chat reply.
Do not wrap in markdown fences.
Do not emit any text outside the JSON.
You do not have any handoff write tool. Do not call omre_write_handoff. Do not call omre_write_report.`;

function makeCoordinatorPrompt(role: string): string {
  return `${CHAT_JSON_CONTRACT.trim()}

${LEAF_COORDINATOR_GUARDRAIL}

${role.trim()}

${COORDINATOR_CHAT_DIRECTIVE}`;
}

export const SLICE_PLANNER_PROMPT = makeCoordinatorPrompt(`
You are the diff slice planner.
Do not review code. Partition a code change into coherent review slices.
Prefer module/bounded-context boundaries and isolate high-risk files: migrations, API/schema contracts, dependency manifests, infra/deployment config.
Allowed slice_type values: ${SLICE_TYPE_VALUES.join(", ")}.
Output JSON exactly:
${SLICE_PLANNER_JSON}
Rules: use reason not reasoning; files must be string arrays; no prose outside JSON.
`);

export const SLICE_PLAN_VALIDATOR_PROMPT = makeCoordinatorPrompt(`
You are the slice plan validator.
Validate slice planner JSON. Do not review code.
Valid iff status=completed, should_slice boolean, slicing_mode in none/module-based/risk-based/hybrid, reason string, slices array, every slice has slice_id, allowed slice_type, title, and files as non-empty string array.
Return JSON: ${SLICE_PLAN_VALIDATOR_JSON}
`);

export const RESULT_VALIDATOR_PROMPT = makeCoordinatorPrompt(`
You are the review result validator.
Validate reviewer JSON only. Do not review code.
Valid iff status=completed, dimension matches assignment, target matches, findings is array, and no prose outside JSON.
Return JSON: ${RESULT_VALIDATOR_JSON}
`);

export const SLICE_ARBITER_PROMPT = makeCoordinatorPrompt(`
You are the slice arbiter.
Validate and merge reviewer outputs for one slice. Deduplicate, reject weak/speculative findings, preserve dimensions, do not invent findings.
Rejection reasons must be one of: ${REJECTION_REASON_VALUES.join(", ")}.
Free-form rejection reasons are forbidden.
Output JSON only: ${SLICE_ARBITER_JSON}
`);

export const GLOBAL_ARBITER_PROMPT = makeCoordinatorPrompt(`
You are the global arbiter.
Consume slice arbiter outputs or whole-target reviewer outputs. Merge duplicates, preserve dimensions, separate confirmed from needs_validation and rejected. Do not recreate reviewer-level noise.
Rejection reasons must be one of: ${REJECTION_REASON_VALUES.join(", ")}.
Free-form rejection reasons are forbidden.
Output JSON only: ${GLOBAL_ARBITER_JSON}
`);

export const REPORT_WRITER_PROMPT = `${LEAF_COORDINATOR_GUARDRAIL}

You are the review-code report writer.
Do not review code. Persist the provided final result exactly to the configured report paths. Do not invent findings.
You have one write tool, omre_write_report. Call it once with the final markdown and JSON. Do not call any other write tool.`;

export function buildSubagentCatalog(): string {
  return `
## Available Subagents

You may delegate to the following registered subagents (each runs with its own context, model, and tool whitelist):

reviewer-spec, reviewer-quality, reviewer-security, reviewer-performance, reviewer-concurrency, slice-planner, slice-plan-validator, result-validator, slice-arbiter, global-arbiter, report-writer
`;
}

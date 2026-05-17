# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] — 2026-05-17

### Changed (BREAKING)

- `omre_write_handoff` now rejects an explicitly-empty `task_id` in its payload via a Zod refinement: supplying `task_id: ""` returns `{ ok: false, errors: ["task_id, when provided, must be non-empty"] }` and writes no file. Omitting `task_id` is still allowed (and is the recommended pattern).
- `omre_write_handoff` success response now carries the resolved `taskId`: `{ ok: true, filePath, taskId }`. Callers that previously only read `parsed.filePath` continue to work; the new field is additive.
- `writeHandoff()` in `src/tools/handoff.ts` no longer defaults a missing `taskId` to `""`. When the input `taskId` is missing or empty, it generates a deterministic non-empty value of the form `<runId>-<timestamp>-<agent>-<3-digit-counter>` and writes it into the JSON header. The counter is per-process and keyed by `(runId, agent)`, so concurrent writers in the same review run get distinct ids without coordination across processes.
- `writeHandoff()` return type changed from `string` to `{ filePath: string; taskId: string }`. This is a breaking change to the internal API. The package's only production caller (`omre_write_handoff` in `src/tools/plugin-tools.ts`) and all tests are migrated in this release.

### Added

- `generateTaskId(runId, agent, timestamp)` exported from `src/tools/handoff.ts`. Deterministic per-process taskId generator used by `writeHandoff` when the caller omits `taskId`.
- 3 new tests covering: `writeHandoff` round-trip (resolved taskId equals JSON-header `task_id`), `omre_write_handoff` rejection of explicitly-empty `task_id`, and `omre_write_handoff` returning the resolved taskId in the success response. Total test count is now 540 (was 537 in 0.1.3).

### Migration notes

- Production callers of `omre_write_handoff`: read `parsed.taskId` if you need the resolved id; existing `parsed.filePath` reads are unchanged.
- Internal callers of `writeHandoff()`: destructure `const { filePath } = writeHandoff(...)` instead of assigning to a string. The previous string return is gone.
- Prompts are unchanged. Reviewer staticPrompt continues to show `"task_id": "<subagent task id>"` as a placeholder; the new behavior is "if you supply nothing, the tool generates one and reads it back to you in the response".

## [0.1.3] — 2026-05-17

### Added

- `SlicePlannerSchema`, `SlicePlanValidatorSchema`, `ResultValidatorSchema`, `SliceArbiterSchema`, `GlobalArbiterSchema` exported from `src/agents/schemas.ts` — Zod schemas that are now the single source of truth for coordinator output structure.
- `SLICE_TYPE_VALUES` exported constant enumerating the eight allowed `slice_type` values (mirrors the slice planner prompt vocabulary).
- 21 new schemas-side unit tests + 5 coordinator-prompt snapshot tests in `test/agents/`. Total test count is 537 (was 511 in 0.1.2).

### Changed (BREAKING — prompt format)

- `SLICE_PLANNER_JSON`, `SLICE_PLAN_VALIDATOR_JSON`, `RESULT_VALIDATOR_JSON`, `SLICE_ARBITER_JSON`, `GLOBAL_ARBITER_JSON` are now derived: `JSON.stringify(zodToExample(<Schema>), null, 2)`. Identifier names are unchanged so existing imports continue to compile, but the rendered text differs. The four previously-compact one-liners are now multi-line indented; coordinator prompts that interpolate them therefore changed shape. Field examples now use the canonical placeholder vocabulary produced by `zodToExample` (e.g. `"completed|blocked"`, `"string"`, `0`, `true`) instead of hand-written sentinel values.
- `zodToExample` now renders `z.unknown()` as `null` and `z.nullable(...)` as `null` (instead of unwrapping to the inner type or returning the literal string `"unknown"`). This keeps prompt-facing examples JSON-clean for schemas that include an `unknown | null` branch (used by `SlicePlanValidatorSchema.normalized_result`).

### Migration notes

- No caller changes required. The five `SLICE_*_JSON` constants keep their names and remain plain strings; only their content shape changed.
- Schema evolution is now schema-side. Adding a field to a coordinator output is one edit in `schemas.ts`; the prompt example regenerates automatically and the snapshot test forces a deliberate review of the rendered prompt.



### Fixed

- Subagent output non-determinism (the "json / file / both" symptom): root causes L1–L4 from `.sisyphus/plans/subagent-output-contract-fix.md` are eliminated. Reviewer subagents now have one channel (file via `omre_write_handoff`) and coordinator subagents have one channel (bare JSON in chat).
- Removed the literal contradiction between `CONTRACT` (forbade markdown fences and outside-JSON prose) and `buildHandoffProtocol` (mandates a json fence inside the file plus a `HANDOFF_FILE`/`STATUS`/`SUMMARY` chat receipt). `CONTRACT` is now an alias of `FILE_HANDOFF_CONTRACT`; coordinators consume the new `CHAT_JSON_CONTRACT`.
- Removed the internal contradiction inside `buildHandoffProtocol` (the receipt block was simultaneously "contain only" and "MUST also include" the chat-fallback fence). The receipt is now the EXACT entire reply; the fence-in-chat path is removed from the subagent's view.
- Reviewer staticPrompt now embeds the full handoff protocol (template form with `{handoffDir}`/`{runId}` placeholders) so the system-channel and user-channel contracts agree. The orchestrator's user-turn prompt only injects the per-run path stanza via the new `buildHandoffRuntime()` helper.

### Changed (BREAKING)

- `omre_write_handoff` return shape: now returns `{ "ok": true, "filePath": "..." }` on success and `{ "ok": false, "errors": ["..."] }` on failure, and never throws. Existing consumers reading `parsed.filePath` directly must first assert `parsed.ok === true`.
- Coordinator prompts (`SLICE_PLANNER_PROMPT`, `SLICE_PLAN_VALIDATOR_PROMPT`, `RESULT_VALIDATOR_PROMPT`, `SLICE_ARBITER_PROMPT`, `GLOBAL_ARBITER_PROMPT`) now flow through a shared composer (`makeCoordinatorPrompt`) that prepends `CHAT_JSON_CONTRACT` and appends a chat-only directive ("Output exactly one JSON object as your entire chat reply", "Do not wrap in markdown fences", "Do not call omre_write_handoff").
- The orchestrator prompt no longer contains the full handoff protocol — that text now lives in each reviewer's staticPrompt. Future protocol edits are made in `prompts.ts` and propagate via `composePrompt()`.

### Added

- `CHAT_JSON_CONTRACT` and `FILE_HANDOFF_CONTRACT` exports in `src/agents/prompts.ts`.
- `STATIC_HANDOFF_PROTOCOL` (template-form protocol) and `buildHandoffRuntime(handoffDir, runId)` in `src/agents/prompts.ts`.
- New TDD coverage in `test/agents/prompts.test.ts`, `test/agents/registry.test.ts`, `test/tools/plugin-tools.test.ts`, `test/workflow/run-review-code.test.ts` (39 new assertions; 511 tests pass).

### Deprecated

- `CONTRACT` constant: kept as an alias of `FILE_HANDOFF_CONTRACT`. Prefer the explicit channel-specific constants.
- `buildHandoffProtocol(handoffDir, runId)`: kept as a wrapper that returns the combined runtime + protocol text. Prefer composing `STATIC_HANDOFF_PROTOCOL` (in reviewer staticPrompt) and `buildHandoffRuntime()` (in orchestrator prompt) instead.

### Migration notes

- Tools: any caller of `omre_write_handoff` must read `parsed.ok` before reading `parsed.filePath`. The previous throw-on-failure path is gone.
- Prompts: no migration required for the orchestrator. Reviewer subagents will receive a longer system prompt (≈ +3 KB per reviewer) because the protocol moved into the system channel.
- Out of scope (deferred to follow-up PRs): full schema-as-source-of-truth migration of `SLICE_*_JSON` template strings, `omre doctor` contract self-check, CI snapshot fixtures, and removal of deprecated `ReviewerFindingSchema` aliases.

## [0.1.0] — 2026-05-17

### Added

- Runtime subagent registration: 11 review subagents (5 reviewers + 6 coordinators) are now registered at plugin boot via the `config` hook, completing the v1→v2 migration. (`src/agents/registry.ts`, `src/index.ts`)
- `omre doctor` now reports the registered subagent count: `agents: <N>/11 registered`.

### Changed

- `models.spec`, `models.quality`, `models.security`, `models.performance`, `models.concurrency`, `models.slicePlanner`, `models.validator`, `models.sliceArbiter`, `models.globalArbiter`, `models.reportWriter` config fields are now consumed by registered subagents (previously dead config).
- Reviewer leaf guardrails (`do not invoke task`, `do not invoke skill`) are now enforced via OpenCode's tool whitelist + permission denies, not only prompt prose.
- User overrides at `config.agent[<name>]` are preserved (skip-on-conflict, mirroring command registration).
- `buildSubagentCatalog()` in `src/agents/prompts.ts` was reduced to a one-line pointer; the registered agents themselves now serve as the authoritative catalog.

### Deprecated

- `models.orchestrator` config field. The orchestrator runs as the user's primary agent; the plugin cannot influence its model. The field is kept for parsing compatibility and is marked `deprecated: true` in the JSON Schema.

### Migration notes

- Observable: 11 new entries appear in OpenCode's subagent picker after upgrade. No user action required.
- Configs with `models.orchestrator` set still parse cleanly. The value is ignored.
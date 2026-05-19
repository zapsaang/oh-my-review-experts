# Verification Gate: Conditional Fix 1

## Sources inspected

- Plan gate: `.omo/plans/omre-report-output-fix-v2.md`.
  - `Conditional Fix 1 (Zod union for omre_write_report.json) only if a verification gate confirms a real parse failure.`
  - `If logs show a Zod/parse error on omre_write_report.json, the technical root cause stands -> keep Fix 1 + JSON.stringify guidance in scope.`
  - `If logs show only the architectural bypass ... the technical fix is dropped.`
  - `If logs are unavailable ... default to the architecturally-confirmed-only path. Do not implement speculative parsing fixes.`
- Notepad context: `.omo/notepads/omre-report-output-fix-v2/learnings.md` and `.omo/notepads/omre-report-output-fix-v2/issues.md`.
  - `learnings.md` records: `Conditional Fix 1 should remain SKIPPED unless P0 evidence proves: LLM is sending malformed json argument that can't be parsed`.
  - `issues.md` is empty.
- Current repository artifacts under `.omre/`.
  - `.omre/reports/latest.md` contains `# Test`.
  - `.omre/reports/latest.json` contains `{ "summary": "test" }`.
  - `.omre/reports/history/` contains only `20260513-*` files; none contain run `20260519-141258-095`.
  - `.omre/handoffs/` is absent.
- Original run artifacts discovered under `/home/ricardom/code/github.com/zapsaang/aura/.omre/reports/`.
  - `latest.md` line 1: `Report persisted to .omre/reports/20260519-141258-095-report.md`.
  - `latest.json` lines 2-8:
    ```json
    "run_id": "20260519-141258-095",
    "status": "completed",
    "total_findings": 19,
    "report_files": {
      ".omre/reports/20260519-141258-095-report.md": "markdown",
      ".omre/reports/20260519-141258-095-report.json": "json"
    }
    ```
  - `history/20260519-144453-880-review.md` line 1: `Report persisted to .omre/reports/20260519-141258-095-report.md`.
  - `history/20260519-144453-880-review.json` lines 2-8 mirror the same metadata object.
  - `20260519-141258-095-report.md` starts with `# AURA Code Review Report`, includes `Run ID: 20260519-141258-095`, and is 316 lines.
  - `20260519-141258-095-report.json` includes `"run_id": "20260519-141258-095"`, a structured `summary`, and a `slices` array; it is 287 lines.
- Session search/read results.
  - Searched sessions for `20260519-141258-095`, `omre_write_report`, `Zod`, `parse`, `tool args`, `latest.md`, `latest.json`, `report.md`, `ZodError`, `validation error`, `tool-argument`, `parse failure`, `JSON PARSE ERROR`, `Invalid JSON`, and `Report persisted to .omre/reports/20260519-141258-095-report.md`.
  - `ZodError`, `validation error`, `JSON PARSE ERROR`, and `parsed error` returned no matches tied to the run or to `omre_write_report.json`.
  - `tool-argument` matched only this verification-gate task wording, not an old run log.
  - `Invalid JSON` matched proposed future error-envelope text and tests, not a recorded failure from run `20260519-141258-095`.
  - Session `ses_1c0fd9c57ffezf2vsTjFlCd1Pr` recorded the artifact layout: `latest.md - BUGGY OUTPUT (contains reference path)` and `20260519-141258-095-report.md - CORRECT output (full formatted report)`.
  - Session `ses_1c0e442c0ffeoqmwWXOPfAAzhY` recorded the Metis audit conclusion: artifacts are consistent with a successful `omre_write_report` call carrying stub content, and the LLM self-explanation is not diagnostic evidence.
  - Session `ses_1c0e84bdbffe9cK8IabdwntOH9` recorded that the run artifacts were later absent from this repo and the raw run log could not be re-verified there.

## Findings

1. Zod/parse failure on `omre_write_report.json`: NOT PROVEN.
   - No inspected source contains a concrete `ZodError`, tool-argument parse error, validation error, malformed-input envelope, or retryable parse failure for `omre_write_report.json` on run `20260519-141258-095`.
   - The only parse-failure claims are an LLM self-report and later proposal text. Those are theory, not concrete run-log evidence.
2. Architectural bypass/stub write: PROVEN.
   - The original run's canonical `latest.md` and matching history markdown contain only the reference string `Report persisted to .omre/reports/20260519-141258-095-report.md`.
   - The original run's canonical `latest.json` and matching history JSON are metadata objects pointing to separate report files, not the structured report payload.
   - The separate `20260519-141258-095-report.md` and `20260519-141258-095-report.json` files contain the full report content. This proves the full report was produced outside the canonical `latest.*` payload, while canonical files received stubs.
3. Logs unavailable: TRUE for raw tool-call failure evidence.
   - OpenCode session summaries and local artifacts are available.
   - A raw tool-call log showing the exact `omre_write_report` invocation and any framework/Zod parse failure was not found through `session_search`, `session_read`, local `.omre/`, local `.omo/`, or `test-evidence/` inspection.

## Decision

Conditional Fix 1: SKIP

Rationale: Concrete evidence proves the architectural bypass/stub-write pattern, while no inspected source proves a Zod/tool-argument parse failure on `omre_write_report.json`. Under plan section 2.2 and section 3 Step 11, logs unavailable or architectural-only evidence selects the architecturally-confirmed-only path. Speculative parsing fixes are out of scope for this plan run.

## Implications

- Do not implement the Conditional Fix 1 `json: string | record` union.
- Do not add Fix 1 RED/GREEN tests in `test/tools/plugin-tools.test.ts` for this plan execution.
- Do not add JSON.stringify guidance solely to support Conditional Fix 1.
- Continue later prompts on the architecturally-confirmed path: positive report validation, runId/history propagation, server-side `omre_finalize_review`, prompt updates for that architecture, doctor cleanup, permission-hook spike, and final verification.
- Reopen this gate only if a future prompt attaches raw run-log lines proving a Zod/parse failure specifically on `omre_write_report.json`.

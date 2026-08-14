# Deferred Slop Issues (Debt Ledger)

Recorded: 2026-08-14. Source: AI-slop audit of `src/` (61 files, 55 findings). Round 1 fixed high+medium severity (27 findings across 20 files). Round 2 (same day) cleared F, I, Misc-low, and the security-hardening items — 16 of 20 ledger items resolved, 4 reassessed as verified non-issues. The items below remain deliberately deferred.

## Awaiting decision

### J1 — Plugin tool error-contract inconsistency (medium)
`src/tools/plugin-tools.ts` mixes two failure contracts across sibling tools:

| Tool | Contract |
|---|---|
| `omre_build_review_code_prompt` (:62-75) | throws |
| `omre_write_report` (:91-102) | throws |
| `omre_write_handoff` (:130-175) | result-error `{ ok: false, errors }` |
| `omre_dry_run` (:184-188) | throws |
| `omre_finalize_review` (:199-220) | mixed (path validation throws; finalization returns result-error) |
| `omre_config` (:228-232) | throws |
| `omre_validate_handoff` (:252-297) | mixed (path violations throw; validation failures return `{ isValid: false }`) |

Unifying is API-visible (tool callers observe the difference). Needs a contract decision before any change.

## Deferred by scope (low severity)

### E — Oversized modules (12 files, >250 pure LOC)
`memory/cli.ts` (454), `cli.ts` (380), `workflow/run-review-code.ts` (319), `workflow/validate-result.ts` (310), `workflow/scope-resolver.ts` (299), `tools/doctor.ts` (298), `memory/check.ts` (291), `memory/trends.ts` (273), `tools/plugin-tools.ts` (273), `agents/prompts.ts` (261), `memory/gc.ts` (252), `memory/store.ts` (251).
Splitting requires a per-file modular refactoring plan approved before execution.

## Verified non-issues (audit false positives)

- G1 `plugin-tools.ts` manual non-empty validation: **load-bearing**. Tests pin direct schema-bypassing `execute()` calls (test/tools/plugin-tools.test.ts:240-364); trial removal failed 4 pinned tests. Guards stay.
- F `memory/pipeline.ts` `autoIndexAfterReview`, `memory/extractor/index.ts` `extractRawFindings`, `memory/quarantine.ts` `appendQuarantineEntry`: **not orphaned** — Round 2 found direct test importers (pipeline.test.ts:9, extractor/index.test.ts:6, quarantine.test.ts:5). Exports stay.
- G3 `memory/normalize.ts` `in` checks: **load-bearing** — tests explicitly pass objects missing `id`/`confidence` keys (normalize.test.ts:140-141, 249-252). Guards stay.
- Category A (type-safety suppression): zero findings. No `as any` / `@ts-ignore` / `@ts-expect-error` in `src/`.

## Round 2 resolved (2026-08-14)

- F dead code: removed `AGENT_NAMES` (config/schema.ts), `loadConfig` import (index.ts), `formatAgeHours` (memory/pipeline.ts), `SlicePlan` (workflow/types.ts), unreachable `default:` (memory/store.ts).
- I comments: fixed stale lock comment (memory/gc.ts), stale Claim 2 comment (memory/paths.ts), 7 redundant phase/layer headings (tools/secret-scanner.ts), contradictory doc blocks (workflow/validate-result.ts), regex-restating comment (cli.ts).
- Misc low: C9 useless `await`+`async` removed (memory/cli.ts); G2 pass-through try/catch removed (workflow/run-review-code.ts); D2 `persistReport` → `PersistReportOptions`; D3 `collectReviewMemorySections` → `CollectReviewMemorySectionsOptions`.
- Security: model-facing errors no longer embed absolute paths (config/load-config.ts, workflow/run-meta.ts, memory/gc.ts — root-relative diagnostic detail retained); memory/store.ts now hashes raw file bytes before UTF-8 decoding.
- Verification: typecheck PASS; full suite 78 files / 1558 tests PASS (2 net-new regression tests pin the store-byte-hashing and gc relative-path behaviors).

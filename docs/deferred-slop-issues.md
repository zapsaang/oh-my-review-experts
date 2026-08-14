# Deferred Slop Issues (Debt Ledger)

Recorded: 2026-08-14. Source: AI-slop audit of `src/` (61 files, 55 findings). Round 1 fixed high+medium severity (27 findings across 20 files). The items below are deliberately deferred.

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

## Deferred by scope (low severity, next round candidates)

### E — Oversized modules (12 files, >250 pure LOC)
`memory/cli.ts` (454), `cli.ts` (380), `workflow/run-review-code.ts` (319), `workflow/validate-result.ts` (310), `workflow/scope-resolver.ts` (299), `tools/doctor.ts` (298), `memory/check.ts` (291), `memory/trends.ts` (273), `tools/plugin-tools.ts` (273), `agents/prompts.ts` (261), `memory/gc.ts` (252), `memory/store.ts` (251).
Splitting requires a per-file modular refactoring plan approved before execution.

### F — Dead code (8)
- `config/schema.ts:47-52` unused `AGENT_NAMES` const
- `index.ts:5` unused `loadConfig` import
- `memory/pipeline.ts:217-219` unused private `formatAgeHours`
- `memory/pipeline.ts:144-146` orphaned export `autoIndexAfterReview`
- `memory/extractor/index.ts:29-33` orphaned export `extractRawFindings`
- `memory/quarantine.ts:91-99` orphaned export `appendQuarantineEntry`
- `workflow/types.ts:10-16` unused `SlicePlan` interface
- `memory/store.ts:237-239` unreachable `default: break;`

### I — Stale/redundant comments (5)
- `memory/gc.ts:44-53` claims "no lock yet" — `withMemoryLock` exists since :63
- `memory/paths.ts:53` "future Claim 2 implementation" — already implemented
- `tools/secret-scanner.ts` phase/layer headings paraphrase code
- `workflow/validate-result.ts:202-221` adjacent contradictory doc blocks
- `cli.ts:394-400` comment restates the following regex

### Misc low
- C9 `memory/cli.ts:174-183` ineffective `await` on void function
- G2 `workflow/run-review-code.ts:143-152` catch that only rethrows
- G3 `memory/normalize.ts:83-85,133-139` redundant `in` checks on typed optionals
- D2 `workflow/run-review-code.ts:374-376` 7-arg `persistReport` (signature change skipped)
- D3 `workflow/review-memory-context.ts:68-76` 7-arg `collectReviewMemorySections` (signature change skipped)

## Security hardening (LOW, from 5-lane review)

- `config/load-config.ts:70`, `workflow/run-meta.ts:27,33`, `memory/gc.ts:183-202` — newly thrown errors embed absolute paths; OpenCode surfaces tool errors as message-only (no stack), but paths may become model-visible. Consider generic model-facing messages + root-relative local logs.
- `memory/store.ts:159` — `createHash.update(content)` hashes UTF-8-decoded/re-encoded text, not exact file bytes; malformed byte sequences normalize to replacement chars. Consider hashing the raw Buffer once, then decoding for parsing.

## Verified non-issues (audit false positives)

- G1 `plugin-tools.ts` manual non-empty validation: **load-bearing**. Tests pin direct schema-bypassing `execute()` calls (test/tools/plugin-tools.test.ts:240-364); trial removal failed 4 pinned tests. Guards stay.
- Category A (type-safety suppression): zero findings. No `as any` / `@ts-ignore` / `@ts-expect-error` in `src/`.

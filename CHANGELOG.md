# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
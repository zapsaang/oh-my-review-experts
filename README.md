<div align="center">

# Oh My Review Experts

**A five-expert AI code review panel for [OpenCode](https://github.com/sst/opencode) — one slash command, zero agent folders in your repo.**

[![npm](https://img.shields.io/npm/v/oh-my-review-experts.svg)](https://www.npmjs.com/package/oh-my-review-experts)
[![OpenCode](https://img.shields.io/badge/OpenCode-1.14%2B-blue)](https://github.com/sst/opencode)
[![Node](https://img.shields.io/badge/Node-20%2B-339933)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

Reviewing a real diff well is not one job — it's five. Spec compliance, code quality, security, performance, and concurrency each demand a different lens, and most AI review setups either squash them into one mushy prompt or make you hand-curate a folder of agent definitions you have to maintain forever.

`omre` takes a third path. Install once, type `/review-code`, and get a structured report with findings, evidence, suggested fixes, and an audit trail on disk. The expert panel lives inside the plugin, so your repo stays clean — no agent markdown, no command files copied in, just one line in `opencode.json`.

## Features

- **Five focused reviewers, one command.** Spec, quality, security, performance, and concurrency each run with their own prompt contract and JSON output schema — no shared blind spots.
- **Smart slicing.** Changed files are classified into eight categories, grouped by module, and routed only to the reviewers that matter. Docs-only changes skip review entirely; migrations get spec, performance, and concurrency.
- **Cost guardrails.** Every run estimates its task count up front, shifts to compact mode past a soft limit, and halts to ask before it can run away with your budget.
- **Partial rerun.** When one reviewer fails or returns malformed output, only that task re-runs. The rest of the pipeline keeps its results.
- **Review Memory.** Findings are indexed after each run, so future reviews resurface relevant history and flag regressions — a previously fixed issue reappearing in a similar module gets caught.
- **Reports that stick around.** Final output lands in `.omre/reports/` as human-readable Markdown and schema-validated JSON, with timestamped history snapshots.
- **Security on by default.** Path-traversal guards, prompt-injection filtering, and secret redaction run on every boundary, with no toggle to turn them off.
- **A clean install.** `omre install` writes a single plugin entry to `opencode.json`. Everything else resolves in memory at startup.

## Getting started

### Prerequisites

- [OpenCode](https://github.com/sst/opencode) 1.14 or newer
- [Node.js](https://nodejs.org) 20 or newer
- A git repository (the plugin reads changed files via `git diff`)

### Install

Install globally and enable it for every project:

```bash
npm install -g oh-my-review-experts
omre install --global
```

Or scope it to a single project:

```bash
cd your-project
npx oh-my-review-experts install --project
```

> [!NOTE]
> `omre install` only writes the plugin entry to `opencode.json` plus an optional config file. It never copies agents or commands into your repo.

### Run your first review

In OpenCode, review your working changes:

```text
/review-code
```

Steer the panel toward what you care about:

```text
/review-code focus on disk format compatibility and concurrency hazards
```

Or preview the assembled prompt without calling any model:

```text
/review-code --echo-prompt
```

## Usage

### Choosing what to review

`/review-code` accepts optional scope prefixes that control which changes get reviewed:

| Input | Resolved scope | Equivalent git command |
|---|---|---|
| *(empty)* | working tree + staged + untracked | `git diff HEAD` + `git ls-files --others --exclude-standard` |
| `staged` / `--staged` / `--cached` | staged only | `git diff --cached` |
| `commit:<ref>` | one commit | `git show <ref>` |
| `branch:<name>` | branch vs HEAD | `git diff <name>...HEAD` |
| `range:<from>..<to>` | commit range | `git diff <from>...<to>` |
| `path:<paths>` | filtered by path (comma-separated) | `git diff HEAD -- <paths>` |
| bare `<sha>` | resolves to commit if it exists | same as `commit:` |
| bare `<branch>` | resolves to branch if it exists | same as `branch:` |
| bare `<path>` | resolves to path if it exists | same as `path:` |
| anything else | guidance text (default scope still reviewed) | `git diff HEAD` |

A bare input that is both a branch and a directory is ambiguous and needs an explicit prefix.

### The reviewers

| Reviewer | Looks for |
|---|---|
| `spec` | Contract drift, breaking changes, missing requirements |
| `quality` | Readability, maintainability, duplication, dead paths |
| `security` | Injection, authz gaps, unsafe crypto, leaked secrets |
| `performance` | Hot-path allocations, N+1 queries, bad complexity |
| `concurrency` | Races, deadlocks, ordering hazards, cancellation bugs |

## How it works

```
1. /review-code runs in OpenCode
   ↓
2. command.execute.before hook intercepts
   ↓
3. Git diff captured, secrets redacted
   ↓
4. Slicing engine groups changed files
   ↓
5. Cost guardrail estimates task count
   ↓
6. Reviewers run in parallel, per slice
   ↓
7. Each reviewer writes a handoff file
   ↓
8. Slice arbiter merges per-slice findings
   ↓
9. Global arbiter merges across slices
   ↓
10. Report writer persists latest.md, latest.json, history/
```

Subagents write structured Markdown to `.omre/handoffs/{runId}/`, and the orchestrator builds the final report from those files — not from chat transcripts. Chat output is a receipt; the file is the source of truth. That keeps long reviews reproducible and debuggable.

The plugin registers the command and all 11 subagents at boot through OpenCode's `config` hook, so there are no command markdown files to maintain.

## Configuration

Configuration is optional — if you never write one, sensible defaults apply. When you do, `omre` walks a hierarchy and deep-merges, with project config overriding global.

Load order (later wins):

1. `~/.config/opencode/oh-my-review-experts.jsonc`
2. `~/.config/opencode/oh-my-review-experts.json`
3. `.opencode/oh-my-review-experts.jsonc`
4. `.opencode/oh-my-review-experts.json`
5. `.omre/config.jsonc`
6. `.omre/config.json`

Scaffold a starting point with `omre init`. A representative config:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/zapsaang/oh-my-review-experts/main/schemas/oh-my-review-experts.schema.json",
  "enabled": true,
  "command": {
    "enabled": true,
    "name": "review-code",
    "aliases": ["rc"],
    "injection": "both",
    "scopeResolution": "auto"
  },
  "agents": {
    // Per-agent overrides. Unlisted agents fall back to the default model.
    // "omre-reviewer-spec": { "model": "anthropic/claude-opus-4-7", "variant": "max", "temperature": 0.7, "top_p": 0.9 }
  },
  "slicing": {
    "enabled": true,
    "maxSlices": 4,
    "skipDocsOnly": true,
    "skipTestOnlyHeavyReview": true,
    "forceWholeTargetAboveSlices": 12
  },
  "partialRerun": { "enabled": true, "maxRetriesPerTask": 1 },
  "costGuardrail": {
    "enabled": true,
    "maxEstimatedTasks": 24,
    "compactModeThreshold": 20,
    "hardStopThreshold": 60
  },
  "arbitration": { "hierarchicalThreshold": 3 },
  "report": {
    "enabled": true,
    "directory": ".omre/reports",
    "latestMarkdown": "latest.md",
    "latestJson": "latest.json",
    "timestamped": true
  },
  "handoff": { "enabled": true, "directory": ".omre/handoffs" },
  "reviewers": {
    "default": ["spec", "quality", "security", "performance", "concurrency"],
    "bySliceType": {
      "api-contract":      ["spec", "security", "concurrency"],
      "migration":         ["spec", "performance", "concurrency"],
      "business-module":   ["spec", "security", "performance", "concurrency"],
      "shared-library":    ["spec", "quality", "security", "concurrency"],
      "dependency-change": ["security", "performance"],
      "infra-change":      ["security", "performance"],
      "test-only":         ["spec", "quality"],
      "docs-only":         []
    }
  }
}
```

### Injection modes

`command.injection` controls how `/review-code` is wired:

- `"both"` (default): registered via the `config` hook and intercepted by `command.execute.before`. Recommended.
- `"hook"`: same as `"both"`.
- `"disabled"`: no registration or interception. Useful for muting the plugin temporarily.
- `"tool"`: no slash command; plugin tools stay available via `hooks.tool`.

Setting `scopeResolution: "guidance-only"` reproduces the pre-0.x behavior: args become opaque guidance text and the scope is always `git diff HEAD`.

### Configurable agents

All 11 agents can be overridden by exact name under `agents`:

| Agent | Role |
|---|---|
| `omre-reviewer-spec` | Contract drift, breaking changes, missing requirements |
| `omre-reviewer-quality` | Readability, maintainability, duplication, dead paths |
| `omre-reviewer-security` | Injection, authz gaps, unsafe crypto, leaked secrets |
| `omre-reviewer-performance` | Hot-path allocations, N+1 queries, bad complexity |
| `omre-reviewer-concurrency` | Races, deadlocks, ordering hazards, cancellation bugs |
| `omre-slice-planner` | Classifies changed files into slices |
| `omre-slice-plan-validator` | Validates slice plan output |
| `omre-result-validator` | Validates reviewer handoff output |
| `omre-slice-arbiter` | Merges findings within a slice |
| `omre-global-arbiter` | Merges findings across slices |
| `omre-report-writer` | Persists the final report |

## CLI

```bash
omre init [--force]              # scaffold .opencode/oh-my-review-experts.jsonc
omre install --global            # enable plugin in ~/.config/opencode/opencode.json
omre install --project           # enable plugin in ./opencode.json
omre doctor [--clean-reports] [--strict]
                                 # validate config + wiring + contracts (used in CI)
                                 # exit codes: 0 clean, 1 warning (with --strict), 2 contract failure
omre dry-run                     # build the prompt locally, no model calls

omre memory check                # diagnose memory health
omre memory stats                # show aggregate counts
omre memory search "tenant isolation"
omre memory list --status open --reviewer security
omre memory show mem_xxx
omre memory mark mem_xxx --status fixed --reason "fixed in abc123"
omre memory compact              # merge raw event segments
omre memory gc                   # clean up old files
```

`omre doctor` reports config files, the command and its aliases, plugin registration, subagent permissions, agent runtime models (tier and source), the contract self-check, and report layout — making it a good CI gate. `omre dry-run` runs the pipeline up to the point a model would be invoked, then prints the assembled prompt and estimated plan.

## Reports and handoffs

Reports land under `.omre/reports/`:

```
.omre/reports/
├── latest.md                   # human-readable final report
├── latest.json                 # machine-readable (schema-validated)
└── history/
    └── 20260507-183012-123.md  # timestamped snapshots
```

Per-run handoffs are written under `.omre/handoffs/`:

```
.omre/handoffs/20260507-183012-123/
├── 20260507-183045-001-omre-reviewer-security-auth.md
├── 20260507-183047-002-omre-reviewer-performance-queue.md
└── ...
```

Each handoff carries the agent name, scope, files inspected, findings with evidence, risk level, suggested fixes, confidence, and open questions.

> [!NOTE]
> Durability is honest about its limits. File writes are atomic per file (temp + rename), so no single file is ever half-written — but there is no `fsync`, no cross-file transaction, and `.omre/memory/` is single-process with last-writer-wins semantics. Run `omre memory compact` after a crash.

For programmatic use, seven tools are exposed: `omre_build_review_code_prompt`, `omre_dry_run`, `omre_config`, `omre_write_handoff`, `omre_write_report`, `omre_validate_handoff`, and `omre_finalize_review`.

## Security

These protections are always on and not togglable:

- **Path-traversal guards** (`assertSafePath` / `assertSafeCwd`) on every write boundary, rejecting `..`, absolute paths, and non-UTF-8 byte sequences.
- **Prompt-injection filtering** on user args via a regex blacklist, with args truncated at 4 KB and a visible warning.
- **Scope-arg sanitization** rejecting shell metacharacters in path-shaped args, `..` segments, and leading `--`.
- **Secret redaction** (`redactSecrets`) that scrubs API keys, tokens, private keys, and connection strings from diffs before they reach any model.
- **Command-name validation** rejecting `__proto__`, `constructor`, and `prototype`.
- **Diff bounds**: the unified diff is capped at 180 KB with a visible truncation marker.
- **Permission hook**: a `permission.ask` hook auto-denies external write/edit access to `.omre/reports/` and `.omre/handoffs/`.

> [!TIP]
> Add `.omre/memory/` to your `.gitignore`. It can contain internal code paths and evidence from previous runs.

## Under the hood

- **Pure ESM, no CJS wrapper.** The package exposes only `exports.import` pointing at `dist/index.js`. OpenCode runs on Bun, and a CJS function module breaks its plugin loader with `"Plugin export is not a function"`. ESM only, always.
- **Near-zero runtime footprint.** `@opencode-ai/plugin` is a devDependency imported via `import type`; the shipped bundle is roughly 1 KB of code plus prompt strings.
- **Agent tiers.** Each subagent is tagged `critical`, `standard`, `coordination`, or `utility`, and `omre doctor` surfaces the tier, runtime model, and source (config override vs default) for every one.

## Development

```bash
npm install
npm run dev              # tsx src/cli.ts
npm run typecheck        # tsc --noEmit (strict, no `as any`)
npm run test             # vitest run
npm run generate-schema  # regenerate JSON schema from Zod types
npm run build            # prebuild -> tsup -> postbuild (ESM + .d.ts + sourcemaps)
npm run doctor:strict    # same as `doctor --strict`
```

CI (Node 22, Ubuntu) runs `npm ci && typecheck && test && build && doctor:strict`.

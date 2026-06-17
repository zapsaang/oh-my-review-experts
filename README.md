# Oh My Review Experts

> Five focused reviewers, one slash command, zero agent folders in your repo.

[![npm](https://img.shields.io/npm/v/oh-my-review-experts.svg)](https://www.npmjs.com/package/oh-my-review-experts)
[![OpenCode](https://img.shields.io/badge/OpenCode-1.14%2B-blue)](https://github.com/sst/opencode)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

`omre` turns `/review-code` in OpenCode into a multi-agent review pipeline. The expert panel lives inside the plugin, so you install once, add one line to `opencode.json`, and your repo stays clean. No agent markdown, no command files copied in.

## Why you'd want this

Reviewing a large diff well is five different jobs: spec compliance, code quality, security, performance, concurrency. Most AI review setups either squash them into one mushy prompt or make you hand-curate a folder of agent definitions.

`omre` takes the third path. Install once, type `/review-code`, get a structured report with findings, evidence, and an audit trail on disk.

## Quick start

Install globally and enable:

```bash
npm install -g oh-my-review-experts
omre install --global
```

Or scope to one project:

```bash
cd your-project
npx oh-my-review-experts install --project
```

Then run in OpenCode:

```text
/review-code
```

With focus:

```text
/review-code focus on disk format compatibility and concurrency hazards
```

With an explicit scope:

```text
/review-code branch:main
/review-code commit:abc1234
/review-code path:src/auth
/review-code staged
```

Preview the assembled prompt without calling any model:

```text
/review-code --echo-prompt
```

That's it. `omre install` only writes the plugin entry to `opencode.json` and an optional config file. It does not copy agents or commands into your repo.

## What you get

**Five focused reviewers, one command.** Each runs with its own prompt contract and JSON output schema:

| Reviewer | Looks for |
|---|---|
| `spec` | Contract drift, breaking changes, missing requirements |
| `quality` | Readability, maintainability, duplication, dead paths |
| `security` | Injection, authz gaps, unsafe crypto, leaked secrets |
| `performance` | Hot-path allocations, N+1, bad complexity |
| `concurrency` | Races, deadlocks, ordering hazards, cancellation bugs |

**A slicing engine that picks the right reviewers per chunk.** Changed files are classified into eight categories (`business-module`, `shared-library`, `api-contract`, `migration`, `dependency-change`, `infra-change`, `test-only`, `docs-only`), grouped by module, then dispatched to a reviewer subset. Docs-only slices skip review. Migration slices route to spec + performance + concurrency. Override the matrix in config.

**Cost guardrails you can trust.** Every run prints an estimated task count up front. Cross `maxEstimatedTasks` and the workflow shifts to compact mode. Cross `hardStopThreshold` and it halts and asks. No accidental thousand-dollar reviews.

**Partial rerun, not global retry.** When a reviewer fails or returns malformed output, `omre` re-runs only that task. The rest of the pipeline keeps its results.

**A handoff protocol, not chat theater.** Subagents write structured markdown to `.omre/handoffs/{runId}/`. The orchestrator reads files, not chat transcripts. Chat output is a receipt. The file is the source of truth. Long reviews stay reproducible and debuggable.

**Reports that stick around.** Final output lands in `.omre/reports/latest.md` and `latest.json`, with timestamped snapshots under `.omre/reports/history/`.

**Review Memory that learns.** After each run, findings are indexed into `.omre/memory/`. Future reviews surface relevant historical findings per slice and reviewer. A security finding marked `fixed` shows up again in a similar auth module, the security reviewer gets it as a regression candidate, and the final report links back to the original memory ID.

**Security built in, not bolted on.** Path traversal guards on every write. Prompt-injection regex filters on user args. Secret redaction on diffs before they reach any model. A `permission.ask` hook auto-denies external write/edit access to `.omre/reports/` and `.omre/handoffs/`. None of this is togglable.

> [!NOTE]
> Honest durability limits. File writes are atomic per file (temp + rename), so a single file is never half-written. There is no `fsync` and no cross-file transaction, and `.omre/memory/` is single-process with last-writer-wins semantics. Run `omre memory compact` after a crash.

## Scope syntax

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

Ambiguous bare inputs (a name that is both branch and directory) need an explicit prefix.

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

The plugin registers the command and all 11 subagents at boot through OpenCode's `config` hook. No command markdown files to maintain. `omre install` writes one line to `opencode.json`; everything else resolves in-memory on startup.

## Configuration

Configuration is optional. If you never write one, defaults apply. When you do, `omre` walks a hierarchy and deep-merges. Project wins over global.

Load order (later wins):

1. `~/.config/opencode/oh-my-review-experts.jsonc`
2. `~/.config/opencode/oh-my-review-experts.json`
3. `.opencode/oh-my-review-experts.jsonc`
4. `.opencode/oh-my-review-experts.json`
5. `.omre/config.jsonc`
6. `.omre/config.json`

### Agent reference

All 11 agents are configurable by exact name:

| Agent | Role |
|---|---|
| `omre-reviewer-spec` | Contract drift, breaking changes, missing requirements |
| `omre-reviewer-quality` | Readability, maintainability, duplication, dead paths |
| `omre-reviewer-security` | Injection, authz gaps, unsafe crypto, leaked secrets |
| `omre-reviewer-performance` | Hot-path allocations, N+1, bad complexity |
| `omre-reviewer-concurrency` | Races, deadlocks, ordering hazards, cancellation bugs |
| `omre-slice-planner` | Classifies changed files into slices |
| `omre-slice-plan-validator` | Validates slice plan output |
| `omre-result-validator` | Validates reviewer handoff output |
| `omre-slice-arbiter` | Merges findings within a slice |
| `omre-global-arbiter` | Merges findings across slices |
| `omre-report-writer` | Persists final report |

### Schema

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
- `"tool"`: no slash command. Plugin tools stay available via `hooks.tool`.

`scopeResolution: "guidance-only"` reproduces the pre-0.x behavior. Args become opaque guidance text and scope is always `git diff HEAD`.

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

`omre doctor` prints config files, command and aliases, plugin registration, subagent permissions, agent runtime models (tier and source), the contract self-check (prompt schemas and tool whitelists), and report layout. `--clean-reports` removes stray `*-report.{md,json}` artifacts.

`omre dry-run` runs the pipeline up to the point where a model would be invoked, then prints the assembled prompt and estimated plan.

## Reports and handoffs

Reports:

```
.omre/reports/
├── latest.md                   # human-readable final report
├── latest.json                 # machine-readable (schema-validated)
└── history/
    └── 20260507-183012-123.md  # timestamped snapshots
```

Handoffs:

```
.omre/handoffs/20260507-183012-123/
├── 20260507-183045-001-omre-reviewer-security-auth.md
├── 20260507-183047-002-omre-reviewer-performance-queue.md
└── ...
```

Each handoff carries the agent name, scope, files inspected, findings with evidence, risk level, suggested fixes, confidence, and open questions. The orchestrator reads these files to build the final report. Subagent chat output is a status receipt only.

Seven tools are exposed for programmatic use:

- `omre_build_review_code_prompt`: assemble the review prompt bundle for the current changes
- `omre_dry_run`: render the plan without invoking any model
- `omre_config`: load the merged OMRE configuration for the current project
- `omre_write_handoff`: persist a reviewer's findings
- `omre_write_report`: persist the final report
- `omre_validate_handoff`: validate a reviewer handoff
- `omre_finalize_review`: assemble and persist the final review from handoff files

## Security

Always on, not togglable:

- **Path traversal guards** (`assertSafePath` / `assertSafeCwd`) on every write boundary. Rejects `..`, absolute paths, and non-UTF-8 byte sequences.
- **Prompt-injection filter** on user args via a regex blacklist. Args are truncated at 4KB with a visible warning.
- **Scope-arg sanitization** rejects shell metacharacters in path-shaped args, `..` segments, and leading `--`.
- **Secret redaction** (`redactSecrets`) scrubs API keys, tokens, private keys, and connection strings from diffs before they reach any model.
- **Command-name validation** rejects `__proto__`, `constructor`, `prototype`.
- **Diff bounds**: unified diff capped at 180KB with a visible truncation marker.
- **Permission hook**: a `permission.ask` hook auto-denies external write/edit access to `.omre/reports/` and `.omre/handoffs/`, preventing accidental corruption of review artifacts.

## Requirements

- OpenCode 1.14 or newer
- Node 20 or newer
- A git repo (the plugin reads changed files via `git diff`)

## Under the hood

**Pure ESM, no CJS wrapper.** The package exposes only `exports.import` pointing at `dist/index.js`. OpenCode runs on Bun, and Bun imports a CJS function module in a way that breaks OpenCode's plugin loader. A CJS wrapper silently fails with `"Plugin export is not a function"`. ESM only, always.

**Zero runtime footprint from the plugin SDK.** `@opencode-ai/plugin` is a devDependency imported via `import type`. The shipped bundle is roughly 1KB of code plus prompt strings.

**Agent tiers.** Each of the 11 subagents is tagged by importance: `critical` (spec, security), `standard` (quality, performance, concurrency), `coordination` (planners, arbiters), or `utility` (validators, report writer). `omre doctor` surfaces tier, runtime model, and source (config override vs default) for every agent.

**Gitignore `.omre/memory/`.** It may contain internal code paths and evidence from previous runs. The parent `.omre/` directory is already ignored by this repo.

## Development

```bash
npm install
npm run dev              # tsx src/cli.ts
npm run typecheck        # tsc --noEmit (strict, no `as any`)
npm run test             # vitest run
npm run generate-schema  # regenerate JSON schema from Zod types
npm run build            # prebuild -> tsup -> postbuild (ESM + .d.ts + sourcemaps)
npm run doctor:strict    # same as `doctor --strict`
node dist/cli.js doctor
```

Local packaging and publishing:

```bash
npm run pack:local
npm run publish:dry-run
npm run publish:both
```

CI (Node 22, Ubuntu) runs `npm ci && typecheck && test && build && doctor:strict`.

---

MIT © zapsaang

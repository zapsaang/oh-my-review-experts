# Oh My Review Experts

> A panel of five senior reviewers, embedded into OpenCode, ready the moment you type `/review-code`.

[![npm](https://img.shields.io/npm/v/oh-my-review-experts.svg)](https://www.npmjs.com/package/oh-my-review-experts)
[![OpenCode](https://img.shields.io/badge/OpenCode-1.14%2B-blue)](https://github.com/sst/opencode)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Oh My Review Experts (`omre`) turns a single slash command into a multi-agent code review pipeline: slicing a diff into coherent chunks, dispatching specialist reviewers in parallel, arbitrating their findings, and persisting a full audit trail to disk — without littering your repo with agent markdown files.

---

## Why this exists

Reviewing a large diff well is *five different jobs*: spec compliance, code quality, security, performance, and concurrency. Most "AI review" setups either collapse them into one mushy prompt, or make you hand-curate a folder full of agent definitions.

`omre` picks the third option: **the expert panel lives inside the plugin**. You install once, add one line to `opencode.json`, and `/review-code` just works. Your repo stays clean.

---

## What you get

**Five focused reviewers, one command.** Each runs with its own prompt contract and JSON output schema:

| Reviewer | Looks for |
|---|---|
| `spec` | Contract drift, breaking changes, missing requirements |
| `quality` | Readability, maintainability, duplication, dead paths |
| `security` | Injection, authz gaps, unsafe crypto, leaked secrets |
| `performance` | Hot-path allocations, N+1, bad complexity |
| `concurrency` | Races, deadlocks, ordering hazards, cancellation bugs |

**A slicing engine that respects your repo.** `omre` classifies changed files into eight categories — `business-module`, `shared-library`, `api-contract`, `migration`, `dependency-change`, `infra-change`, `test-only`, `docs-only` — groups them by module, then picks the right reviewer subset for each slice. Docs-only slices skip the whole review. Migration slices route to spec + performance + concurrency. You can override the matrix in config.

**Cost guardrails you can trust.** Every run produces an estimated task count up front. If it exceeds `maxEstimatedTasks`, the workflow switches to compact mode. If it exceeds `hardStopThreshold`, it halts and asks. No accidental thousand-dollar reviews.

**Partial rerun, not global retry.** When a reviewer fails or produces malformed output, `omre` re-runs only that task — not the whole pipeline.

**A handoff protocol, not chat theater.** Subagents write structured markdown to `.omre/handoffs/{runId}/`. The orchestrator reads files, not chat transcripts. Chat output is a receipt; the file is the source of truth. This keeps long reviews reproducible and debuggable.

**Reports that stick around.** Final output lands in `.omre/reports/latest.md` and `latest.json`, with timestamped history under `.omre/reports/history/`. Written atomically via temp-file + rename, so a crash never leaves you with a half-written report.

**Agent tiers that reflect real cost tradeoffs.** Each of the 11 subagents is classified by importance — `critical` (spec, security), `standard` (quality, performance, concurrency), `coordination` (slice planner, arbiters), or `utility` (validators, report writer). The `omre doctor` command surfaces every agent's tier alongside its runtime model and source (config override vs. default), so you know exactly which reviewers are running on which model.

**Security built in, not bolted on.** Path traversal guards on every file write. Prompt-injection regex filters on user arguments. Secret redaction on diffs before they reach any model. Command-name validation that rejects `__proto__` and friends. The plugin also registers a `permission.ask` hook that auto-denies write/edit access to `.omre/reports/` and `.omre/handoffs/` from external agents, preventing accidental corruption of review artifacts.

---

## Quick start

Install the plugin:

```bash
npm install -g oh-my-review-experts
omre install --global
```

…or scope it to one project:

```bash
cd your-project
npx oh-my-review-experts install --project
```

That's it. `omre install` only touches `opencode.json` (adds the plugin entry) and optionally drops a config file. It does **not** copy agents, commands, or skills into your repo.

Open OpenCode and run:

```text
/review-code
```

With focus guidance:

```text
/review-code focus on disk format compatibility and concurrency hazards
```

With explicit scope:

```text
/review-code branch:main
/review-code commit:abc1234
/review-code path:src/auth
/review-code staged
```

Preview the generated prompt without calling any model:

```text
/review-code --echo-prompt
```

---

## Scope syntax

`/review-code` accepts optional scope prefixes that control which changes are reviewed:

| Input | Resolved scope | Equivalent git command |
|-------|----------------|------------------------|
| (empty) | working tree + staged + untracked | `git diff HEAD` + `git ls-files --others --exclude-standard` |
| `staged` / `--staged` / `--cached` | staged only | `git diff --cached` |
| `commit:<ref>` | one commit | `git show <ref>` |
| `branch:<name>` | branch vs HEAD | `git diff <name>...HEAD` |
| `range:<from>..<to>` | commit range | `git diff <from>...<to>` |
| `path:<paths>` | filtered by path (comma-separated) | `git diff HEAD -- <paths>` |
| bare `<sha>` | resolves to commit if exists | same as `commit:` |
| bare `<branch>` | resolves to branch if exists (else falls through) | same as `branch:` |
| bare `<path>` | resolves to path if exists (else falls through) | same as `path:` |
| anything else | guidance text (default scope still reviewed) | `git diff HEAD` |

Ambiguous bare-form inputs (e.g., a name that is both branch and dir) require explicit prefix.

---

## How it works

Plugin loaded[^0] → command.execute.before hook intercepts → … → report persisted.

[^0]: Plugin boot: `config` hook registers `/review-code` command and 11 subagents (5 reviewers + 6 coordinators) into `config.agent`; the subagent registration is consumed by OpenCode's agent picker. No command markdown files written.

```
┌─────────────────────────────────────────────────────────────┐
│ 1. User runs /review-code in OpenCode                       │
│                                                             │
│ 2. command.execute.before hook intercepts                   │
│    ↓                                                        │
│ 3. Git diff + changed files captured, secrets redacted      │
│    ↓                                                        │
│ 4. Slicing engine classifies & groups files into slices     │
│    ↓                                                        │
│ 5. Cost guardrail estimates tasks (spec×slice + quality×…)  │
│    ↓                                                        │
│ 6. Orchestrator dispatches reviewers per slice, in parallel │
│    ↓                                                        │
│ 7. Each reviewer writes a handoff file → .omre/handoffs/    │
│    ↓                                                        │
│ 8. Slice arbiter merges per-slice findings                  │
│    ↓                                                        │
│ 9. Global arbiter merges across slices + deduplicates       │
│    ↓                                                        │
│ 10. Report writer persists latest.md, latest.json, history/ │
└─────────────────────────────────────────────────────────────┘
```

Commands are registered at runtime through the OpenCode `config` hook — there are **no command markdown files** to maintain. `omre install` writes exactly one line to `opencode.json`; everything else is resolved in-memory on boot.

---

## Configuration

Configuration is optional. If you never write a config file, defaults apply. When you do, `omre` walks a hierarchy and deep-merges — project overrides global.

Load order (later wins):

1. `~/.config/opencode/oh-my-review-experts.jsonc`
2. `~/.config/opencode/oh-my-review-experts.json`
3. `.opencode/oh-my-review-experts.jsonc`
4. `.opencode/oh-my-review-experts.json`
5. `.omre/config.jsonc`
6. `.omre/config.json`

### Agent reference

All 11 agents must be referenced by exact name when configuring them in the `agents` field:

| Agent name | Role |
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

### Full schema

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
    // Add per-agent overrides here. Only specify agents you want to customize.
    // All agents fall back to the default model if not listed.
    // Example:
    // "omre-reviewer-spec": { "model": "anthropic/claude-opus-4-7", "variant": "max", "temperature": 0.7 }
  },
  "slicing": {
    "enabled": true,
    "maxSlices": 4,
    "skipDocsOnly": true,
    "skipTestOnlyHeavyReview": true,
    "forceWholeTargetAboveSlices": 12
  },
  "partialRerun": {
    "enabled": true,
    "maxRetriesPerTask": 1
  },
  "costGuardrail": {
    "enabled": true,
    "maxEstimatedTasks": 24,
    "compactModeThreshold": 20,
    "hardStopThreshold": 60
  },
  "arbitration": {
    "hierarchicalThreshold": 3
  },
  "report": {
    "enabled": true,
    "directory": ".omre/reports",
    "latestMarkdown": "latest.md",
    "latestJson": "latest.json",
    "timestamped": true
  },
  "handoff": {
    "enabled": true,
    "directory": ".omre/handoffs"
  },
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

### Model parameters

Each agent entry supports optional `top_p` (snake_case, not camelCase):

```jsonc
{
  "agents": {
    "omre-reviewer-spec": { "model": "minimax-cn/MiniMax-M2.7", "top_p": 0.9 }
  }
}
```

### Injection modes

`command.injection` controls how `/review-code` is wired up:

- `"both"` *(default)* — Commands registered via the `config` hook, execution intercepted via `command.execute.before`. Recommended.
- `"hook"` — Same as `"both"`.
- `"disabled"` — No command registration or interception. Useful for temporarily muting the plugin.
- `"tool"` — Disables slash commands; plugin tools (`omre_write_handoff`, `omre_write_report`, etc.) remain available via `hooks.tool`.

`scopeResolution: 'guidance-only'` reproduces pre-0.x behavior — args treated as opaque guidance text, scope is always `git diff HEAD`.

---

## CLI

```bash
omre init [--force]        # scaffold .opencode/oh-my-review-experts.jsonc
omre install --global      # enable plugin in ~/.config/opencode/opencode.json
omre install --project     # enable plugin in ./opencode.json
omre doctor [--clean-reports] [--strict]
                           # validate config + plugin wiring + contracts (used in CI)
                           # prints: config files, command/aliases, plugin registration,
                           #         subagent permissions, agent runtime models (tier/source),
                           #         contract self-check (prompt schemas + tool whitelists),
                           #         report layout (stray artifact detection)
                           # --clean-reports removes stray *-report.{md,json} artifacts
                           # --strict exits non-zero on any warning
                           # exit codes: 0 clean, 1 warning (with --strict), 2 contract failure
omre dry-run               # build the prompt locally, no model calls
```

`omre dry-run` is useful when debugging: it runs the full pipeline up to the point where a model would be invoked, then prints the assembled prompt and estimated plan.

---

## Reports and handoffs

**Reports** land in `.omre/reports/`:

```
.omre/reports/
├── latest.md                   # human-readable final report
├── latest.json                 # machine-readable (schema-validated)
└── history/
    └── 20260507-183012-123.md  # timestamped snapshots
```

Written with `writeFileAtomicOverwrite` (temp + rename) for `latest.*`, and `O_EXCL` for history files so concurrent runs never collide.

**Handoffs** land in `.omre/handoffs/{runId}/`:

```
.omre/handoffs/20260507-183012-123/
├── 20260507-183045-001-omre-reviewer-security-auth.md
├── 20260507-183047-002-omre-reviewer-performance-queue.md
└── …
```

Each handoff carries: agent name, scope, files inspected, findings with evidence, risk level, suggested fixes, confidence, and open questions. The orchestrator reads these files to build the final report; subagent chat output is treated as a status receipt only.

The plugin exposes seven tools for programmatic use:

- `omre_build_review_code_prompt` — assemble the review prompt bundle for the current changes
- `omre_dry_run` — render the plan without invoking any model
- `omre_config` — load the merged OMRE configuration for the current project
- `omre_write_handoff` — persist a reviewer's findings to `.omre/handoffs/{runId}/`
- `omre_write_report` — persist the final report to `.omre/reports/`
- `omre_validate_handoff` — validate a reviewer handoff (file first, chat-fence fallback)
- `omre_finalize_review` — assemble and persist the final review report from handoff files under `.omre/handoffs/{runId}/`

---

## Security

`omre` ships with defense-in-depth for a review tool that reads your diffs, writes files, and calls external models:

- **Path traversal** — `assertSafePath()` and `assertSafeCwd()` reject `..`, absolute paths, and non-UTF-8 byte sequences. Applied at every file-write boundary.
- **Prompt injection** — User arguments pass through `validateAndSanitizeArgs()` with a regex blacklist; long arguments are truncated at 4KB with a visible warning.
- **Scope-arg sanitization** — `validateAndSanitizeArgs()` rejects shell metacharacters in path-shaped args, `..` segments, and leading `--` to prevent option-injection.
- **Secret redaction** — `redactSecrets()` scrubs common credential patterns (API keys, tokens, private keys, connection strings) from diffs *before* they reach any model.
- **Command injection** — Command names are validated against `SAFE_COMMAND_PATTERN` and a forbidden list (`__proto__`, `constructor`, `prototype`).
- **Diff bounds** — Unified diff is capped at 180KB with a visible truncation marker.
- **Atomic writes** — No partial files, no mid-crash corruption.
- **Permission hook** — The `permission.ask` hook auto-denies write/edit access to `.omre/reports/` and `.omre/handoffs/` from external agents, preventing accidental corruption of review artifacts.

None of these are optional or togglable — they're always on.

---

## Requirements

- **OpenCode** 1.14 or newer
- **Node** 20 or newer
- A git repo (the plugin reads changed files via `git diff`)

---

## Packaging notes

`oh-my-review-experts` is distributed as **pure ESM**. There is no CommonJS wrapper, no `dist/index.cjs`, and `package.json` exposes only `exports.import` pointing at `dist/index.js`.

**Why?** OpenCode runs on Bun. When Bun imports a CJS module whose `module.exports` is a function, it surfaces the function's `name` and `length` as named ESM exports. OpenCode's `getLegacyPlugins()` iterates `Object.values(mod)` and rejects any non-function, non-`{server}` values with `"Plugin export is not a function"`. A CJS wrapper silently breaks plugin loading. ESM only, always.

`@opencode-ai/plugin` is a **devDependency** imported via `import type` — zero runtime footprint. The shipped bundle is ~1KB of code plus prompt strings.

---

## Development

```bash
npm install
npm run dev              # tsx src/cli.ts
npm run typecheck        # tsc --noEmit  (strict, no `as any`)
npm run test             # vitest run
npm run generate-schema  # regenerate JSON schema from Zod types
npm run build            # prebuild → tsup → postbuild (ESM + .d.ts + sourcemaps)
npm run doctor:strict    # same as `doctor --strict`
node dist/cli.js doctor
```

Local packaging:

```bash
npm run pack:local
```

Publish (dry-run first):

```bash
npm run publish:dry-run
npm run publish:both
```

CI (Node 22, Ubuntu) runs: `npm ci && typecheck && test && build && doctor:strict`.

---

## License

MIT © zapsaang

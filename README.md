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

**Security built in, not bolted on.** Path traversal guards on every file write. Prompt-injection regex filters on user arguments. Secret redaction on diffs before they reach any model. Command-name validation that rejects `__proto__` and friends.

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

Preview the generated prompt without calling any model:

```text
/review-code --echo-prompt
```

---

## How it works

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

Full schema:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/zapsaang/oh-my-review-experts/main/schemas/oh-my-review-experts.schema.json",
  "enabled": true,
  "command": {
    "name": "review-code",
    "aliases": ["rc"],
    "injection": "both"
  },
  "models": {
    "orchestrator":   "minimax-cn/MiniMax-M2.7",
    "spec":           "minimax-cn/MiniMax-M2.7",
    "quality":        "minimax-cn/MiniMax-M2.7",
    "security":       "minimax-cn/MiniMax-M2.7",
    "performance":    "minimax-cn/MiniMax-M2.7",
    "concurrency":    "minimax-cn/MiniMax-M2.7",
    "slicePlanner":   "minimax-cn/MiniMax-M2.7",
    "validator":      "minimax-cn/MiniMax-M2.7",
    "sliceArbiter":   "minimax-cn/MiniMax-M2.7",
    "globalArbiter":  "minimax-cn/MiniMax-M2.7",
    "reportWriter":   "minimax-cn/MiniMax-M2.7"
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

### Injection modes

`command.injection` controls how `/review-code` is wired up:

- `"both"` *(default)* — Commands registered via the `config` hook, execution intercepted via `command.execute.before`. Recommended.
- `"hook"` — Same as `"both"`.
- `"disabled"` — No command registration or interception. Useful for temporarily muting the plugin.
- `"tool"` — Reserved. Disables slash commands; plugin tools are not yet exposed in `hooks.tool` due to a Zod version conflict upstream. Effectively disables all entry points today.

---

## CLI

Everything from the command line:

```bash
omre init                  # scaffold .opencode/oh-my-review-experts.jsonc
omre install --global      # enable plugin in ~/.config/opencode/opencode.json
omre install --project     # enable plugin in ./opencode.json
omre doctor                # validate config + plugin wiring (used in CI)
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
├── 20260507-183045-001-reviewer-security-auth.md
├── 20260507-183047-002-reviewer-performance-queue.md
└── …
```

Each handoff carries: agent name, scope, files inspected, findings with evidence, risk level, suggested fixes, confidence, and open questions. The orchestrator reads these files to build the final report; subagent chat output is treated as a status receipt only.

The plugin exposes two tools for programmatic use:

- `omre_write_handoff` — persist a reviewer's findings
- `omre_write_report` — persist the final report

---

## Security

`omre` ships with defense-in-depth for a review tool that reads your diffs, writes files, and calls external models:

- **Path traversal** — `assertSafePath()` and `assertSafeCwd()` reject `..`, absolute paths, and non-UTF-8 byte sequences. Applied at every file-write boundary.
- **Prompt injection** — User arguments pass through `validateAndSanitizeArgs()` with a regex blacklist; long arguments are truncated at 4KB with a visible warning.
- **Secret redaction** — `redactSecrets()` scrubs common credential patterns (API keys, tokens, private keys, connection strings) from diffs *before* they reach any model.
- **Command injection** — Command names are validated against `SAFE_COMMAND_PATTERN` and a forbidden list (`__proto__`, `constructor`, `prototype`).
- **Diff bounds** — Unified diff is capped at 180KB with a visible truncation marker.
- **Atomic writes** — No partial files, no mid-crash corruption.

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
npm run dev         # tsx src/cli.ts
npm run typecheck   # tsc --noEmit  (strict, no `as any`)
npm run test        # vitest run
npm run build       # tsup → dist/ (ESM + .d.ts + sourcemaps)
node dist/cli.js doctor
```

Local packaging:

```bash
npm run pack:local
```

Publish:

```bash
npm run publish:both
```

CI (Node 22, Ubuntu) runs: `npm ci && typecheck && test && build && doctor`.

---

## License

MIT © zapsaang

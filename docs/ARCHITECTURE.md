# Architecture

v2 is runtime-first. It does not install `.opencode/agents/*.md` or `.opencode/commands/*.md` into every project.

Instead, the npm package includes:

- built-in reviewer prompts
- review-code workflow prompt builder
- OMO-style slash command injection compatibility hooks
- plugin tools for prompt generation, dry-run, config reading, and report writing
- standalone config loader for `.opencode/oh-my-review-experts.jsonc`

## Command injection strategy

OpenCode plugin APIs have changed across versions, so this package exposes three layers:

1. `commands.omre` for runtimes that support command registration from plugins.
2. message-before hooks that rewrite `/review-code ...` into the built-in workflow prompt.
3. `omre_build_review_code_prompt` tool as fallback.

This mirrors the OMO idea: keep workflow in runtime, expose a small config file to users.

## Config locations

Loaded in order:

1. `~/.config/opencode/oh-my-review-experts.jsonc`
2. `~/.config/opencode/oh-my-review-experts.json`
3. `.opencode/oh-my-review-experts.jsonc`
4. `.opencode/oh-my-review-experts.json`
5. `.omre/config.jsonc`
6. `.omre/config.json`

Project config overrides global config.

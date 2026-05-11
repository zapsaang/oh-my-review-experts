import { buildReviewCodePrompt, persistReport, renderLocalDryRun } from "../workflow/run-review-code.js";
import { loadConfig } from "../config/load-config.js";
import { validateAndSanitizeArgs, MAX_ARGS_LENGTH } from "../hooks/command-injection.js";
import { writeHandoff, type HandoffPayload } from "./handoff.js";
import { validateReviewerHandoff, type ExpectedValues } from "../workflow/validate-result.js";

/**
 * Plugin tools exported for CLI and programmatic use.
 *
 * Note: These tools are NOT registered in `hooks.tool` in this release.
 * The `@opencode-ai/plugin` package depends on Zod 4, while this project
 * uses Zod 3. To avoid runtime version conflicts, tools are kept as plain
 * async functions and exposed via named exports only. They remain callable
 * through the CLI (`omre dry-run`) or direct module imports.
 */
export const tools = {
  omre_build_review_code_prompt: async (input: { args?: string; cwd?: string } = {}): Promise<{ prompt: string; estimatedTasks: number; files: string[] }> => {
    let args = input.args ?? "";
    if (args.length > MAX_ARGS_LENGTH) {
      args = args.slice(0, MAX_ARGS_LENGTH) + "\n[WARNING: User guidance truncated due to excessive length]";
    }
    args = validateAndSanitizeArgs(args);
    const bundle = buildReviewCodePrompt({ ...input, args });
    return { prompt: bundle.prompt, estimatedTasks: bundle.estimatedTasks, files: bundle.files };
  },
  omre_write_report: async (input: { markdown: string; json: unknown; cwd?: string }): Promise<{ written: string[] }> => {
    const written = persistReport(input.markdown, input.json, input.cwd ?? process.cwd());
    return { written };
  },
  omre_write_handoff: async (input: { payload: HandoffPayload; cwd?: string; runId?: string }): Promise<{ filePath: string }> => {
    const config = loadConfig(input.cwd ?? process.cwd());
    const filePath = writeHandoff(config, input.payload, input.cwd ?? process.cwd(), input.runId);
    return { filePath };
  },
  omre_dry_run: async (input: { args?: string; cwd?: string } = {}): Promise<{ markdown: string }> => {
    return { markdown: renderLocalDryRun(input) };
  },
  omre_config: async (input: { cwd?: string } = {}): Promise<ReturnType<typeof loadConfig>> => {
    return loadConfig(input.cwd ?? process.cwd());
  },
  omre_validate_handoff: async (input: { filePath: string; expected?: ExpectedValues }): Promise<ReturnType<typeof validateReviewerHandoff>> => {
    return validateReviewerHandoff(input.filePath, input.expected);
  },
};

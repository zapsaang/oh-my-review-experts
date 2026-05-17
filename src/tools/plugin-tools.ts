import type { ToolContext } from "@opencode-ai/plugin";
import path from "node:path";
import { z } from "zod";
import { UnifiedFindingSchema } from "../agents/schemas.js";
import { buildReviewCodePrompt, persistReport, renderLocalDryRun } from "../workflow/run-review-code.js";
import { loadConfig } from "../config/load-config.js";
import { validateAndSanitizeArgs, MAX_ARGS_LENGTH } from "../hooks/command-injection.js";
import { writeHandoff, type HandoffPayload } from "./handoff.js";
import { validateReviewerHandoff, validateHandoffFromChat } from "../workflow/validate-result.js";
import { assertSafePath } from "./fs-utils.js";

/**
 * Maximum chatContent size accepted by omre_validate_handoff. Chat replies
 * over this size are truncated before parsing to bound memory and parser
 * cost. Truncation is "smart": we locate the first ```json fence and keep
 * up to MAX_CHAT_CONTENT_LENGTH starting at the fence, so a valid handoff
 * sitting beyond a large prose preamble is preserved. The handoff JSON
 * header is small (≤ a few KB), so 50KB is generous headroom for any
 * realistic header plus surrounding code.
 */
export const MAX_CHAT_CONTENT_LENGTH = 50_000;

function truncateChatContentForFence(content: string): string {
  if (content.length <= MAX_CHAT_CONTENT_LENGTH) return content;
  const fenceStart = content.indexOf("```json");
  const start = fenceStart >= 0 ? fenceStart : 0;
  const window = content.slice(start, start + MAX_CHAT_CONTENT_LENGTH);
  return window + "\n[TRUNCATED]";
}

interface ToolDefinition<Args extends z.ZodRawShape> {
  description: string;
  args: Args;
  execute(
    args: z.infer<z.ZodObject<Args>>,
    context: ToolContext
  ): Promise<string | { output: string; metadata?: Record<string, unknown> }>;
}

function tool<Args extends z.ZodRawShape>(input: ToolDefinition<Args>): ToolDefinition<Args> {
  return input;
}

function resolveCwd(
  inputCwd: string | undefined,
  contextDir: string | undefined
): { cwd: string; trusted: boolean } {
  if (inputCwd !== undefined && inputCwd !== "") {
    return { cwd: inputCwd, trusted: false };
  }
  return { cwd: contextDir ?? process.cwd(), trusted: true };
}

/**
 * @deprecated Use `UnifiedFindingSchema` from `src/agents/schemas.js` instead.
 * This re-export exists for backward compatibility with existing tests/consumers.
 */
export const HandoffFindingSchema = UnifiedFindingSchema;

export const tools = {
  omre_build_review_code_prompt: tool({
    description: "Build the review code prompt bundle for the current changes",
    args: {
      args: z.string().optional(),
      cwd: z.string().optional(),
    },
    async execute(input, context) {
      let args = input.args ?? "";
      if (args.length > MAX_ARGS_LENGTH) {
        args = args.slice(0, MAX_ARGS_LENGTH) + "\n[WARNING: User guidance truncated due to excessive length]";
      }
      args = validateAndSanitizeArgs(args);
      const { cwd, trusted } = resolveCwd(input.cwd, context.directory);
      const bundle = buildReviewCodePrompt({ ...input, args, cwd }, trusted);
      return JSON.stringify({
        prompt: bundle.prompt,
        estimatedTasks: bundle.estimatedTasks,
        files: bundle.files
      });
    },
  }),

  omre_write_report: tool({
    description: "Persist the review report to the configured report directory (.omre/reports by default)",
    args: {
      markdown: z.string(),
      json: z.record(z.string(), z.unknown()).optional(),
      cwd: z.string().optional(),
      degradedSlices: z.array(z.object({
        slice_id: z.string(),
        missing_dimensions: z.array(z.string()),
      })).optional(),
      missingDimensionsGlobal: z.array(z.string()).optional(),
    },
    async execute(input, context) {
      const { cwd, trusted } = resolveCwd(input.cwd, context.directory);
      const written = persistReport(
        input.markdown,
        input.json ?? {},
        cwd,
        input.degradedSlices,
        input.missingDimensionsGlobal,
        trusted
      );
      return JSON.stringify({ written });
    },
  }),

  omre_write_handoff: tool({
    description:
      "Write a reviewer handoff file to the configured handoff directory. Returns { ok: true, filePath, taskId } on success, { ok: false, errors: string[] } on failure (no throws).",
    args: {
      payload: z.object({
        schema_version: z.string().optional(),
        task_id: z
          .string()
          .refine((v) => v.length > 0, "task_id, when provided, must be non-empty")
          .optional(),
        agent: z.string(),
        dimension: z.string(),
        scope: z.string().optional(),
        status: z.enum(["completed", "blocked"]),
        target: z.object({ kind: z.string(), value: z.string() }).optional(),
        slice_id: z.string().optional(),
        files_inspected: z.array(z.string()).optional(),
        findings: z.array(HandoffFindingSchema),
        suggested_fixes: z.array(z.string()).optional(),
        open_questions: z.array(z.string()).optional(),
        notes_for_primary: z.string().optional(),
      }),
      cwd: z.string().optional(),
      runId: z.string().optional(),
    },
    async execute(input, context) {
      try {
        const { cwd, trusted } = resolveCwd(input.cwd, context.directory);
        const config = loadConfig(cwd, trusted);
        const p = input.payload;
        const payload: HandoffPayload = {
          schemaVersion: p.schema_version,
          taskId: p.task_id,
          agent: p.agent,
          dimension: p.dimension,
          scope: p.scope,
          status: p.status,
          target: p.target,
          sliceId: p.slice_id,
          filesInspected: p.files_inspected,
          findings: p.findings,
          suggestedFixes: p.suggested_fixes,
          openQuestions: p.open_questions,
          notesForPrimary: p.notes_for_primary,
        };
        const { filePath, taskId } = writeHandoff(config, payload, cwd, input.runId);
        return JSON.stringify({ ok: true, filePath, taskId });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return JSON.stringify({ ok: false, errors: [message] });
      }
    },
  }),

  omre_dry_run: tool({
    description: "Run a dry-run review to estimate tasks and list changed files",
    args: {
      args: z.string().optional(),
      cwd: z.string().optional(),
    },
    async execute(input, context) {
      const { cwd, trusted } = resolveCwd(input.cwd, context.directory);
      const markdown = renderLocalDryRun({ ...input, cwd }, trusted);
      return markdown;
    },
  }),

  omre_config: tool({
    description: "Load and return the OMRE configuration for the current project",
    args: {
      cwd: z.string().optional(),
    },
    async execute(input, context) {
      const { cwd, trusted } = resolveCwd(input.cwd, context.directory);
      const config = loadConfig(cwd, trusted);
      return JSON.stringify(config);
    },
  }),

  omre_validate_handoff: tool({
    description:
      "Validate a reviewer handoff for structural correctness. Tries the file at filePath first; if missing or invalid, falls back to parsing chatContent. Returns { isValid, source: 'file'|'chat'|'none', ... }.",
    args: {
      filePath: z.string().optional(),
      chatContent: z.string().optional(),
      cwd: z.string().optional(),
      expected: z.object({
        dimension: z.string().optional(),
        target: z.object({ kind: z.string(), value: z.string() }).optional(),
        sliceId: z.string().optional(),
      }).optional(),
    },
    async execute(input, context) {
      const { cwd, trusted } = resolveCwd(input.cwd, context.directory);
      const resolvedCwd = path.resolve(cwd);

      if (!trusted) {
        const trustedBase = path.resolve(context.directory ?? process.cwd());
        assertSafePath(resolvedCwd, trustedBase, "omre_validate_handoff cwd");
      }

      if (!input.filePath && !input.chatContent) {
        return JSON.stringify({
          isValid: false,
          failureReason: "missing-output",
          retryRecommended: true,
          source: "none",
        });
      }

      let fileOutcome: ReturnType<typeof validateReviewerHandoff> | undefined;
      if (input.filePath) {
        const resolvedPath = input.filePath.startsWith("/")
          ? input.filePath
          : path.resolve(resolvedCwd, input.filePath);
        assertSafePath(resolvedPath, resolvedCwd, "omre_validate_handoff");
        fileOutcome = validateReviewerHandoff(resolvedPath, input.expected);
        if (fileOutcome.isValid) {
          return JSON.stringify({ ...fileOutcome, source: "file" });
        }
      }

      if (input.chatContent) {
        const chat = truncateChatContentForFence(input.chatContent);
        const chatOutcome = validateHandoffFromChat(chat, input.expected);
        if (chatOutcome.isValid) {
          return JSON.stringify({ ...chatOutcome, source: "chat" });
        }
        return JSON.stringify({
          isValid: false,
          failureReason: "missing-output",
          retryRecommended: true,
          source: "none",
        });
      }

      return JSON.stringify({ ...fileOutcome!, source: "file" });
    },
  }),
};

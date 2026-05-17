import type { Plugin, Hooks, Config, PluginModule } from "@opencode-ai/plugin"
import { injectReviewCodePrompt } from "./hooks/command-injection.js"
import { tools } from "./tools/plugin-tools.js"
import { loadConfig } from "./config/load-config.js"
import { registerAgents } from "./agents/registry.js"
import { VERSION } from "./version.js"

export { buildReviewCodePrompt, persistReport, renderLocalDryRun } from "./workflow/run-review-code.js"
export { loadConfig } from "./config/load-config.js"
export { writeHandoff, readHandoffs, type HandoffPayload, type HandoffFinding } from "./tools/handoff.js"
export { tools } from "./tools/plugin-tools.js"
export { validateReviewerHandoff, type ValidationOutcome, type ReviewerHandoff, type ExpectedValues } from "./workflow/validate-result.js"


function makeTextPart(sessionID: string, text: string) {
  return {
    id: `prt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    sessionID,
    messageID: "",
    type: "text" as const,
    text,
    synthetic: true,
  }
}

const INJECTION_MODES_WITH_HOOK = new Set(["hook", "both"])

function registerCommands(config: Config, cwd: string): string[] {
  const omreConfig = loadConfig(cwd, true)
  if (!omreConfig.enabled || !omreConfig.command.enabled) {
    return []
  }

  if (!INJECTION_MODES_WITH_HOOK.has(omreConfig.command.injection)) {
    return []
  }

  const names = [omreConfig.command.name, ...omreConfig.command.aliases].filter(Boolean)
  config.command = config.command ?? {}
  const registered: string[] = []

  for (const name of names) {
    if (config.command[name]) continue
    config.command[name] = {
      template: "Triggering oh-my-review-experts workflow...",
      description:
        name === omreConfig.command.name
          ? "Run Oh My Review Experts code review"
          : `Alias for /${omreConfig.command.name}`,
    }
    registered.push(name)
  }
  return registered
}

const OhMyReviewExperts: Plugin = async (input) => {
  const registeredCommands = new Set<string>()
  const client = input.client

  const log = async (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
    try {
      await client.app.log({
        body: {
          service: "oh-my-review-experts",
          level,
          message,
          extra: {
            version: VERSION,
            directory: input.directory,
            worktree: input.worktree,
            ...extra,
          },
        },
        query: {
          directory: input.directory,
        },
      })
    } catch {
      // Fallback: if logging fails, silently ignore to avoid disrupting plugin loading
    }
  }

  const hooks: Hooks = {
    config: async (config) => {
      try {
        const names = registerCommands(config, input.directory)
        for (const name of names) {
          registeredCommands.add(name)
        }
        if (names.length > 0) {
          await log("info", "Commands registered via config hook", {
            commands: names,
            hookName: "config",
          })
        }

        const omreConfig = loadConfig(input.directory, true)
        const { registered: agentNames, skipped: agentSkipped } = registerAgents(config, omreConfig)
        if (agentNames.length > 0) {
          await log("info", "Subagents registered via config hook", {
            agents: agentNames,
            hookName: "config",
          })
        }
        for (const name of agentSkipped) {
          await log("info", "Subagent registration skipped (user override present)", {
            agent: name,
            hookName: "config",
          })
        }
      } catch (err) {
        await log("error", "Failed to register commands or agents", {
          error: err instanceof Error ? err.message : String(err),
          hookName: "config",
        })
      }
    },

    "command.execute.before": async (ctx, output) => {
      if (!registeredCommands.has(ctx.command)) return
      const prompt = injectReviewCodePrompt({
        command: ctx.command,
        args: ctx.arguments,
        cwd: input.directory,
        trusted: true,
      })
      if (!prompt) return

      const textPart = makeTextPart(ctx.sessionID, prompt)
      const idx = output.parts.findIndex(
        (part: any) => part.type === "text" && (part.text ?? "").trim().startsWith("/")
      )

      if (idx >= 0) {
        output.parts[idx] = textPart
      } else {
        output.parts.push(textPart)
      }
    },

    tool: tools,
  }
  return hooks
}

const pluginModule: PluginModule = {
  id: "oh-my-review-experts",
  server: OhMyReviewExperts,
}

export default pluginModule

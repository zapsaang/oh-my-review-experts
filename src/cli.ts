#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Command } from "commander"
import pc from "picocolors"
import { modify, parse as parseJsonc, applyEdits } from "jsonc-parser"
import type { Config } from "@opencode-ai/plugin"
import { defaultConfigJsonc, findConfigFiles, loadConfig } from "./config/load-config.js"
import { renderLocalDryRun } from "./workflow/run-review-code.js"
import { checkAgentRegistration, checkOpencodeConfig } from "./tools/doctor.js"
import { registerAgents } from "./agents/registry.js"
import { VERSION } from "./version.js"

const PLUGIN_NAME = "oh-my-review-experts"

function ensureDir(p: string) {
  try {
    fs.mkdirSync(p, { recursive: true })
  } catch (err) {
    throw new Error(`Failed to create directory ${p}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function readFileSafe(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined
    }
    throw err
  }
}

function writeFileViaTempRename(file: string, content: string) {
  ensureDir(path.dirname(file))
  const tmpFile = `${file}.tmp.${Date.now()}`
  try {
    fs.writeFileSync(tmpFile, content, "utf8")
    fs.renameSync(tmpFile, file)
  } catch (err) {
    try { fs.unlinkSync(tmpFile) } catch { }
    throw new Error(`Failed to write ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function writeIfMissing(file: string, content: string) {
  ensureDir(path.dirname(file))
  try {
    fs.writeFileSync(file, content, { flag: "wx", encoding: "utf8" })
    return true
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
      return false
    }
    throw err
  }
}

function ensurePluginInOpencodeConfig(configFile: string, maxRetries = 3): boolean {
  ensureDir(path.dirname(configFile))
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const text = readFileSafe(configFile) ?? "{}\n"
    const parsed = parseJsonc(text)
    if (parsed === undefined || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid JSONC in ${configFile}: expected object`)
    }
    const root = parsed as Record<string, unknown>
    const hasPluginArray = Array.isArray(root.plugin)
    const hasPluginsArray = Array.isArray(root.plugins)
    const key = hasPluginArray ? "plugin" : hasPluginsArray ? "plugins" : "plugin"
    const current: string[] = (hasPluginArray ? root.plugin : hasPluginsArray ? root.plugins : []) as string[] ?? []
    if (current.includes(PLUGIN_NAME)) return false
    const next = [...current, PLUGIN_NAME]
    const edits = modify(text, [key], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
    const newContent = applyEdits(text, edits)
    const tmpFile = `${configFile}.tmp.${Date.now()}.${attempt}`
    try {
      fs.writeFileSync(tmpFile, newContent, "utf8")
      fs.renameSync(tmpFile, configFile)
      return true
    } catch (err) {
      try { fs.unlinkSync(tmpFile) } catch { }
      if (attempt < maxRetries - 1) continue
      throw new Error(`Failed to update ${configFile}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return false
}

function ensureCommandInOpencodeConfig(configFile: string, maxRetries = 3): { added: string[]; skipped: string[] } {
  ensureDir(path.dirname(configFile))
  const commandsToRegister: Record<string, { template: string; description: string }> = {
    "review-code": { template: "Triggering oh-my-review-experts workflow...", description: "Run Oh My Review Experts code review" },
    "rc": { template: "Triggering oh-my-review-experts workflow...", description: "Alias for /review-code" },
  }
  const result = { added: [] as string[], skipped: [] as string[] }
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const text = readFileSafe(configFile) ?? "{}\n"
    const parsed = parseJsonc(text)
    if (parsed === undefined || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid JSONC in ${configFile}: expected object`)
    }
    const root = parsed as Record<string, unknown>
    const existingCommands = (root.command as Record<string, unknown>) ?? {}
    let changed = false
    let newText = text
    for (const [cmd, def] of Object.entries(commandsToRegister)) {
      if (existingCommands[cmd]) {
        result.skipped.push(cmd)
        continue
      }
      const edits = modify(newText, ["command", cmd], def, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
      newText = applyEdits(newText, edits)
      result.added.push(cmd)
      changed = true
    }
    if (!changed) return result
    const tmpFile = `${configFile}.tmp.${Date.now()}.${attempt}`
    try {
      fs.writeFileSync(tmpFile, newText, "utf8")
      fs.renameSync(tmpFile, configFile)
      return result
    } catch (err) {
      try { fs.unlinkSync(tmpFile) } catch { }
      if (attempt < maxRetries - 1) continue
      throw new Error(`Failed to update ${configFile}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return result
}

function getOpencodeConfigPath(global: boolean): string {
  return global
    ? path.join(os.homedir(), ".config", "opencode", "opencode.json")
    : path.resolve(process.cwd(), "opencode.json")
}

function getPluginConfigPath(global: boolean): string {
  return global
    ? path.join(os.homedir(), ".config", "opencode", "oh-my-review-experts.jsonc")
    : path.resolve(process.cwd(), ".opencode", "oh-my-review-experts.jsonc")
}

const program = new Command()
program
  .name("omre")
  .description("Oh My Review Experts - runtime-first OpenCode review-code plugin")
  .version(VERSION)

program.command("init")
  .description("Create project-level oh-my-review-experts config only")
  .option("--force", "overwrite existing config", false)
  .action((opts: { force?: boolean }) => {
    try {
      const file = path.resolve(process.cwd(), ".opencode", "oh-my-review-experts.jsonc")
      ensureDir(path.dirname(file))
      if (fs.existsSync(file) && !opts.force) {
        console.log(pc.yellow(`exists: ${file}`))
        return
      }
      writeFileViaTempRename(file, defaultConfigJsonc())
      console.log(pc.green(`created: ${file}`))
      console.log(`Enable plugin in opencode.json: { "plugin": ["${PLUGIN_NAME}"] }`)
    } catch (err) {
      console.error(pc.red(`init failed: ${err instanceof Error ? err.message : String(err)}`))
      process.exit(1)
    }
  })

program.command("install")
  .description("Enable the plugin in OpenCode config; does not install markdown agents")
  .option("--global", "write ~/.config/opencode/opencode.json", false)
  .option("--project", "write ./opencode.json", false)
  .action((opts: { global?: boolean; project?: boolean }) => {
    try {
      const target = getOpencodeConfigPath(!!opts.global)
      const pluginChanged = ensurePluginInOpencodeConfig(target)
      console.log(pluginChanged ? pc.green(`enabled plugin in ${target}`) : pc.gray(`already enabled in ${target}`))
      const cfg = getPluginConfigPath(!!opts.global)
      const created = writeIfMissing(cfg, defaultConfigJsonc())
      if (created) {
        console.log(pc.green(`config ready: ${cfg}`))
      } else {
        console.log(pc.gray(`config exists: ${cfg}`))
      }
    } catch (err) {
      console.error(pc.red(`install failed: ${err instanceof Error ? err.message : String(err)}`))
      process.exit(1)
    }
  })

program.command("doctor")
  .description("Check plugin configuration")
  .action(() => {
    try {
      console.log(pc.bold("Oh My Review Experts doctor"))
      const files = findConfigFiles(process.cwd())
      console.log("Config files:")
      for (const f of files) console.log(`- ${f}`)
      if (!files.length) console.log(pc.yellow("- none found; defaults will be used"))
      const config = loadConfig(process.cwd())
      console.log("Command:", `/${config.command.name}`, "aliases:", config.command.aliases.join(", "))
      console.log("Report dir:", config.report.directory)
      console.log("Max estimated tasks:", config.costGuardrail.maxEstimatedTasks)

      const projectConfig = getOpencodeConfigPath(false)
      const globalConfig = getOpencodeConfigPath(true)
      const projectStatus = checkOpencodeConfig(projectConfig)
      const globalStatus = checkOpencodeConfig(globalConfig)

      console.log("\nPlugin registration:")
      if (projectStatus.pluginRegistered) {
        console.log(pc.green(`  registered in ${projectConfig}`))
      } else if (globalStatus.pluginRegistered) {
        console.log(pc.green(`  registered in ${globalConfig}`))
      } else {
        console.log(pc.yellow(`  not registered (run: omre install --project)`))
      }

      console.log("\nConfig hook:")
      const activeConfig = loadConfig(process.cwd())
      if (!activeConfig.enabled) {
        console.log(pc.yellow("  plugin disabled"))
      } else if (!activeConfig.command.enabled) {
        console.log(pc.yellow("  commands disabled"))
      } else if (activeConfig.command.injection === "disabled") {
        console.log(pc.yellow("  injection disabled"))
      } else if (activeConfig.command.injection === "tool") {
        console.log(pc.yellow("  tool mode (commands not registered via config hook)"))
      } else {
        console.log(pc.green("  commands registered at runtime via config hook"))
      }

      console.log("\nSubagent permissions:")
      const projectWarnings = projectStatus.permissionWarnings
      const globalWarnings = globalStatus.permissionWarnings

      if (!projectStatus.exists && !globalStatus.exists) {
        console.log(pc.yellow("  no opencode.json found; cannot verify omre_* permissions"))
      } else {
        if (projectStatus.exists) {
          if (projectWarnings.length === 0) {
            console.log(pc.green(`  ${projectConfig}: omre_* permissions OK (opencode.json only; agent frontmatter not inspected)`))
          } else {
            for (const w of projectWarnings) console.log(pc.yellow(`  ${projectConfig}: ${w}`))
          }
        }
        if (globalStatus.exists) {
          if (globalWarnings.length === 0) {
            console.log(pc.green(`  ${globalConfig}: omre_* permissions OK (opencode.json only; agent frontmatter not inspected)`))
          } else {
            for (const w of globalWarnings) console.log(pc.yellow(`  ${globalConfig}: ${w}`))
          }
        }
      }

      console.log("\nSubagent registration:")
      const probeConfig: Config = {}
      registerAgents(probeConfig, activeConfig)
      const agentStatus = checkAgentRegistration(probeConfig)
      const agentLine = `agents: ${agentStatus.registered}/${agentStatus.expected} registered`
      if (agentStatus.registered === agentStatus.expected) {
        console.log(pc.green(`  ${agentLine}`))
      } else {
        console.log(pc.yellow(`  ${agentLine}`))
        if (agentStatus.missing.length > 0) {
          console.log(pc.yellow(`  missing: ${agentStatus.missing.join(", ")}`))
        }
      }
    } catch (err) {
      console.error(pc.red(`doctor failed: ${err instanceof Error ? err.message : String(err)}`))
      process.exit(1)
    }
  })

program.command("dry-run")
  .description("Show estimated review-code plan without calling models")
  .argument("[args...]", "extra review-code guidance")
  .action((args: string[]) => {
    try {
      console.log(renderLocalDryRun({ args: args.join(" ") }))
    } catch (err) {
      console.error(pc.red(`dry-run failed: ${err instanceof Error ? err.message : String(err)}`))
      process.exit(1)
    }
  })

program.parse(process.argv)

#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Command } from "commander"
import pc from "picocolors"
import Table from "cli-table3"
import { modify, parse as parseJsonc, applyEdits } from "jsonc-parser"
import type { Config } from "@opencode-ai/plugin"
import { defaultConfigJsonc, findConfigFiles, loadConfigWithOverrides } from "./config/load-config.js"
import {
  resolveProviderFromOpenCodeConfig,
  resolveModelsWithInference,
  AGENT_TIER_MAP,
} from "./config/provider-presets.js"
import type { ModelKey } from "./agents/registry.js"
import { ALL_AGENTS, registerAgents } from "./agents/registry.js"
import { renderLocalDryRun } from "./workflow/run-review-code.js"

import {
  checkAgentRegistration,
  checkAgentToolWhitelist,
  checkOpencodeConfig,
  checkPromptExampleSchemaIdentity,
  checkReportLayout,
} from "./tools/doctor.js"
import { makeTempPath } from "./tools/fs-utils.js"
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
  const tmpFile = makeTempPath(file)
  try {
    fs.writeFileSync(tmpFile, content, { flag: "wx", encoding: "utf8" })
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

function getOpencodeConfigPath(global: boolean, cwd = process.cwd()): string {
  return global
    ? path.join(os.homedir(), ".config", "opencode", "opencode.json")
    : path.resolve(cwd, "opencode.json")
}

function getPluginConfigPath(global: boolean): string {
  return global
    ? path.join(os.homedir(), ".config", "opencode", "oh-my-review-experts.jsonc")
    : path.resolve(process.cwd(), ".opencode", "oh-my-review-experts.jsonc")
}

export interface DoctorContractChecks {
  checkPromptExampleSchemaIdentity: () => readonly string[]
  checkAgentToolWhitelist: () => readonly string[]
}

export interface DoctorOutput {
  log: (...values: unknown[]) => void
  error: (...values: unknown[]) => void
}

export interface RunDoctorOptions {
  cwd?: string
  output?: DoctorOutput
  contractChecks?: DoctorContractChecks
  cleanReports?: boolean
  strict?: boolean
}

const CONTRACT_CHECK_LABEL_WIDTH = 40

const defaultContractChecks: DoctorContractChecks = {
  checkPromptExampleSchemaIdentity,
  checkAgentToolWhitelist,
}

function formatContractStatus(label: string, warnings: readonly string[]): string {
  const status = warnings.length === 0 ? pc.green("✓") : pc.red("✗")
  return `${label.padEnd(CONTRACT_CHECK_LABEL_WIDTH)}${status}`
}

export function runDoctor(options: RunDoctorOptions = {}): void {
  const cwd = options.cwd ?? process.cwd()
  const output = options.output ?? console
  const contractChecks = options.contractChecks ?? defaultContractChecks

  output.log(pc.bold("Oh My Review Experts doctor"))
  const files = findConfigFiles(cwd)
  output.log("Config files:")
  for (const f of files) output.log(`- ${f}`)
  if (!files.length) output.log(pc.yellow("- none found; defaults will be used"))
  const { config, explicitModelOverrides } = loadConfigWithOverrides(cwd)
  output.log("Command:", `/${config.command.name}`, "aliases:", config.command.aliases.join(", "))
  output.log("Report dir:", config.report.directory)
  output.log("Max estimated tasks:", config.costGuardrail.maxEstimatedTasks)

  const projectConfig = getOpencodeConfigPath(false, cwd)
  const globalConfig = getOpencodeConfigPath(true)
  const projectStatus = checkOpencodeConfig(projectConfig)
  const globalStatus = checkOpencodeConfig(globalConfig)

  output.log("\nPlugin registration:")
  if (projectStatus.pluginRegistered) {
    output.log(pc.green(`  registered in ${projectConfig}`))
  } else if (globalStatus.pluginRegistered) {
    output.log(pc.green(`  registered in ${globalConfig}`))
  } else {
    output.log(pc.yellow(`  not registered (run: omre install --project)`))
  }

  output.log("\nConfig hook:")
  if (!config.enabled) {
    output.log(pc.yellow("  plugin disabled"))
  } else if (!config.command.enabled) {
    output.log(pc.yellow("  commands disabled"))
  } else if (config.command.injection === "disabled") {
    output.log(pc.yellow("  injection disabled"))
  } else if (config.command.injection === "tool") {
    output.log(pc.yellow("  tool mode (commands not registered via config hook)"))
  } else {
    output.log(pc.green("  commands registered at runtime via config hook"))
  }

  output.log("\nSubagent permissions:")
  const projectWarnings = projectStatus.permissionWarnings
  const globalWarnings = globalStatus.permissionWarnings

  if (!projectStatus.exists && !globalStatus.exists) {
    output.log(pc.yellow("  no opencode.json found; cannot verify omre_* permissions"))
  } else {
    if (projectStatus.exists) {
      if (projectWarnings.length === 0) {
        output.log(pc.green(`  ${projectConfig}: omre_* permissions OK (opencode.json only; agent frontmatter not inspected)`))
      } else {
        for (const w of projectWarnings) output.log(pc.yellow(`  ${projectConfig}: ${w}`))
      }
    }
    if (globalStatus.exists) {
      if (globalWarnings.length === 0) {
        output.log(pc.green(`  ${globalConfig}: omre_* permissions OK (opencode.json only; agent frontmatter not inspected)`))
      } else {
        for (const w of globalWarnings) output.log(pc.yellow(`  ${globalConfig}: ${w}`))
      }
    }
  }

  output.log("\nSubagent registration:")

  const opencodeConfigPath = getOpencodeConfigPath(false, cwd)
  const opencodeConfigText = readFileSafe(opencodeConfigPath)
  let opencodeConfig: Record<string, unknown> = {}
  if (opencodeConfigText) {
    try {
      const parsed = parseJsonc(opencodeConfigText)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        opencodeConfig = parsed as Record<string, unknown>
      }
    } catch { /* ignore parse errors */ }
  }
  const providerID = config.provider ?? resolveProviderFromOpenCodeConfig(opencodeConfig as Config)

  let finalConfig = config
  let finalModels = config.models
  if (config.disable_provider_inference !== true && providerID) {
    finalModels = resolveModelsWithInference(
      config.models,
      providerID,
      opencodeConfig as Config,
      explicitModelOverrides,
    )
    finalConfig = { ...config, models: finalModels }
  }

  const probeConfig: Config = {}
  registerAgents(probeConfig, finalConfig)
  const agentStatus = checkAgentRegistration(probeConfig)
  const agentLine = `agents: ${agentStatus.registered}/${agentStatus.expected} registered`
  if (agentStatus.registered === agentStatus.expected) {
    output.log(pc.green(`  ${agentLine}`))
  } else {
    output.log(pc.yellow(`  ${agentLine}`))
    if (agentStatus.missing.length > 0) {
      output.log(pc.yellow(`  missing: ${agentStatus.missing.join(", ")}`))
    }
  }

  output.log("\nAgent runtime models:")
  const table = new Table({
    head: ["Agent", "Model", "Tier", "Source"],
    style: { head: [], border: [] },
    colAligns: ["left", "left", "left", "left"],
  })

  for (const agent of ALL_AGENTS) {
    const agentConfig = probeConfig.agent?.[agent.name] as Record<string, unknown> | undefined
    const model = typeof agentConfig?.model === "string" ? agentConfig.model : "(not set)"
    const tier = AGENT_TIER_MAP[agent.modelKey] ?? "unknown"
    const isExplicit = explicitModelOverrides.has(agent.modelKey)
    const source = isExplicit ? "explicit" : providerID ? "inferred" : "default"

    const sourceColored = source === "explicit"
      ? pc.cyan(source)
      : source === "inferred"
        ? pc.yellow(source)
        : pc.gray(source)

    table.push([agent.name, model, tier, sourceColored])
  }

  const tableLines = table.toString().split("\n")
  for (const line of tableLines) {
    output.log(`  ${line}`)
  }

  output.log("\nProvider inference:")
  if (config.disable_provider_inference === true) {
    output.log("  Auto provider inference: disabled (via omreConfig.disable_provider_inference).")
  } else if (providerID) {
    const source = config.provider ? "omre.provider" : "opencode-config"
    output.log(`  Inferred provider: ${providerID}  (source: ${source})`)
    output.log("  Final model assignment per agent:")
    for (const key of Object.keys(finalModels) as ModelKey[]) {
      output.log(`    ${key.padEnd(14)} → ${finalModels[key]}`)
    }
  } else {
    output.log("  Auto provider inference: no provider detected; using DEFAULT_MODEL for all unset agents.")
  }

  const promptWarnings = contractChecks.checkPromptExampleSchemaIdentity()
  const toolWarnings = contractChecks.checkAgentToolWhitelist()
  const contractWarnings = [...promptWarnings, ...toolWarnings]

  output.log("\nContract self-check:")
  output.log(`  ${formatContractStatus("prompt JSON examples match Zod schemas", promptWarnings)}`)
  output.log(`  ${formatContractStatus("agent tool whitelists clean", toolWarnings)}`)
  for (const warning of contractWarnings) output.log(pc.yellow(`  ${warning}`))

  output.log("\nReport layout:")
  const layoutWarnings = checkReportLayout(cwd, { apply: !!options.cleanReports, reportDirectory: config.report.directory })
  if (layoutWarnings.length === 0) {
    output.log(pc.green("  clean (no stray *-report.{md,json}; latest.md valid or absent)"))
  } else {
    for (const warning of layoutWarnings) output.log(pc.yellow(`  ${warning}`))
    if (options.cleanReports) {
      output.log(pc.gray("  --clean-reports applied: stray artifacts removed"))
    }
  }

  if (contractWarnings.length > 0) process.exitCode = 2
  if (options.strict && (contractWarnings.length > 0 || layoutWarnings.length > 0)) {
    process.exitCode = process.exitCode === 2 ? 2 : 1
  }
}

export function createCliProgram(): Command {
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
    .description("Check plugin configuration. CI exit codes: 0 clean, 1 doctor errored, 2 contract self-check failed. With --strict, layout warnings also exit 1.")
    .option("--clean-reports", "remove stray *-report.{md,json} artifacts in cwd and .omre/reports/", false)
    .option("--strict", "exit non-zero when any warning is reported (CI guard)", false)
    .action((opts: { cleanReports?: boolean; strict?: boolean }) => {
      try {
        runDoctor({ cleanReports: !!opts.cleanReports, strict: !!opts.strict })
      } catch (err) {
        console.error(pc.red(`doctor failed: ${err instanceof Error ? err.message : String(err)}`))
        process.exit(1)
      }
    })

  program.command("dry-run")
    .description("Show estimated review-code plan without calling models")
    .argument("[args...]", "extra review-code guidance")
    .action((args: string[]) => {
      const argsText = args.join(" ")
      try {
        const output = renderLocalDryRun({ args: argsText })
        // Detect scope-resolution errors surfaced by renderLocalDryRun
        const errorMatch = output.match(/^Resolved scope: error(?: \(([^)]+)\))?\n(.+)$/m)
        if (errorMatch) {
          console.error(pc.red(`Error: ${errorMatch[2]}`))
          process.exit(1)
        }
        const ambiguousMatch = output.match(/^Resolved scope: ambiguous\n(.+)$/m)
        if (ambiguousMatch) {
          console.error(pc.red(ambiguousMatch[1]))
          process.exit(1)
        }
        console.log(output)
      } catch (err) {
        console.error(pc.red(`dry-run failed: ${err instanceof Error ? err.message : String(err)}`))
        process.exit(1)
      }
    })

  return program
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const modulePath = fileURLToPath(import.meta.url)
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(modulePath)
  } catch {
    return path.resolve(entry) === modulePath
  }
}

if (isDirectExecution()) {
  createCliProgram().parse(process.argv)
}

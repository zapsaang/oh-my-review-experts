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
import { defaultConfigJsonc, findConfigFiles, loadConfig } from "./config/load-config.js"
import { AGENT_TIER_MAP } from "./config/provider-presets.js"
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

export function getOpencodeConfigPath(global: boolean, cwd = process.cwd(), homeDir = os.homedir()): string {
  return global
    ? path.join(homeDir, ".config", "opencode", "opencode.json")
    : path.resolve(cwd, "opencode.json")
}

export function getPluginConfigPath(global: boolean, cwd = process.cwd(), homeDir = os.homedir()): string {
  return global
    ? path.join(homeDir, ".config", "opencode", "oh-my-review-experts.jsonc")
    : path.resolve(cwd, ".opencode", "oh-my-review-experts.jsonc")
}

export interface InstallResult {
  opencodeConfigPath: string;
  pluginChanged: boolean;
  pluginConfigPath: string;
  configCreated: boolean;
}

export function runInstall(opts: { global?: boolean; project?: boolean; cwd?: string; homeDir?: string }): InstallResult {
  const cwd = opts.cwd ?? process.cwd()
  const homeDir = opts.homeDir ?? os.homedir()
  const global = !!opts.global
  const opencodeConfigPath = getOpencodeConfigPath(global, cwd, homeDir)
  const pluginChanged = ensurePluginInOpencodeConfig(opencodeConfigPath)
  const pluginConfigPath = getPluginConfigPath(global, cwd, homeDir)
  const configCreated = writeIfMissing(pluginConfigPath, defaultConfigJsonc())
  return { opencodeConfigPath, pluginChanged, pluginConfigPath, configCreated }
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
  const omreConfig = loadConfig(cwd)
  output.log("Command:", `/${omreConfig.command.name}`, "aliases:", omreConfig.command.aliases.join(", "))
  output.log("Report dir:", omreConfig.report.directory)
  output.log("Max estimated tasks:", omreConfig.costGuardrail.maxEstimatedTasks)

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
  if (!omreConfig.enabled) {
    output.log(pc.yellow("  plugin disabled"))
  } else if (!omreConfig.command.enabled) {
    output.log(pc.yellow("  commands disabled"))
  } else if (omreConfig.command.injection === "disabled") {
    output.log(pc.yellow("  injection disabled"))
  } else if (omreConfig.command.injection === "tool") {
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

  // Load raw opencode.json to initialize probe config with user-defined agent slots
  let probeConfig: Config = {};
  try {
    const opencodeRaw = fs.readFileSync(path.join(cwd, "opencode.json"), "utf-8");
    const parsed = JSON.parse(opencodeRaw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (obj.agents && !obj.agent) {
        obj.agent = obj.agents;
      }
      probeConfig = obj as Config;
    }
  } catch {
    // opencode.json does not exist — probeConfig stays empty
  }

  // Register OMRE agents; skip-on-conflict preserves existing opencode.json slots
  const { registered, skipped } = registerAgents(probeConfig, omreConfig);
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
    head: ["Agent", "Model", "Tier", "Parameters", "Source"],
    style: { head: [], border: [] },
    colAligns: ["left", "left", "left", "left", "left"],
  })

  for (const agent of ALL_AGENTS) {
    const agentConfig = probeConfig.agent?.[agent.name] as Record<string, unknown> | undefined
    const model = typeof agentConfig?.model === "string" ? agentConfig.model : "(not set)"
    const tier = AGENT_TIER_MAP[agent.name] ?? "unknown"
    const hasExplicitConfig = omreConfig.agents[agent.name]?.model !== undefined
    const source = hasExplicitConfig ? "config" : "default"
    const sourceColored = source === "config" ? pc.cyan(source) : pc.gray(source)

    const params: string[] = []
    const override = omreConfig.agents[agent.name]
    if (override?.variant !== undefined) params.push(`variant: ${override.variant}`)
    if (override?.temperature !== undefined) params.push(`temperature: ${override.temperature}`)
    if (override?.top_p !== undefined) params.push(`top_p: ${override.top_p}`)
    const paramsStr = params.join(", ") || "—"

    table.push([agent.name, model, tier, paramsStr, sourceColored])
  }

  const tableLines = table.toString().split("\n")
  for (const line of tableLines) {
    output.log(`  ${line}`)
  }

  for (const agent of ALL_AGENTS) {
    const ocAgent = probeConfig.agent?.[agent.name]
    const omreAgent = omreConfig.agents[agent.name]
    if (ocAgent && omreAgent && skipped.includes(agent.name)) {
      output.log(pc.yellow(`  Warning: ${agent.name} is configured in both opencode.json and OMRE config; OpenCode wins`))
    }
  }

  const promptWarnings = contractChecks.checkPromptExampleSchemaIdentity()
  const toolWarnings = contractChecks.checkAgentToolWhitelist()
  const contractWarnings = [...promptWarnings, ...toolWarnings]

  output.log("\nContract self-check:")
  output.log(`  ${formatContractStatus("prompt JSON examples match Zod schemas", promptWarnings)}`)
  output.log(`  ${formatContractStatus("agent tool whitelists clean", toolWarnings)}`)
  for (const warning of contractWarnings) output.log(pc.yellow(`  ${warning}`))

  output.log("\nReport layout:")
  const layoutWarnings = checkReportLayout(cwd, { apply: !!options.cleanReports, reportDirectory: omreConfig.report.directory })
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
        const result = runInstall(opts)
        console.log(result.pluginChanged ? pc.green(`enabled plugin in ${result.opencodeConfigPath}`) : pc.gray(`already enabled in ${result.opencodeConfigPath}`))
        console.log(result.configCreated ? pc.green(`config ready: ${result.pluginConfigPath}`) : pc.gray(`config exists: ${result.pluginConfigPath}`))
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

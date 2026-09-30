import { sdkError } from "../errors.js"
import type {
  AgentDefinition,
  CommandDefinition,
  HookEntry,
  HookEventName,
  HookRegistration,
  InlinePluginSpec,
  RemoteMcpServer,
  ExternalMcpServer,
  LocalMcpServer,
  RuntimeConfig,
  RuntimeMcpServer,
  SdkMcpServer,
  SkillDefinition,
} from "../types.js"
import type { RuntimeConfig as CognitioRuntimeConfig } from "./runtime-client/index.js"
import { NEUTRAL_BASE_PROMPT } from "./neutral-prompt.js"
import { normalizeToolRules } from "../tools/permission-rules.js"
import { z } from "zod"

type ServerOutputFormat = {
  type: "json_schema"
  schema: Record<string, unknown>
  retryCount: number
}

const RUNTIME_CONFIG_PHASE: Partial<Record<keyof RuntimeConfig, string>> = {
  systemPrompt: "Phase 6",
  instructions: "Phase 12",
  appendSystemPrompt: "Phase 6",
  model: "Phase 2",
  effort: "Phase 6",
  thinkingConfig: "Phase 6",
  maxTurns: "Phase 2",
  maxBudgetUsd: "Phase 2",
  permissionMode: "Phase 4",
  autoPermissionClassifierModel: "Phase 4",
  settingSources: "Phase 6",
  agents: "Phase 5",
  hooks: "Phase 4",
  canUseTool: "Phase 4",
  enableFileCheckpointing: "Phase 7",
  outputFormat: "Phase 9",
  backgroundTaskPolicy: "Phase 7",
  checkpointing: "Phase 7",
  skills: "Phase 8",
  commands: "Phase 8",
  plugins: "Phase 8",
}

const SUPPORTED = new Set<keyof RuntimeConfig>([
  "model",
  "maxTurns",
  "maxBudgetUsd",
  "permissionMode",
  "autoPermissionClassifierModel",
  "allowedTools",
  "disallowedTools",
  "hooks",
  "canUseTool",
  "sdkMcpServers",
  "enableToolSearch",
  "enableFileCheckpointing",
  "agents",
  "skills",
  "commands",
  "plugins",
  "systemPrompt",
  "instructions",
  "appendSystemPrompt",
  "settingSources",
  "outputFormat",
  "effort",
  "thinkingConfig",
  "checkpointing",
  "backgroundTaskPolicy",
  "compaction",
  "includeEnvironment",
])

/**
 * Session-create defaults (D-P12-4/5): inject the neutral base prompt when the
 * caller provided neither `systemPrompt` nor `instructions` (an explicit empty
 * string is an intentional empty base and is preserved), and default
 * `settingSources` to [] for every transport when the caller
 * did not set it. Applies ONLY on create — never on PATCH/get/resume/fork.
 */
export function applyCreateDefaults(
  runtimeConfig: RuntimeConfig | undefined,
  _context: { isolated: boolean },
): RuntimeConfig {
  const next: RuntimeConfig = { ...(runtimeConfig ?? {}) }
  if (next.systemPrompt === undefined && next.instructions === undefined) {
    next.systemPrompt = NEUTRAL_BASE_PROMPT
  }
  if (next.settingSources === undefined) {
    next.settingSources = []
  }
  return next
}

export interface LocalHookEntry extends HookEntry {
  id: string
  matcherSource?: string
  matcherFlags?: string
}

type HookEntries = NonNullable<RuntimeConfig["hooks"]>[HookEventName]

export function parseModel(model: string): { providerID: string; modelID: string } {
  if (typeof model !== "string") {
    throw sdkError("configuration", "runtimeConfig.model must use provider/model format")
  }
  const index = model.indexOf("/")
  if (index <= 0 || index === model.length - 1) {
    throw sdkError("configuration", "runtimeConfig.model must use provider/model format")
  }
  return {
    providerID: model.slice(0, index),
    modelID: model.slice(index + 1),
  }
}

export function normalizeRuntimeConfig(
  runtimeConfig: RuntimeConfig | undefined,
  overrides?: Partial<CognitioRuntimeConfig>,
): CognitioRuntimeConfig | undefined {
  if (!runtimeConfig) return
  const entry = Object.entries(runtimeConfig).find(
    ([key, value]) => value !== undefined && !SUPPORTED.has(key as keyof RuntimeConfig),
  )
  if (entry) {
    const [key] = entry as [keyof RuntimeConfig, RuntimeConfig[keyof RuntimeConfig]]
    throw sdkError(
      "configuration",
      `not implemented yet — ${RUNTIME_CONFIG_PHASE[key] ?? "future phase"} (runtimeConfig.${key})`,
    )
  }
  const result: CognitioRuntimeConfig = {}
  if (runtimeConfig.effort !== undefined) {
    if (!["low", "medium", "high", "max"].includes(runtimeConfig.effort)) {
      throw sdkError("configuration", "runtimeConfig.effort must be low, medium, high, or max")
    }
    result.effort = runtimeConfig.effort
  }
  if (runtimeConfig.thinkingConfig !== undefined) {
    const thinking = runtimeConfig.thinkingConfig
    if (!thinking || !["adaptive", "disabled", "enabled"].includes(thinking.type)) {
      throw sdkError("configuration", "runtimeConfig.thinkingConfig.type must be adaptive, disabled, or enabled")
    }
    if (thinking.type === "enabled" && (!Number.isInteger(thinking.budgetTokens) || thinking.budgetTokens < 1024)) {
      throw sdkError("configuration", "runtimeConfig.thinkingConfig.budgetTokens must be an integer of at least 1024")
    }
    result.thinkingConfig = thinking
  }
  if (runtimeConfig.backgroundTaskPolicy !== undefined) {
    if (runtimeConfig.backgroundTaskPolicy?.mode !== "foreground") {
      throw sdkError("configuration", 'runtimeConfig.backgroundTaskPolicy.mode must be "foreground"')
    }
    result.backgroundTaskPolicy = runtimeConfig.backgroundTaskPolicy
  }
  for (const key of ["checkpointing", "compaction"] as const) {
    const value = runtimeConfig[key]
    if (value === undefined) continue
    const fields = key === "checkpointing" ? ["enabled", "beforeTools", "beforeCompaction"] : ["auto", "includeFiles"]
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.entries(value).some(([name, entry]) => !fields.includes(name) || typeof entry !== "boolean")
    ) {
      throw sdkError("configuration", `runtimeConfig.${key} must contain only boolean ${fields.join(", ")} fields`)
    }
    Object.assign(result, { [key]: value })
  }
  if (runtimeConfig.includeEnvironment !== undefined) {
    if (typeof runtimeConfig.includeEnvironment !== "boolean") {
      throw sdkError("configuration", "runtimeConfig.includeEnvironment must be a boolean")
    }
    Object.assign(result, { includeEnvironment: runtimeConfig.includeEnvironment })
  }
  if (runtimeConfig.instructions !== undefined) {
    if (typeof runtimeConfig.instructions !== "string") {
      throw sdkError("configuration", "runtimeConfig.instructions must be a string")
    }
    if (runtimeConfig.systemPrompt !== undefined) {
      throw sdkError("configuration", "runtimeConfig.instructions cannot be combined with runtimeConfig.systemPrompt")
    }
    result.systemPrompt = runtimeConfig.instructions
  }
  if (runtimeConfig.systemPrompt !== undefined) result.systemPrompt = normalizeSystemPrompt(runtimeConfig.systemPrompt)
  if (runtimeConfig.appendSystemPrompt !== undefined) {
    if (typeof runtimeConfig.appendSystemPrompt !== "string") {
      throw sdkError("configuration", "runtimeConfig.appendSystemPrompt must be a string")
    }
    result.appendSystemPrompt = runtimeConfig.appendSystemPrompt
  }
  if (runtimeConfig.settingSources !== undefined)
    result.settingSources = normalizeSettingSources(runtimeConfig.settingSources)
  if (runtimeConfig.model !== undefined) result.model = parseModel(runtimeConfig.model)
  if (runtimeConfig.maxTurns !== undefined) {
    if (!Number.isInteger(runtimeConfig.maxTurns) || runtimeConfig.maxTurns <= 0) {
      throw sdkError("configuration", "runtimeConfig.maxTurns must be a positive integer")
    }
    result.maxTurns = runtimeConfig.maxTurns
  }
  if (runtimeConfig.maxBudgetUsd !== undefined) {
    if (
      typeof runtimeConfig.maxBudgetUsd !== "number" ||
      !Number.isFinite(runtimeConfig.maxBudgetUsd) ||
      runtimeConfig.maxBudgetUsd <= 0
    ) {
      throw sdkError("configuration", "runtimeConfig.maxBudgetUsd must be a positive number")
    }
    result.maxBudgetUsd = runtimeConfig.maxBudgetUsd
  }
  if (runtimeConfig.permissionMode !== undefined) {
    if (
      !["default", "acceptEdits", "dontAsk", "plan", "bypassPermissions", "auto"].includes(runtimeConfig.permissionMode)
    ) {
      throw sdkError("configuration", "runtimeConfig.permissionMode is invalid")
    }
    result.permissionMode = runtimeConfig.permissionMode
  }
  if (runtimeConfig.autoPermissionClassifierModel !== undefined) {
    ;(result as Record<string, unknown>).autoPermissionClassifierModel = parseModel(
      runtimeConfig.autoPermissionClassifierModel,
    )
  }
  if (runtimeConfig.canUseTool !== undefined) {
    if (runtimeConfig.canUseTool !== false && typeof runtimeConfig.canUseTool !== "function")
      throw sdkError("configuration", "runtimeConfig.canUseTool must be a function or false")
    ;(result as Record<string, unknown>).canUseTool = runtimeConfig.canUseTool !== false
  }
  const hooks = normalizeHookDescriptors(runtimeConfig.hooks)
  if (hooks) (result as Record<string, unknown>).hooks = hooks
  const agents = normalizeAgents(runtimeConfig.agents)
  if (agents) (result as Record<string, unknown>).agents = agents
  const skills = normalizeSkills(runtimeConfig.skills)
  if (skills) (result as Record<string, unknown>).skills = skills
  const commands = normalizeCommands(runtimeConfig.commands)
  if (commands) (result as Record<string, unknown>).commands = commands
  const plugins = normalizePlugins(runtimeConfig.plugins)
  if (plugins) (result as Record<string, unknown>).plugins = plugins
  const allowedTools = normalizeToolRules(runtimeConfig.allowedTools, "allowedTools")
  if (allowedTools !== undefined) result.allowedTools = allowedTools
  const disallowedTools = normalizeToolRules(runtimeConfig.disallowedTools, "disallowedTools")
  if (disallowedTools !== undefined) result.disallowedTools = disallowedTools
  if (runtimeConfig.sdkMcpServers !== undefined && !Array.isArray(runtimeConfig.sdkMcpServers)) {
    throw sdkError("configuration", "runtimeConfig.sdkMcpServers must be an array")
  }
  const mcpServers = normalizeMcpServers(runtimeConfig.sdkMcpServers, "runtimeConfig.sdkMcpServers", {
    allowHostedSdkMcp: true,
  })
  if (runtimeConfig.enableToolSearch !== undefined) {
    if (runtimeConfig.enableToolSearch === "always") result.enableToolSearch = true
    else if (runtimeConfig.enableToolSearch === "never") result.enableToolSearch = false
    else if (runtimeConfig.enableToolSearch === "auto" || typeof runtimeConfig.enableToolSearch === "boolean") {
      result.enableToolSearch = runtimeConfig.enableToolSearch
    } else {
      throw sdkError("configuration", 'runtimeConfig.enableToolSearch must be boolean, "auto", "always", or "never"')
    }
  }
  if (runtimeConfig.enableFileCheckpointing !== undefined) {
    if (typeof runtimeConfig.enableFileCheckpointing !== "boolean") {
      throw sdkError("configuration", "runtimeConfig.enableFileCheckpointing must be a boolean")
    }
    result.enableFileCheckpointing = runtimeConfig.enableFileCheckpointing
  }
  const outputFormat = normalizeOutputFormat(runtimeConfig.outputFormat)
  if (outputFormat) result.outputFormat = outputFormat as NonNullable<CognitioRuntimeConfig["outputFormat"]>
  const overrideMcpServers = overrides?.sdkMcpServers
  Object.assign(result, overrides)
  if (runtimeConfig.sdkMcpServers !== undefined || overrideMcpServers !== undefined) {
    result.sdkMcpServers = [...mcpServers, ...(overrideMcpServers ?? [])]
  }
  if (Object.keys(result).length === 0) return
  return result
}

export function assertSupportedRuntimeConfig(runtimeConfig: RuntimeConfig | undefined): void {
  normalizeRuntimeConfig(runtimeConfig)
}

export function normalizeOutputFormat(
  outputFormat: RuntimeConfig["outputFormat"] | undefined,
): ServerOutputFormat | undefined {
  if (outputFormat === undefined) return
  if (!outputFormat || typeof outputFormat !== "object" || Array.isArray(outputFormat)) {
    throw sdkError("configuration", "runtimeConfig.outputFormat must be an object")
  }
  if (outputFormat.type !== "json_schema")
    throw sdkError("configuration", 'runtimeConfig.outputFormat.type must be "json_schema"')
  const maxRetries = outputFormat.maxRetries ?? 2
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw sdkError("configuration", "runtimeConfig.outputFormat.maxRetries must be a non-negative integer")
  }
  return {
    type: "json_schema",
    schema: outputFormatSchema(outputFormat.schema, "runtimeConfig.outputFormat.schema"),
    retryCount: maxRetries,
  }
}

export function normalizeHookCallbacks(
  hooks: RuntimeConfig["hooks"] | undefined,
): Partial<Record<HookEventName, LocalHookEntry[]>> {
  if (!hooks) return {}
  return Object.fromEntries(
    Object.entries(hooks).map(([event, entries]) => [
      event,
      normalizeHookEntries(event as HookEventName, entries ?? []),
    ]),
  )
}

export function collectHookRegistrations(runtimeConfig: RuntimeConfig | undefined) {
  if (!runtimeConfig) return
  const result: HookRegistration = { ...(runtimeConfig.hooks ?? {}) }
  const mutable = result as Record<string, unknown[]>
  for (const plugin of runtimeConfig.plugins ?? []) {
    if (plugin.type !== "inline" || !plugin.hooks) continue
    for (const [event, entries] of Object.entries(normalizeHookCallbacks(plugin.hooks))) {
      mutable[event] = [
        ...(mutable[event] ?? []),
        ...entries.map((entry) => ({
          ...entry,
          id: `${plugin.name}:${entry.id}`,
        })),
      ]
    }
  }
  return Object.keys(result).length ? result : undefined
}

export function collectDirectSdkMcpServers(runtimeConfig: RuntimeConfig | undefined): SdkMcpServer[] {
  const result = [...(runtimeConfig?.sdkMcpServers?.filter(isDirectSdkMcpServer) ?? [])]
  for (const plugin of runtimeConfig?.plugins ?? []) {
    if (plugin.type !== "inline") continue
    result.push(
      ...(plugin.mcpServers ?? [])
        .filter(isDirectSdkMcpServer)
        .map((server) => ({ ...server, name: `plugin:${plugin.name}:${server.name}` })),
    )
  }
  return result
}

function normalizeHookDescriptors(hooks: RuntimeConfig["hooks"] | undefined) {
  if (hooks === undefined) return
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks))
    throw sdkError("configuration", "runtimeConfig.hooks must be an object")
  const callbacks = normalizeHookCallbacks(hooks)
  const entries = Object.entries(callbacks).map(([event, items]) => [
    event,
    items.map((item) => ({
      id: item.id,
      ...(item.matcherSource !== undefined ? { matcher: item.matcherSource } : {}),
      ...(item.matcherFlags !== undefined ? { matcherFlags: item.matcherFlags } : {}),
      ...(item.timeoutMs !== undefined ? { timeoutMs: item.timeoutMs } : {}),
      ...(item.async !== undefined ? { async: item.async } : {}),
    })),
  ])
  return Object.fromEntries(entries)
}

function normalizeSystemPrompt(
  systemPrompt: RuntimeConfig["systemPrompt"],
): NonNullable<CognitioRuntimeConfig["systemPrompt"]> {
  if (typeof systemPrompt === "string") return systemPrompt
  if (!systemPrompt || typeof systemPrompt !== "object") {
    throw sdkError("configuration", "runtimeConfig.systemPrompt must be a string or prompt object")
  }
  if (systemPrompt.type === "custom") {
    if (typeof systemPrompt.prompt !== "string")
      throw sdkError("configuration", "runtimeConfig.systemPrompt.prompt must be a string")
    return systemPrompt.prompt
  }
  if (systemPrompt.type === "preset") {
    if (systemPrompt.preset !== "default" && systemPrompt.preset !== "none") {
      throw sdkError("configuration", 'runtimeConfig.systemPrompt.preset must be "default" or "none"')
    }
    if (systemPrompt.append !== undefined && typeof systemPrompt.append !== "string") {
      throw sdkError("configuration", "runtimeConfig.systemPrompt.append must be a string")
    }
    return {
      type: "preset",
      preset: systemPrompt.preset,
      ...(systemPrompt.append !== undefined ? { append: systemPrompt.append } : {}),
    }
  }
  throw sdkError("configuration", 'runtimeConfig.systemPrompt.type must be "custom" or "preset"')
}

function normalizeSettingSources(
  settingSources: RuntimeConfig["settingSources"],
): NonNullable<CognitioRuntimeConfig["settingSources"]> {
  if (!Array.isArray(settingSources)) throw sdkError("configuration", "runtimeConfig.settingSources must be an array")
  for (const source of settingSources) {
    if (source !== "user" && source !== "project" && source !== "local") {
      throw sdkError("configuration", 'runtimeConfig.settingSources entries must be "user", "project", or "local"')
    }
  }
  return settingSources
}

function normalizeHookEntries(event: HookEventName, entries: HookEntries | undefined): LocalHookEntry[] {
  if (!Array.isArray(entries)) throw sdkError("configuration", `runtimeConfig.hooks.${event} must be an array`)
  return entries.map((entry, index) => {
    const normalized = (typeof entry === "function" ? { callback: entry } : entry) as HookEntry
    if (typeof normalized?.callback !== "function")
      throw sdkError("configuration", `runtimeConfig.hooks.${event}.${index}.callback must be a function`)
    const matcher = normalizeMatcher(normalized.matcher)
    return {
      ...normalized,
      id:
        (normalized as HookEntry & { id?: string }).id ??
        `${event}:${index}:${matcher.source ?? ""}:${matcher.flags ?? ""}`,
      ...(matcher.source !== undefined ? { matcherSource: matcher.source } : {}),
      ...(matcher.flags !== undefined ? { matcherFlags: matcher.flags } : {}),
    }
  })
}

function normalizeMatcher(matcher: HookEntry["matcher"] | undefined): { source?: string; flags?: string } {
  if (matcher === undefined) return {}
  if (typeof matcher === "string") return { source: matcher }
  if (matcher instanceof RegExp) return { source: matcher.source, flags: matcher.flags }
  throw sdkError("configuration", "hook matcher must be a string or RegExp")
}

function normalizeAgents(agents: RuntimeConfig["agents"] | undefined) {
  if (agents === undefined) return
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    throw sdkError("configuration", "runtimeConfig.agents must be an object")
  }
  return Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => {
      if (!name.trim()) throw sdkError("configuration", "runtimeConfig.agents names must be non-empty")
      return [name, normalizeAgent(name, agent)]
    }),
  )
}

function normalizeSkills(skills: RuntimeConfig["skills"] | undefined) {
  if (skills === undefined) return
  if (!Array.isArray(skills)) throw sdkError("configuration", "runtimeConfig.skills must be an array")
  const normalized = skills.map((skill, index) => normalizeSkill(skill, `runtimeConfig.skills.${index}`))
  assertUniqueNames(normalized, "runtimeConfig.skills")
  return normalized
}

function normalizeSkill(skill: SkillDefinition, path: string) {
  if (!skill || typeof skill !== "object") throw sdkError("configuration", `${path} must be an object`)
  const name = nonEmptyString(skill.name, `${path}.name`)
  const description = nonEmptyString(skill.description, `${path}.description`)
  const content = nonEmptyString(skill.content, `${path}.content`)
  const allowedTools = normalizeToolRules(skill.allowedTools, `${path}.allowedTools`)
  return {
    name,
    description,
    content,
    ...(skill.baseDir !== undefined ? { baseDir: nonEmptyString(skill.baseDir, `${path}.baseDir`) } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(skill.model !== undefined ? { model: normalizeSkillModel(skill.model, `${path}.model`) } : {}),
    ...(skill.disableModelInvocation !== undefined
      ? { disableModelInvocation: optionalBoolean(skill.disableModelInvocation, `${path}.disableModelInvocation`) }
      : {}),
  }
}

function normalizeCommands(commands: RuntimeConfig["commands"] | undefined) {
  if (commands === undefined) return
  if (!Array.isArray(commands)) throw sdkError("configuration", "runtimeConfig.commands must be an array")
  const normalized = commands.map((command, index) => normalizeCommand(command, `runtimeConfig.commands.${index}`))
  assertUniqueNames(normalized, "runtimeConfig.commands")
  return normalized
}

function normalizeCommand(command: CommandDefinition, path: string) {
  if (!command || typeof command !== "object") throw sdkError("configuration", `${path} must be an object`)
  const name = nonEmptyString(command.name, `${path}.name`)
  const template = nonEmptyString(command.template, `${path}.template`)
  const allowedTools = normalizeToolRules(command.allowedTools, `${path}.allowedTools`)
  const disallowedTools = normalizeToolRules(command.disallowedTools, `${path}.disallowedTools`)
  if (command.model !== undefined) parseModel(command.model)
  return {
    name,
    ...(command.description !== undefined
      ? { description: optionalString(command.description, `${path}.description`) }
      : {}),
    template,
    ...(command.agent !== undefined ? { agent: nonEmptyString(command.agent, `${path}.agent`) } : {}),
    ...(command.model !== undefined ? { model: command.model } : {}),
    ...(command.subtask !== undefined ? { subtask: optionalBoolean(command.subtask, `${path}.subtask`) } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
  }
}

function normalizePlugins(plugins: RuntimeConfig["plugins"] | undefined) {
  if (plugins === undefined) return
  if (!Array.isArray(plugins)) throw sdkError("configuration", "runtimeConfig.plugins must be an array")
  const seen = new Set<string>()
  return plugins.map((plugin, index) => {
    if (!plugin || typeof plugin !== "object")
      throw sdkError("configuration", `runtimeConfig.plugins.${index} must be an object`)
    if (plugin.type === "inline") {
      const normalized = normalizeInlinePlugin(plugin, `runtimeConfig.plugins.${index}`)
      if (seen.has(normalized.name))
        throw sdkError("configuration", `runtimeConfig.plugins has duplicate plugin name "${normalized.name}"`)
      seen.add(normalized.name)
      return normalized
    }
    if (plugin.type === "claude") {
      const pluginPath = nonEmptyString(plugin.path, `runtimeConfig.plugins.${index}.path`)
      const key = `claude:${pluginPath}`
      if (seen.has(key))
        throw sdkError("configuration", `runtimeConfig.plugins has duplicate Claude plugin path "${pluginPath}"`)
      seen.add(key)
      return { type: "claude" as const, path: pluginPath }
    }
    throw sdkError("configuration", `runtimeConfig.plugins.${index}.type must be "inline" or "claude"`)
  })
}

function normalizeInlinePlugin(plugin: InlinePluginSpec, path: string) {
  const name = nonEmptyString(plugin.name, `${path}.name`)
  return {
    type: "inline" as const,
    name,
    ...(plugin.description !== undefined
      ? { description: optionalString(plugin.description, `${path}.description`) }
      : {}),
    ...(plugin.version !== undefined ? { version: optionalString(plugin.version, `${path}.version`) } : {}),
    ...(plugin.skills !== undefined ? { skills: normalizeSkills(plugin.skills) } : {}),
    ...(plugin.commands !== undefined ? { commands: normalizeCommands(plugin.commands) } : {}),
    ...(plugin.agents !== undefined ? { agents: normalizeAgents(plugin.agents) } : {}),
    ...(plugin.hooks !== undefined ? { hooks: normalizeHookDescriptors(plugin.hooks) } : {}),
    ...(plugin.mcpServers !== undefined
      ? { mcpServers: normalizeMcpServers(plugin.mcpServers, `${path}.mcpServers`) }
      : {}),
  }
}

function nonEmptyString(value: unknown, path: string) {
  if (typeof value !== "string" || !value.trim()) throw sdkError("configuration", `${path} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, path: string) {
  if (typeof value !== "string") throw sdkError("configuration", `${path} must be a string`)
  return value
}

function optionalBoolean(value: unknown, path: string) {
  if (typeof value !== "boolean") throw sdkError("configuration", `${path} must be a boolean`)
  return value
}

function normalizeSkillModel(model: SkillDefinition["model"], path: string) {
  if (typeof model === "string") return parseModel(model)
  if (model && typeof model === "object") {
    return {
      providerID: nonEmptyString(model.providerID, `${path}.providerID`),
      modelID: nonEmptyString(model.modelID, `${path}.modelID`),
    }
  }
  throw sdkError("configuration", `${path} must use provider/model format or { providerID, modelID }`)
}

function normalizeAgent(name: string, agent: AgentDefinition) {
  if (!agent || typeof agent !== "object")
    throw sdkError("configuration", `runtimeConfig.agents.${name} must be an object`)
  if (typeof agent.prompt !== "string" || !agent.prompt.trim()) {
    throw sdkError("configuration", `runtimeConfig.agents.${name}.prompt is required`)
  }
  if (
    agent.permissionMode !== undefined &&
    !["default", "acceptEdits", "dontAsk", "plan", "bypassPermissions", "auto"].includes(agent.permissionMode)
  ) {
    throw sdkError("configuration", `runtimeConfig.agents.${name}.permissionMode is invalid`)
  }
  if (agent.steps !== undefined && (!Number.isInteger(agent.steps) || agent.steps <= 0)) {
    throw sdkError("configuration", `runtimeConfig.agents.${name}.steps must be a positive integer`)
  }
  if (agent.temperature !== undefined && typeof agent.temperature !== "number") {
    throw sdkError("configuration", `runtimeConfig.agents.${name}.temperature must be a number`)
  }
  if (agent.spawnMode !== undefined && agent.spawnMode !== "fresh" && agent.spawnMode !== "inherit") {
    throw sdkError("configuration", `runtimeConfig.agents.${name}.spawnMode must be "fresh" or "inherit"`)
  }
  const tools = normalizeToolRules(agent.tools, `runtimeConfig.agents.${name}.tools`)
  const disallowedTools = normalizeToolRules(agent.disallowedTools, `runtimeConfig.agents.${name}.disallowedTools`)
  return {
    prompt: agent.prompt,
    ...(agent.description !== undefined ? { description: agent.description } : {}),
    ...(agent.model !== undefined ? { model: parseModel(agent.model) } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(agent.permissionMode !== undefined ? { permissionMode: agent.permissionMode } : {}),
    ...(agent.mcpServers !== undefined ? { mcpServers: normalizeAgentMcpServers(name, agent.mcpServers) } : {}),
    ...(agent.steps !== undefined ? { steps: agent.steps } : {}),
    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
    ...(agent.spawnMode !== undefined ? { spawnMode: agent.spawnMode } : {}),
  }
}

function assertUniqueNames(items: Array<{ name: string }>, path: string) {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.name)) throw sdkError("configuration", `${path} has duplicate name "${item.name}"`)
    seen.add(item.name)
  }
}

function normalizeAgentMcpServers(name: string, servers: ExternalMcpServer[]) {
  if (!Array.isArray(servers))
    throw sdkError("configuration", `runtimeConfig.agents.${name}.mcpServers must be an array`)
  return servers.map((server) => {
    if (server.type === "local") return normalizeLocalMcpServer(server, `runtimeConfig.agents.${name}.mcpServers`)
    if (server.type !== "remote")
      throw sdkError("configuration", `runtimeConfig.agents.${name}.mcpServers only supports local or remote servers`)
    return normalizeRemoteMcpServer(server, `runtimeConfig.agents.${name}.mcpServers`)
  })
}

function normalizeMcpServers(
  servers: RuntimeMcpServer[] | undefined,
  path: string,
  options?: { allowHostedSdkMcp?: boolean },
): NonNullable<CognitioRuntimeConfig["sdkMcpServers"]> {
  if (!servers?.length) return []
  const result: NonNullable<CognitioRuntimeConfig["sdkMcpServers"]> = []
  for (const [index, server] of servers.entries()) {
    const serverPath = `${path}.${index}`
    if (server.type === "local") {
      result.push(normalizeLocalMcpServer(server, serverPath))
      continue
    }
    if (isRemoteMcpServer(server)) {
      result.push(normalizeRemoteMcpServer(server, serverPath))
      continue
    }
    if (isDirectSdkMcpServer(server)) {
      result.push(normalizeDirectSdkMcpServer(server, serverPath))
      continue
    }
    if (isSdkMcpServer(server) && options?.allowHostedSdkMcp) {
      validateHostedSdkMcpServer(server, serverPath)
      continue
    }
    if (isSdkMcpServer(server)) {
      throw sdkError("configuration", `${serverPath} SDK MCP servers in inline plugins must use transport "direct"`)
    }
  }
  return result
}

function normalizeRemoteMcpServer(server: RemoteMcpServer, path: string) {
  const name = nonEmptyString(server.name, `${path}.name`)
  const url = nonEmptyString(server.url, `${path}.${name}.url`)
  try {
    new URL(url)
  } catch {
    throw sdkError("configuration", `${path}.${name}.url must be a valid URL`)
  }
  if (server.enabled !== undefined && typeof server.enabled !== "boolean") {
    throw sdkError("configuration", `${path}.${name}.enabled must be a boolean`)
  }
  if (server.headers !== undefined) {
    if (!server.headers || typeof server.headers !== "object" || Array.isArray(server.headers)) {
      throw sdkError("configuration", `${path}.${name}.headers must be an object`)
    }
    for (const [key, value] of Object.entries(server.headers)) {
      if (typeof value !== "string") throw sdkError("configuration", `${path}.${name}.headers.${key} must be a string`)
    }
  }
  if (server.oauth !== undefined && server.oauth !== false) {
    throw sdkError("configuration", `${path}.${name}.oauth must be false`)
  }
  const timeout = optionalPositiveNumber(server.timeout, `${path}.${name}.timeout`)
  if (server.transport !== undefined && server.transport !== "http" && server.transport !== "sse") {
    throw sdkError("configuration", `${path}.${name}.transport must be http or sse`)
  }
  return {
    name,
    type: "remote" as const,
    url,
    ...(server.transport !== undefined ? { transport: server.transport } : {}),
    ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
    ...(server.headers !== undefined ? { headers: server.headers } : {}),
    ...(server.oauth !== undefined ? { oauth: server.oauth } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  }
}

/** @internal Validate an external MCP subprocess descriptor without spawning it. */
export function normalizeLocalMcpServer(server: LocalMcpServer, path: string) {
  const name = nonEmptyString(server.name, `${path}.name`)
  if (
    !Array.isArray(server.command) ||
    !server.command.length ||
    server.command.some((item) => typeof item !== "string") ||
    !server.command[0]?.trim()
  ) {
    throw sdkError("configuration", `${path}.${name}.command must be a non-empty array of strings`)
  }
  if (
    server.environment !== undefined &&
    (!server.environment ||
      typeof server.environment !== "object" ||
      Array.isArray(server.environment) ||
      Object.values(server.environment).some((value) => typeof value !== "string"))
  ) {
    throw sdkError("configuration", `${path}.${name}.environment must be a string record`)
  }
  if (server.cwd !== undefined) nonEmptyString(server.cwd, `${path}.${name}.cwd`)
  if (server.enabled !== undefined && typeof server.enabled !== "boolean")
    throw sdkError("configuration", `${path}.${name}.enabled must be a boolean`)
  optionalPositiveNumber(server.timeout, `${path}.${name}.timeout`)
  return { ...server, name }
}

function normalizeDirectSdkMcpServer(
  server: SdkMcpServer,
  path = "runtimeConfig.sdkMcpServers",
): NonNullable<CognitioRuntimeConfig["sdkMcpServers"]>[number] {
  if (server.resources?.length || server.prompts?.length) {
    throw sdkError("configuration", 'SDK MCP resources/prompts require transport "http"')
  }
  const name = nonEmptyString(server.name, `${path}.name`)
  if (server.enabled !== undefined && typeof server.enabled !== "boolean") {
    throw sdkError("configuration", `${path}.${name}.enabled must be a boolean`)
  }
  const timeout = optionalPositiveNumber(server.timeout, `${path}.${name}.timeout`)
  if (!Array.isArray(server.tools)) throw sdkError("configuration", `${path}.${name}.tools must be an array`)
  return {
    name,
    type: "sdk" as const,
    transport: "direct" as const,
    ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    tools: server.tools.map((tool) => {
      const toolName = nonEmptyString(tool.name, `${path}.${name}.tools.name`)
      if (typeof tool.execute !== "function") {
        throw sdkError("configuration", `${path}.${name}.tools.${toolName}.execute must be a function`)
      }
      if (tool.inputSchema === undefined && tool.inputJsonSchema === undefined) {
        throw sdkError("configuration", `${path}.${name}.tools.${toolName} requires inputSchema or inputJsonSchema`)
      }
      return {
        name: toolName,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: inputSchema(tool) as Record<string, unknown>,
        ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      }
    }),
  }
}

function optionalPositiveNumber(value: unknown, path: string) {
  if (value === undefined) return
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw sdkError("configuration", `${path} must be a positive number`)
  }
  return value
}

function validateHostedSdkMcpServer(server: SdkMcpServer, path: string) {
  if (server.transport !== undefined && server.transport !== "http") {
    throw sdkError("configuration", `${path}.transport must be "http" or "direct"`)
  }
  normalizeDirectSdkMcpServer({ ...server, transport: "direct", resources: undefined, prompts: undefined }, path)
}

function isRemoteMcpServer(server: RuntimeMcpServer): server is RemoteMcpServer {
  if (server.type === "remote") return true
  if (server.type !== undefined && server.type !== "sdk") {
    throw sdkError("configuration", 'runtimeConfig.sdkMcpServers entries must use type "sdk" or "remote"')
  }
  return false
}

function isSdkMcpServer(server: RuntimeMcpServer): server is SdkMcpServer {
  return server.type === undefined || server.type === "sdk"
}

function isDirectSdkMcpServer(server: RuntimeMcpServer): server is SdkMcpServer {
  return isSdkMcpServer(server) && server.transport === "direct"
}

function inputSchema(tool: SdkMcpServer["tools"][number]) {
  if (tool.inputJsonSchema !== undefined) return tool.inputJsonSchema
  if (isZodSchema(tool.inputSchema)) return z.toJSONSchema(tool.inputSchema)
  return tool.inputSchema
}

function outputFormatSchema(schema: unknown, path: string) {
  if (isZodSchema(schema)) return z.toJSONSchema(schema) as Record<string, unknown>
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw sdkError("configuration", `${path} must be a JSON Schema object or Zod schema`)
  }
  return schema as Record<string, unknown>
}

function isZodSchema(input: unknown): input is z.ZodType {
  return !!input && typeof input === "object" && "safeParse" in input
}

import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import type { SessionID } from "@/session/schema"
import { SessionRuntimeConfig } from "@/session/runtime-config"
import { ClaudeCompat } from "./claude-compat"

export type RuntimeSkill = SessionRuntimeConfig.RuntimeSkillDefinition & {
  source: "plugin"
  pluginName: string
  pluginRoot?: string
  skillDir?: string
}

export type RuntimeCommand = SessionRuntimeConfig.RuntimeCommandDefinition & {
  source: "plugin"
  pluginName: string
  pluginRoot?: string
  skillDir?: string
}

export type RuntimeAgent = SessionRuntimeConfig.RuntimeAgentDefinition & {
  source: "plugin"
  pluginName: string
}

export type PluginSummary = {
  name: string
  source: "inline" | "claude"
  skillCount: number
  commandCount: number
  agentCount: number
  hookEventCount: number
  mcpServerCount: number
  diagnostics?: string[]
}

export type MaterializedPlugin = {
  name: string
  source: "inline" | "claude"
  description?: string
  version?: string
  skills: RuntimeSkill[]
  commands: RuntimeCommand[]
  agents: Record<string, RuntimeAgent>
  hooks: Partial<Record<SessionRuntimeConfig.HookEventName, SessionRuntimeConfig.HookDescriptor[]>>
  mcpServers: SessionRuntimeConfig.RuntimeMcpServer[]
  diagnostics: string[]
}

export type Materialized = {
  skills: RuntimeSkill[]
  commands: RuntimeCommand[]
  agents: Record<string, RuntimeAgent>
  hooks: Partial<Record<SessionRuntimeConfig.HookEventName, SessionRuntimeConfig.HookDescriptor[]>>
  mcpServers: SessionRuntimeConfig.RuntimeMcpServer[]
  plugins: PluginSummary[]
}

export class InvalidRuntimePluginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidRuntimePluginError"
  }
}

const cache = new Map<string, Materialized>()
const expanded = Symbol.for("cognitio.runtimePlugin.expanded")
const materializedSnapshot = Symbol.for("cognitio.runtimePlugin.materialized")
const materializedFields = Symbol.for("cognitio.runtimePlugin.materializedFields")

type MaterializedFields = {
  agents: string[]
  hooks: Partial<Record<SessionRuntimeConfig.HookEventName, number>>
  mcpServers: string[]
}

export const clear: (sessionID: SessionID) => Effect.Effect<void> = Effect.fn("RuntimePlugin.clear")(function* (
  sessionID: SessionID,
) {
  const prefix = `${sessionID}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}) as never

export const materialize: (
  runtime: Pick<SessionRuntimeConfig.RuntimeConfig, "plugins">,
  sessionID?: SessionID,
) => Effect.Effect<Materialized> = Effect.fn("RuntimePlugin.materialize")(function* (
  runtime: Pick<SessionRuntimeConfig.RuntimeConfig, "plugins">,
  sessionID?: SessionID,
) {
  const snapshot = (runtime as Record<symbol, unknown>)[materializedSnapshot] as Materialized | undefined
  if (snapshot) return snapshot

  const key = `${sessionID ?? "global"}:${hash(runtime.plugins ?? [])}:${yield* pluginMetadata(runtime.plugins ?? [])}`
  const existing = cache.get(key)
  if (existing) return existing

  const result: Materialized = {
    skills: [],
    commands: [],
    agents: {},
    hooks: {},
    mcpServers: [],
    plugins: [],
  }
  const seenSkills = new Set<string>()
  const seenCommands = new Set<string>()
  const seenAgents = new Set<string>()
  const seenMcpServers = new Set<string>()
  const seenPlugins = new Set<string>()

  for (const spec of runtime.plugins ?? []) {
    const plugin = spec.type === "inline" ? materializeInline(spec) : yield* ClaudeCompat.load(spec, sessionID)
    const diagnostics = [...plugin.diagnostics]
    const addDiagnostic = (message: string) => diagnostics.push(message)
    let skillCount = 0
    let commandCount = 0
    let agentCount = 0
    let mcpServerCount = 0
    if (seenPlugins.has(plugin.name)) {
      return yield* Effect.fail(new InvalidRuntimePluginError(`Duplicate runtime plugin name "${plugin.name}"`))
    }
    seenPlugins.add(plugin.name)

    for (const skill of plugin.skills) {
      if (seenSkills.has(skill.name)) {
        addDiagnostic(`Skipped duplicate plugin skill "${skill.name}"`)
        continue
      }
      seenSkills.add(skill.name)
      result.skills.push(skill)
      skillCount++
    }

    for (const command of plugin.commands) {
      if (seenCommands.has(command.name)) {
        addDiagnostic(`Skipped duplicate plugin command "${command.name}"`)
        continue
      }
      seenCommands.add(command.name)
      result.commands.push(command)
      commandCount++
    }

    for (const [name, agent] of Object.entries(plugin.agents)) {
      if (seenAgents.has(name)) {
        addDiagnostic(`Skipped duplicate plugin agent "${name}"`)
        continue
      }
      seenAgents.add(name)
      result.agents[name] = agent
      agentCount++
    }

    for (const [event, descriptors] of Object.entries(plugin.hooks)) {
      result.hooks[event as SessionRuntimeConfig.HookEventName] = [
        ...(result.hooks[event as SessionRuntimeConfig.HookEventName] ?? []),
        ...descriptors,
      ]
    }

    for (const server of plugin.mcpServers) {
      if (seenMcpServers.has(server.name)) {
        addDiagnostic(`Skipped duplicate plugin MCP server "${server.name}"`)
        continue
      }
      seenMcpServers.add(server.name)
      result.mcpServers.push(server)
      mcpServerCount++
    }

    result.plugins.push({
      name: plugin.name,
      source: plugin.source,
      skillCount,
      commandCount,
      agentCount,
      hookEventCount: Object.values(plugin.hooks).filter((items) => items.length > 0).length,
      mcpServerCount,
      ...(diagnostics.length ? { diagnostics } : {}),
    })
  }

  cache.set(key, result)
  return result
}) as never

export const expand: (
  runtime: SessionRuntimeConfig.RuntimeConfig,
  sessionID?: SessionID,
) => Effect.Effect<SessionRuntimeConfig.RuntimeConfig> = Effect.fn("RuntimePlugin.expand")(function* (
  runtime: SessionRuntimeConfig.RuntimeConfig,
  sessionID?: SessionID,
) {
  if ((runtime as Record<symbol, unknown>)[expanded]) return runtime
  const plugin = yield* materialize(runtime, sessionID)
  const fields: MaterializedFields = {
    agents: Object.keys(plugin.agents).filter((name) => runtime.agents?.[name] === undefined),
    hooks: Object.fromEntries(
      Object.entries(plugin.hooks)
        .map(([event, descriptors]) => [event, descriptors.length] as const)
        .filter(([, count]) => count > 0),
    ),
    mcpServers: [
      ...plugin.mcpServers.map((server) => server.name),
      ...Object.values(plugin.agents).flatMap((agent) => agent.mcpServers?.map((server) => server.name) ?? []),
    ]
      .filter((name) => !(runtime.sdkMcpServers ?? []).some((server) => server.name === name)),
  }
  const next = {
    ...runtime,
    agents: {
      ...plugin.agents,
      ...(runtime.agents ?? {}),
    },
    hooks: mergeHooks(plugin.hooks, runtime.hooks),
    sdkMcpServers: dedupeMcpServers([...plugin.mcpServers, ...(runtime.sdkMcpServers ?? [])]),
  } satisfies SessionRuntimeConfig.RuntimeConfig
  Object.defineProperty(next, expanded, { value: true, enumerable: true })
  Object.defineProperty(next, materializedSnapshot, { value: plugin, enumerable: true })
  Object.defineProperty(next, materializedFields, { value: fields, enumerable: true })
  return next
}) as never

export function collapse(runtime: SessionRuntimeConfig.RuntimeConfig): SessionRuntimeConfig.RuntimeConfig {
  const fields = (runtime as Record<symbol, unknown>)[materializedFields] as MaterializedFields | undefined
  if (!fields) return runtime
  const base = Object.fromEntries(Object.entries(runtime)) as SessionRuntimeConfig.RuntimeConfig
  const agents = Object.fromEntries(
    Object.entries(runtime.agents ?? {}).filter(([name]) => !fields.agents.includes(name)),
  )
  const hooks = Object.fromEntries(
    Object.entries(runtime.hooks ?? {})
      .map(([event, descriptors]) => [
        event,
        descriptors.slice(fields.hooks[event as SessionRuntimeConfig.HookEventName] ?? 0),
      ] as const)
      .filter(([, descriptors]) => descriptors.length > 0),
  )
  const mcpServers = (runtime.sdkMcpServers ?? []).filter((server) => !fields.mcpServers.includes(server.name))
  return {
    ...base,
    ...(Object.keys(agents).length ? { agents } : { agents: undefined }),
    ...(Object.keys(hooks).length ? { hooks } : { hooks: undefined }),
    ...(mcpServers.length ? { sdkMcpServers: mcpServers } : { sdkMcpServers: undefined }),
  }
}

export function substitute(
  template: string,
  input: { sessionID?: SessionID; pluginRoot?: string; skillDir?: string },
) {
  return template
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", input.pluginRoot ?? "")
    .replaceAll("${CLAUDE_SKILL_DIR}", input.skillDir ?? "")
    .replaceAll("${CLAUDE_SESSION_ID}", input.sessionID ?? "")
}

function materializeInline(plugin: SessionRuntimeConfig.RuntimeInlinePlugin): MaterializedPlugin {
  return {
    name: plugin.name,
    source: "inline",
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
    skills: (plugin.skills ?? []).map((skill) => ({
      ...skill,
      name: namespace(plugin.name, skill.name),
      source: "plugin" as const,
      pluginName: plugin.name,
      ...(skill.baseDir ? { skillDir: skill.baseDir } : {}),
    })),
    commands: (plugin.commands ?? []).map((command) => ({
      ...command,
      name: namespace(plugin.name, command.name),
      ...(inlineCommandAgent(plugin, command.agent)),
      source: "plugin" as const,
      pluginName: plugin.name,
    })),
    agents: Object.fromEntries(
      Object.entries(plugin.agents ?? {}).map(([name, agent]) => [
        namespace(plugin.name, name),
        {
          ...agent,
          source: "plugin" as const,
          pluginName: plugin.name,
          ...(agent.mcpServers
            ? {
                mcpServers: agent.mcpServers.map((server) => ({
                  ...server,
                  name: namespaceMcp(plugin.name, server.name),
                })),
              }
            : {}),
        },
      ]),
    ),
    hooks: Object.fromEntries(
      Object.entries(plugin.hooks ?? {}).map(([event, descriptors]) => [
        event,
        descriptors.map((descriptor) => ({ ...descriptor, id: namespace(plugin.name, descriptor.id) })),
      ]),
    ),
    mcpServers: (plugin.mcpServers ?? []).map((server) => ({
      ...server,
      name: namespaceMcp(plugin.name, server.name),
    })),
    diagnostics: [],
  }
}

function mergeHooks(
  plugin: Materialized["hooks"],
  runtime: SessionRuntimeConfig.RuntimeConfig["hooks"],
): SessionRuntimeConfig.RuntimeConfig["hooks"] {
  const result: SessionRuntimeConfig.RuntimeConfig["hooks"] = {}
  for (const [event, descriptors] of Object.entries(plugin)) {
    result[event as SessionRuntimeConfig.HookEventName] = [...descriptors]
  }
  for (const [event, descriptors] of Object.entries(runtime ?? {})) {
    result[event as SessionRuntimeConfig.HookEventName] = [
      ...(result[event as SessionRuntimeConfig.HookEventName] ?? []),
      ...descriptors,
    ]
  }
  return Object.keys(result).length ? result : undefined
}

function dedupeMcpServers(servers: SessionRuntimeConfig.RuntimeMcpServer[]) {
  return Array.from(new Map(servers.map((server) => [server.name, server])).values())
}

function inlineCommandAgent(plugin: SessionRuntimeConfig.RuntimeInlinePlugin, agent: string | undefined) {
  if (!agent) return {}
  if (plugin.agents?.[agent]) return { agent: namespace(plugin.name, agent) }
  const prefix = `${plugin.name}:`
  if (agent.startsWith(prefix) && plugin.agents?.[agent.slice(prefix.length)]) return { agent }
  return { agent }
}

const pluginMetadata = Effect.fn("RuntimePlugin.pluginMetadata")(function* (
  plugins: SessionRuntimeConfig.RuntimePluginSpec[],
) {
  return hash(
    yield* Effect.forEach(
      plugins,
      (plugin) =>
        plugin.type === "claude"
          ? treeFingerprint(path.resolve(plugin.path)).pipe(
              Effect.map((fingerprint) => ({
                type: plugin.type as string,
                name: "",
                path: path.resolve(plugin.path),
                fingerprint,
              })),
            )
          : Effect.succeed({
              type: plugin.type as string,
              name: plugin.name,
              path: "",
              fingerprint: [] as Array<{ file: string; mtimeMs: number; size: number }>,
            }),
      { concurrency: "unbounded" },
    ),
  )
})

const treeFingerprint: (root: string) => Effect.Effect<Array<{ file: string; mtimeMs: number; size: number }>> = Effect.fn(
  "RuntimePlugin.treeFingerprint",
)(function* (root: string) {
  const entries = yield* Effect.promise(() =>
    fs.readdir(root, { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]),
  )
  const nested = yield* Effect.forEach(
    entries,
    (entry) => {
      const full = path.join(root, entry.name)
      if (entry.isDirectory()) return treeFingerprint(full)
      return Effect.promise(() =>
        fs
          .stat(full)
          .then((stat) => {
            return [{ file: full, mtimeMs: stat.mtimeMs, size: stat.size }]
          })
          .catch(() => [] as Array<{ file: string; mtimeMs: number; size: number }>),
      )
    },
    { concurrency: "unbounded" },
  )
  return nested.flat().toSorted((a, b) => a.file.localeCompare(b.file))
}) as never

export function namespace(pluginName: string, name: string) {
  return `${pluginName}:${name}`
}

export function namespaceMcp(pluginName: string, name: string) {
  return `plugin:${pluginName}:${name}`
}

function hash(input: unknown) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex")
}

export * as RuntimePlugin from "./runtime"

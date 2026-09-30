import fs from "fs/promises"
import type { Dirent } from "fs"
import path from "path"
import { Effect } from "effect"
import * as ConfigMarkdown from "@/config/markdown"
import { SessionRuntimeConfig } from "@/session/runtime-config"
import type { SessionID } from "@/session/schema"
import type { MaterializedPlugin, RuntimeAgent, RuntimeCommand, RuntimeSkill } from "./runtime"

type Manifest = Record<string, unknown>

type Markdown = {
  file: string
  base: string
  data: Record<string, unknown>
  content: string
}

type MarkdownPath = {
  file: string
  base: string
}

const unsupportedManifestFields = [
  "outputStyles",
  "channels",
  "lspServers",
  "settings",
  "userConfig",
  "dependencies",
  "marketplaces",
  "marketplace",
  "updates",
  "mcpb",
  "dxt",
]

export const load: (
  spec: SessionRuntimeConfig.RuntimeClaudePlugin,
  sessionID?: SessionID,
) => Effect.Effect<MaterializedPlugin> = Effect.fn("ClaudeCompat.load")(function* (
  spec: SessionRuntimeConfig.RuntimeClaudePlugin,
  _sessionID?: SessionID,
) {
  const root = path.resolve(spec.path)
  const manifestPath = yield* findManifest(root)
  const manifest = yield* readJson(manifestPath)
  const name = text(manifest.name) ?? path.basename(root)
  const diagnostics = unsupportedManifestFields
    .filter((field) => manifest[field] !== undefined)
    .map((field) => `Ignored unsupported Claude plugin field "${field}"`)

  const agents = yield* loadAgents(root, name, manifest, diagnostics)
  const skills = yield* loadSkills(root, name, manifest, diagnostics)
  const commands = yield* loadCommands(root, name, manifest, diagnostics, agents)
  const hooks = yield* loadHooks(root, name, manifest, diagnostics)
  const mcpServers = yield* loadMcpServers(root, name, manifest, diagnostics)

  return {
    name,
    source: "claude" as const,
    ...(text(manifest.description) ? { description: text(manifest.description) } : {}),
    ...(text(manifest.version) ? { version: text(manifest.version) } : {}),
    skills,
    commands,
    agents,
    hooks,
    mcpServers,
    diagnostics,
  } satisfies MaterializedPlugin
}) as never

const findManifest = Effect.fn("ClaudeCompat.findManifest")(function* (root: string) {
  const preferred = path.join(root, ".claude-plugin", "plugin.json")
  if (yield* exists(preferred)) return preferred
  const fallback = path.join(root, "plugin.json")
  if (yield* exists(fallback)) return fallback
  return yield* Effect.fail(invalidRuntimePlugin(`Claude plugin manifest not found under ${root}`))
})

const loadSkills = Effect.fn("ClaudeCompat.loadSkills")(function* (
  root: string,
  pluginName: string,
  manifest: Manifest,
  diagnostics: string[],
) {
  const dirs: string[] = yield* componentPaths(root, manifest.skills, path.join(root, "skills"))
  const files = yield* componentMarkdownFiles(
    dirs,
    (file) => path.basename(file).toLowerCase() === "skill.md",
    "skill",
    diagnostics,
  )
  const skills: RuntimeSkill[] = []
  for (const item of files) {
    const md = yield* readMarkdown(item.file, item.base)
    const skillDir = path.dirname(item.file)
    const name = namespace(pluginName, pathName(md.base, skillDir) || path.basename(skillDir))
    const description = text(md.data.description) ?? firstLine(md.content)
    if (!description) {
      diagnostics.push(`Skipped Claude skill "${name}" because it has no description`)
      continue
    }
    const parsed = SessionRuntimeConfig.RuntimeSkillDefinition.safeParse({
      name,
      description,
      content: md.content.trim(),
      baseDir: skillDir,
      allowedTools: toolList(md.data["allowed-tools"] ?? md.data.allowedTools),
      model: modelValue(md.data.model),
      disableModelInvocation: booleanValue(md.data["disable-model-invocation"] ?? md.data.disableModelInvocation),
    })
    if (!parsed.success) {
      diagnostics.push(`Skipped Claude skill "${name}" because ${issues(parsed.error.issues)}`)
      continue
    }
    skills.push({
      ...parsed.data,
      source: "plugin",
      pluginName,
      pluginRoot: root,
      skillDir,
    })
  }
  return skills
})

const loadCommands = Effect.fn("ClaudeCompat.loadCommands")(function* (
  root: string,
  pluginName: string,
  manifest: Manifest,
  diagnostics: string[],
  agents: Record<string, RuntimeAgent>,
) {
  const commands: RuntimeCommand[] = []
  const dirs: string[] = yield* componentPaths(root, manifest.commands, path.join(root, "commands"))
  const files = yield* componentMarkdownFiles(dirs, (file) => file.endsWith(".md"), "command", diagnostics)

  for (const item of files) {
    const md = yield* readMarkdown(item.file, item.base)
    if (path.basename(item.file).toLowerCase() === "skill.md") continue
    const command = commandFromMarkdown(pluginName, root, md, diagnostics, agents)
    if (command) commands.push(command)
  }

  for (const [name, item] of Object.entries(objectValue(manifest.commands) ?? {})) {
    if (!isRecord(item)) continue
    if (typeof item.content === "string") {
      const command = validateCommand(
        {
          name: namespace(pluginName, name),
          description: text(item.description),
          template: item.content.trim(),
          ...commandAgent(pluginName, agents, text(item.agent)),
          model: text(item.model),
          allowedTools: toolList(item.allowedTools ?? item["allowed-tools"]),
          disallowedTools: toolList(item.disallowedTools ?? item["disallowed-tools"]),
          subtask: booleanValue(item.subtask),
          source: "plugin",
          pluginName,
          pluginRoot: root,
        },
        diagnostics,
      )
      if (command) commands.push(command)
    } else if (item.content !== undefined) {
      diagnostics.push(`Skipped Claude command "${namespace(pluginName, name)}" because content must be a string`)
    }
    if (typeof item.source === "string") {
      const loaded = yield* loadCommandPath(root, pluginName, root, item.source, diagnostics, agents)
      commands.push(...loaded)
    }
  }

  return commands
})

const loadAgents = Effect.fn("ClaudeCompat.loadAgents")(function* (
  root: string,
  pluginName: string,
  manifest: Manifest,
  diagnostics: string[],
) {
  const dirs: string[] = yield* componentPaths(root, manifest.agents, path.join(root, "agents"))
  const files = yield* componentMarkdownFiles(dirs, (file) => file.endsWith(".md"), "agent", diagnostics)
  const agents: Record<string, RuntimeAgent> = {}
  for (const item of files) {
    const md = yield* readMarkdown(item.file, item.base)
    const name = namespace(pluginName, pathName(md.base, item.file, ".md"))
    const model = modelRef(text(md.data.model))
    if (md.data.permissionMode !== undefined) diagnostics.push(`Ignored Claude-only agent permissionMode for "${name}"`)
    if (md.data.hooks !== undefined) diagnostics.push(`Ignored Claude-only agent hooks for "${name}"`)
    if (md.data.mcpServers !== undefined) diagnostics.push(`Ignored Claude-only agent mcpServers for "${name}"`)
    const parsed = SessionRuntimeConfig.RuntimeAgentDefinition.safeParse({
      prompt: substituteStatic(md.content.trim(), root),
      description: text(md.data.description) ?? text(md.data["when-to-use"]),
      ...(model ? { model } : {}),
      tools: toolList(md.data.tools),
      disallowedTools: toolList(md.data.disallowedTools ?? md.data["disallowed-tools"]),
      steps: positiveInt(md.data.maxTurns ?? md.data.steps),
      temperature: numberValue(md.data.temperature),
    })
    if (!parsed.success) {
      diagnostics.push(`Skipped Claude agent "${name}" because ${issues(parsed.error.issues)}`)
      continue
    }
    agents[name] = {
      ...parsed.data,
      source: "plugin",
      pluginName,
    }
  }
  return agents
})

const loadHooks = Effect.fn("ClaudeCompat.loadHooks")(function* (
  root: string,
  pluginName: string,
  manifest: Manifest,
  diagnostics: string[],
) {
  const result: Partial<Record<SessionRuntimeConfig.HookEventName, SessionRuntimeConfig.HookDescriptor[]>> = {}
  const merge = (
    parsed: Partial<Record<SessionRuntimeConfig.HookEventName, SessionRuntimeConfig.HookDescriptor[]>>,
  ) => {
    for (const [event, descriptors] of Object.entries(parsed)) {
      result[event as SessionRuntimeConfig.HookEventName] = [
        ...(result[event as SessionRuntimeConfig.HookEventName] ?? []),
        ...descriptors,
      ]
    }
  }
  const manifestHookPaths = isRecord(manifest.hooks)
    ? []
    : yield* manifestPaths(root, manifest.hooks, diagnostics, "Claude hook")
  const manifestHookFiles = manifestHookPaths.filter((file) => file.endsWith(".json"))
  const hookFiles = Array.from(new Set([path.join(root, "hooks", "hooks.json"), ...manifestHookFiles]))
  if (isRecord(manifest.hooks)) merge(parseHookDescriptors(manifest.hooks, pluginName, diagnostics))
  for (const item of manifestRecords(manifest.hooks, diagnostics, "Claude hook", isHookConfig)) {
    merge(parseHookDescriptors(item, pluginName, diagnostics))
  }
  for (const file of hookFiles) {
    if (!(yield* exists(file))) continue
    const json = yield* readOptionalJson(file, diagnostics, "Claude hook JSON")
    if (json === undefined) continue
    merge(parseHookDescriptors(json, pluginName, diagnostics))
  }
  if (
    manifest.hooks !== undefined &&
    !isRecord(manifest.hooks) &&
    (manifestHookFiles.length === 0 || manifestHookFiles.length !== manifestHookPaths.length)
  ) {
    diagnostics.push("Ignored Claude hooks because shell hook execution is not supported in runtime plugins")
  }
  return result
})

const loadMcpServers = Effect.fn("ClaudeCompat.loadMcpServers")(function* (
  root: string,
  pluginName: string,
  manifest: Manifest,
  diagnostics: string[],
) {
  const configs: unknown[] = []
  const mcpJson = path.join(root, ".mcp.json")
  if (yield* exists(mcpJson)) {
    const json = yield* readOptionalJson(mcpJson, diagnostics, "Claude MCP JSON")
    if (json !== undefined) configs.push(json)
  }
  for (const file of yield* manifestPaths(root, manifest.mcpServers, diagnostics, "Claude MCP")) {
    if (file.endsWith(".mcpb") || file.endsWith(".dxt")) {
      diagnostics.push(`Ignored unsupported Claude MCPB/DXT package "${file}"`)
      continue
    }
    if (yield* exists(file)) {
      const json = yield* readOptionalJson(file, diagnostics, "Claude MCP JSON")
      if (json !== undefined) configs.push(json)
    }
  }
  if (isRecord(manifest.mcpServers)) configs.push(manifest.mcpServers)
  configs.push(...manifestRecords(manifest.mcpServers, diagnostics, "Claude MCP", isMcpConfig))

  const servers: SessionRuntimeConfig.RuntimeMcpServer[] = []
  for (const config of configs) {
    const entries = objectValue(isRecord(config) && isRecord(config.mcpServers) ? config.mcpServers : config) ?? {}
    for (const [name, server] of Object.entries(entries)) {
      if (!isRecord(server)) {
        diagnostics.push(`Skipped Claude MCP server "${name}" because server config must be an object`)
        continue
      }
      const url = text(server.url)
      if (!url) {
        const command = text(server.command)
        const parsed = SessionRuntimeConfig.RuntimeLocalMcpServer.safeParse({
          name: namespaceMcp(pluginName, name),
          type: "local",
          command:
            command && (server.args === undefined || Array.isArray(server.args))
              ? [command, ...((server.args as unknown[]) ?? [])]
              : undefined,
          environment: server.env,
          cwd: typeof server.cwd === "string" ? path.resolve(root, server.cwd) : root,
          enabled: server.enabled,
          timeout: server.timeout,
        })
        if (parsed.success) {
          servers.push(parsed.data)
          continue
        }
        diagnostics.push(
          `Skipped Claude MCP server "${name}" because ${issues(parsed.error.issues)}; MCPB/DXT packages are unsupported`,
        )
        continue
      }
      const parsed = SessionRuntimeConfig.RuntimeRemoteMcpServer.safeParse({
        name: namespaceMcp(pluginName, name),
        type: "remote",
        url,
        ...(server.type === "sse" ? { transport: "sse" } : server.type === "http" ? { transport: "http" } : {}),
        ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
        ...(server.headers !== undefined ? { headers: server.headers } : {}),
        ...(server.oauth !== undefined ? { oauth: server.oauth } : {}),
        ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
      })
      if (parsed.success) {
        servers.push(parsed.data)
        continue
      }
      diagnostics.push(`Skipped Claude MCP server "${name}" because ${issues(parsed.error.issues)}`)
    }
  }
  return servers
})

function commandFromMarkdown(
  pluginName: string,
  root: string,
  md: Markdown,
  diagnostics: string[],
  agents: Record<string, RuntimeAgent>,
): RuntimeCommand | undefined {
  return validateCommand(
    {
      name: namespace(pluginName, pathName(md.base, md.file, ".md")),
      description: text(md.data.description),
      template: substituteStatic(md.content.trim(), root),
      ...commandAgent(pluginName, agents, text(md.data.agent)),
      model: text(md.data.model),
      subtask: booleanValue(md.data.subtask),
      allowedTools: toolList(md.data["allowed-tools"] ?? md.data.allowedTools),
      disallowedTools: toolList(md.data["disallowed-tools"] ?? md.data.disallowedTools),
      source: "plugin",
      pluginName,
      pluginRoot: root,
    },
    diagnostics,
  )
}

function validateCommand(command: RuntimeCommand, diagnostics: string[]) {
  const parsed = SessionRuntimeConfig.RuntimeCommandDefinition.safeParse(command)
  if (parsed.success) return { ...command, ...parsed.data }
  diagnostics.push(`Skipped Claude command "${command.name}" because ${issues(parsed.error.issues)}`)
}

const loadCommandPath: (
  root: string,
  pluginName: string,
  base: string,
  source: string,
  diagnostics: string[],
  agents: Record<string, RuntimeAgent>,
) => Effect.Effect<RuntimeCommand[]> = Effect.fn("ClaudeCompat.loadCommandPath")(function* (
  root: string,
  pluginName: string,
  base: string,
  source: string,
  diagnostics: string[],
  agents: Record<string, RuntimeAgent>,
) {
  const full = resolvePluginPath(root, source)
  if (!(yield* exists(full))) {
    diagnostics.push(`Skipped missing Claude command source "${source}"`)
    return []
  }
  if ((yield* stat(full)).isDirectory()) {
    const files = yield* findFiles(full, (file) => file.endsWith(".md"))
    const commands = yield* Effect.forEach(files, (file: string) =>
      readMarkdown(file, full).pipe(Effect.map((md) => commandFromMarkdown(pluginName, root, md, diagnostics, agents))),
    )
    return commands.filter((command): command is RuntimeCommand => command !== undefined)
  }
  const command = commandFromMarkdown(pluginName, root, yield* readMarkdown(full, base), diagnostics, agents)
  return command ? [command] : []
}) as never

const componentMarkdownFiles: (
  paths: string[],
  filter: (file: string) => boolean,
  label: string,
  diagnostics: string[],
) => Effect.Effect<MarkdownPath[]> = Effect.fn("ClaudeCompat.componentMarkdownFiles")(function* (
  paths: string[],
  filter: (file: string) => boolean,
  label: string,
  diagnostics: string[],
) {
  const files = yield* Effect.forEach(
    paths,
    Effect.fnUntraced(function* (item) {
      const info = yield* stat(item)
      if (info.isDirectory()) {
        return (yield* findFiles(item, filter)).map((file) => ({ file, base: item }))
      }
      if (filter(item)) return [{ file: item, base: path.dirname(item) }]
      diagnostics.push(`Skipped Claude ${label} path "${item}" because it is not a supported Markdown file`)
      return []
    }),
    { concurrency: "unbounded" },
  )
  return dedupeMarkdownPaths(files.flat())
}) as never

const componentPaths: (root: string, value: unknown, fallback: string) => Effect.Effect<string[]> = Effect.fn(
  "ClaudeCompat.componentPaths",
)(function* (root: string, value: unknown, fallback: string) {
  const result = new Set<string>()
  if (yield* exists(fallback)) result.add(fallback)
  for (const item of yield* manifestPaths(root, value)) {
    if (yield* exists(item)) result.add(item)
  }
  return Array.from(result)
}) as never

const manifestPaths: (root: string, value: unknown, diagnostics?: string[], label?: string) => Effect.Effect<string[]> =
  Effect.fn("ClaudeCompat.manifestPaths")(function* (
    root: string,
    value: unknown,
    diagnostics?: string[],
    label?: string,
  ) {
    if (typeof value === "string") return [resolvePluginPath(root, value)]
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => {
        if (typeof item === "string") return [resolvePluginPath(root, item)]
        if (isRecord(item)) return []
        diagnostics?.push(`Ignored unsupported ${label ?? "Claude manifest"} entry at index ${index}`)
        return []
      })
    }
    return []
  }) as never

function manifestRecords(
  value: unknown,
  diagnostics: string[],
  label: string,
  supported: (value: Record<string, unknown>) => boolean,
) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return []
    if (supported(item)) return [item]
    diagnostics.push(`Ignored unsupported ${label} entry at index ${index}`)
    return []
  })
}

function isHookConfig(config: Record<string, unknown>) {
  const source = isRecord(config.hooks) ? config.hooks : config
  return Object.keys(source).some((event) => SessionRuntimeConfig.HookEventName.safeParse(event).success)
}

function isMcpConfig(config: Record<string, unknown>) {
  const source = isRecord(config.mcpServers) ? config.mcpServers : config
  return Object.values(source).some(isRecord)
}

function parseHookDescriptors(
  config: unknown,
  pluginName: string,
  diagnostics: string[],
): Partial<Record<SessionRuntimeConfig.HookEventName, SessionRuntimeConfig.HookDescriptor[]>> {
  if (!isRecord(config)) {
    diagnostics.push("Ignored Claude hooks because hook config must be an object")
    return {}
  }
  if (config.hooks !== undefined && !isRecord(config.hooks)) {
    diagnostics.push("Ignored Claude hooks wrapper because hooks must be an object")
  }
  const source = isRecord(config.hooks) ? config.hooks : config
  const result: Partial<Record<SessionRuntimeConfig.HookEventName, SessionRuntimeConfig.HookDescriptor[]>> = {}
  for (const [event, value] of Object.entries(source)) {
    const parsedEvent = SessionRuntimeConfig.HookEventName.safeParse(event)
    if (!parsedEvent.success) {
      diagnostics.push(`Ignored unsupported Claude hook event "${event}"`)
      continue
    }
    if (!Array.isArray(value)) {
      diagnostics.push(`Ignored Claude hook event "${event}" because value must be an array`)
      continue
    }
    const descriptors = value.flatMap((item, index) => {
      if (!isRecord(item)) {
        diagnostics.push(
          `Ignored unsupported Claude hook for ${event} at index ${index} because entry must be an object`,
        )
        return []
      }
      if (typeof item.id !== "string" || item.command !== undefined || item.hooks !== undefined) {
        diagnostics.push(`Ignored unsupported Claude hook for ${event}`)
        return []
      }
      const parsed = SessionRuntimeConfig.HookDescriptor.safeParse({
        id: namespace(pluginName, item.id),
        matcher: text(item.matcher),
        matcherFlags: text(item.matcherFlags),
        timeoutMs: positiveInt(item.timeoutMs),
        async: booleanValue(item.async),
      })
      if (parsed.success) return [parsed.data]
      diagnostics.push(`Ignored unsupported Claude hook for ${event}: ${issues(parsed.error.issues)}`)
      return []
    })
    if (descriptors.length) result[parsedEvent.data] = descriptors
  }
  return result
}

const readMarkdown = Effect.fn("ClaudeCompat.readMarkdown")(function* (file: string, base: string) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(file),
    catch: (error) => error,
  })
  return {
    file,
    base,
    data: md.data,
    content: md.content,
  } satisfies Markdown
})

const findFiles: (dir: string, filter: (file: string) => boolean) => Effect.Effect<string[]> = Effect.fn(
  "ClaudeCompat.findFiles",
)(function* (dir: string, filter: (file: string) => boolean) {
  const entries = yield* Effect.promise(() => fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]))
  const nested = yield* Effect.forEach(
    entries,
    (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return findFiles(full, filter)
      return Effect.succeed(filter(full) ? [full] : [])
    },
    { concurrency: "unbounded" },
  )
  return nested.flat()
}) as never

const readJson = Effect.fn("ClaudeCompat.readJson")(function* (file: string) {
  return yield* Effect.tryPromise({
    try: () => Bun.file(file).json(),
    catch: (error) => error,
  })
})

const readOptionalJson = Effect.fn("ClaudeCompat.readOptionalJson")(function* (
  file: string,
  diagnostics: string[],
  label: string,
) {
  return yield* readJson(file).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        diagnostics.push(`Skipped ${label} "${file}" because ${errorMessage(error)}`)
        return undefined
      }),
    ),
  )
})

const exists = Effect.fn("ClaudeCompat.exists")(function* (file: string) {
  return yield* Effect.promise(() =>
    fs
      .stat(file)
      .then(() => true)
      .catch(() => false),
  )
})

const stat = Effect.fn("ClaudeCompat.stat")(function* (file: string) {
  return yield* Effect.promise(() => fs.stat(file))
})

function resolvePluginPath(root: string, item: string) {
  const resolved = path.resolve(root, item.replace(/^\.\//, ""))
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    throw new Error(`Claude plugin path escapes root: ${item}`)
  return resolved
}

function pathName(base: string, item: string, ext?: string) {
  const target = ext && item.endsWith(ext) ? item.slice(0, -ext.length) : item
  const relative = path.relative(base, target)
  return relative.split(path.sep).filter(Boolean).join(":")
}

function firstLine(input: string) {
  return input
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean)
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function substituteStatic(input: string, root: string) {
  return input.replaceAll("${CLAUDE_PLUGIN_ROOT}", root)
}

function modelRef(input: string | undefined) {
  if (!input || input === "inherit") return
  const index = input.indexOf("/")
  if (index <= 0 || index === input.length - 1) return
  return { providerID: input.slice(0, index), modelID: input.slice(index + 1) }
}

function modelValue(input: unknown) {
  if (typeof input === "string" && input.trim()) return input.trim()
  if (isRecord(input) && typeof input.providerID === "string" && typeof input.modelID === "string") {
    return { providerID: input.providerID, modelID: input.modelID }
  }
}

function text(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function numberValue(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function positiveInt(input: unknown) {
  return typeof input === "number" && Number.isInteger(input) && input > 0 ? input : undefined
}

function booleanValue(input: unknown) {
  if (input === true || input === "true") return true
  if (input === false || input === "false") return false
}

function toolList(input: unknown) {
  if (Array.isArray(input))
    return input.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim())
  if (typeof input === "string")
    return input
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
}

function issues(input: Array<{ path: PropertyKey[]; message: string }>) {
  return input.map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`).join("; ")
}

function commandAgent(pluginName: string, agents: Record<string, RuntimeAgent>, agent: string | undefined) {
  if (!agent) return {}
  if (agents[agent]) return { agent }
  const namespaced = namespace(pluginName, agent)
  if (agents[namespaced]) return { agent: namespaced }
  return { agent }
}

function invalidRuntimePlugin(message: string) {
  const error = new Error(message)
  error.name = "InvalidRuntimePluginError"
  return error
}

function objectValue(input: unknown) {
  return isRecord(input) ? input : undefined
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function dedupeMarkdownPaths(items: MarkdownPath[]) {
  return Array.from(new Map(items.map((item) => [item.file, item])).values())
}

function namespace(pluginName: string, name: string) {
  return `${pluginName}:${name}`
}

function namespaceMcp(pluginName: string, name: string) {
  return `plugin:${pluginName}:${name}`
}

export * as ClaudeCompat from "./claude-compat"

import { sdkError } from "../errors.js"
import type {
  AgentDefinition,
  ClaudePluginSpec,
  CommandDefinition,
  HookCallback,
  HookEntry,
  HookEventName,
  HookRegistration,
  InlinePluginSpec,
  SdkMcpServer,
  SkillDefinition,
  ToolDefinition,
  OutputFormatSpec,
  McpResourceDefinition,
  McpPromptDefinition,
} from "../types.js"
import { parseModel, normalizeLocalMcpServer } from "../internal/runtime-config.js"
import { normalizeToolRules } from "./permission-rules.js"
import { z } from "zod"

function requireNonEmptyString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw sdkError("configuration", `${label} must be a non-empty string`)
}

function requireOptionalBoolean(value: unknown, label: string) {
  if (value !== undefined && typeof value !== "boolean") throw sdkError("configuration", `${label} must be a boolean`)
}

function requireOptionalPositiveNumber(value: unknown, label: string) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
    throw sdkError("configuration", `${label} must be a positive number`)
  }
}

function requireOptionalStringRecord(value: unknown, label: string) {
  if (value === undefined) return
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw sdkError("configuration", `${label} must be an object`)
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw sdkError("configuration", `${label}.${key} must be a string`)
  }
}

function isZodSchema(input: unknown): input is z.ZodType {
  return !!input && typeof input === "object" && "safeParse" in input
}

/**
 * Define a custom tool executed in the SDK process.
 * The schema describes model-facing input. Validate untrusted invocation input
 * inside `execute` before side effects; schema parsing is not automatic.
 * @param def - Named tool, input schema, and execution callback.
 * @returns The definition after registration checks, preserving its input/output types.
 * @throws A configuration error for missing name, callback, or input schema.
 * @example
 * ```ts
 * const input = z.object({ text: z.string() })
 * const echo = defineTool<unknown, string>({
 *   name: "echo", inputSchema: input,
 *   execute: (value) => input.parse(value).text,
 * })
 * ```
 */
export function defineTool<Input = unknown, Output = unknown>(
  def: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  if (!def.name) throw sdkError("configuration", "defineTool: `name` is required")
  if (typeof def.execute !== "function") throw sdkError("configuration", "defineTool: `execute` must be a function")
  if (def.inputSchema === undefined && def.inputJsonSchema === undefined) {
    throw sdkError("configuration", "defineTool: `inputSchema` or `inputJsonSchema` is required")
  }
  return def
}

/**
 * Create a structured-output contract from Zod or JSON Schema.
 * @param schema - Shape that valid model output must satisfy.
 * @param options - Optional bounded retry count.
 * @returns A serializable JSON Schema format with an inferred output type.
 * @throws Invalid schema or retry count.
 * @example
 * ```ts
 * const format = defineOutputFormat(z.object({ summary: z.string() }), { maxRetries: 2 })
 * ```
 */
export function defineOutputFormat<Schema extends z.ZodType>(
  schema: Schema,
  options?: { maxRetries?: number },
): OutputFormatSpec<z.output<Schema>>
/**
 * Create a structured-output contract from Zod or JSON Schema.
 * @param schema - Shape that valid model output must satisfy.
 * @param options - Optional bounded retry count.
 * @returns A serializable JSON Schema format with an inferred output type.
 * @throws Invalid schema or retry count.
 * @example
 * ```ts
 * const format = defineOutputFormat(z.object({ summary: z.string() }), { maxRetries: 2 })
 * ```
 */
export function defineOutputFormat<Output = unknown>(
  schema: Record<string, unknown>,
  options?: { maxRetries?: number },
): OutputFormatSpec<Output>
/**
 * Create a structured-output contract from Zod or JSON Schema.
 * @param schema - Shape that valid model output must satisfy.
 * @param options - Optional bounded retry count.
 * @returns A serializable JSON Schema format with an inferred output type.
 * @throws Invalid schema or retry count.
 * @example
 * ```ts
 * const format = defineOutputFormat(z.object({ summary: z.string() }), { maxRetries: 2 })
 * ```
 */
export function defineOutputFormat(
  schema: z.ZodType | Record<string, unknown>,
  options?: { maxRetries?: number },
): OutputFormatSpec {
  if (options?.maxRetries !== undefined && (!Number.isInteger(options.maxRetries) || options.maxRetries < 0)) {
    throw sdkError("configuration", "defineOutputFormat: `maxRetries` must be a non-negative integer")
  }
  if (!isZodSchema(schema) && (!schema || typeof schema !== "object" || Array.isArray(schema))) {
    throw sdkError("configuration", "defineOutputFormat: `schema` must be a JSON Schema object or Zod schema")
  }
  return {
    type: "json_schema",
    schema: isZodSchema(schema) ? z.toJSONSchema(schema) : schema,
    ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  }
}

/**
 * Bundle tools and optional HTTP MCP resources/prompts into a session-owned descriptor.
 * @param opts - Unique server name, content definitions and transport policy.
 * @returns A descriptor; hosting starts when a session registers it.
 * @throws A configuration error for duplicate names/URIs, invalid content, or resources/prompts with direct transport.
 * @example
 * ```ts
 * const server = createSdkMcpServer({ name: "local", transport: "direct", tools: [] })
 * ```
 */
export function createSdkMcpServer(opts: {
  name: string
  transport?: "http" | "direct"
  enabled?: boolean
  timeout?: number
  tools: ToolDefinition[]
  resources?: McpResourceDefinition[]
  prompts?: McpPromptDefinition[]
}): SdkMcpServer {
  requireNonEmptyString(opts.name, "createSdkMcpServer: `name`")
  if (opts.transport !== undefined && opts.transport !== "http" && opts.transport !== "direct") {
    throw sdkError("configuration", 'createSdkMcpServer: `transport` must be "http" or "direct"')
  }
  requireOptionalBoolean(opts.enabled, "createSdkMcpServer: `enabled`")
  requireOptionalPositiveNumber(opts.timeout, "createSdkMcpServer: `timeout`")
  if (!Array.isArray(opts.tools)) throw sdkError("configuration", "createSdkMcpServer: `tools` must be an array")
  validateMcpContent(opts)
  const names = new Set<string>()
  for (const tool of opts.tools) {
    requireNonEmptyString(tool.name, "createSdkMcpServer: tool `name`")
    if (typeof tool.execute !== "function")
      throw sdkError("configuration", `createSdkMcpServer: tool "${tool.name}" execute must be a function`)
    if (tool.inputSchema === undefined && tool.inputJsonSchema === undefined) {
      throw sdkError("configuration", `createSdkMcpServer: tool "${tool.name}" requires inputSchema or inputJsonSchema`)
    }
    if (names.has(tool.name)) throw sdkError("configuration", `createSdkMcpServer: duplicate tool "${tool.name}"`)
    names.add(tool.name)
  }
  return {
    name: opts.name,
    transport: opts.transport,
    enabled: opts.enabled,
    timeout: opts.timeout,
    tools: opts.tools,
    resources: opts.resources,
    prompts: opts.prompts,
  }
}

/** @internal Validate hosted content at definition time before allocating a server. */
export function validateMcpContent(opts: Pick<SdkMcpServer, "transport" | "resources" | "prompts">): void {
  if (opts.transport === "direct" && (opts.resources?.length || opts.prompts?.length)) {
    throw sdkError("configuration", 'createSdkMcpServer: resources/prompts require transport "http"')
  }
  for (const field of ["resources", "prompts"] as const) {
    if (opts[field] !== undefined && !Array.isArray(opts[field]))
      throw sdkError("configuration", `createSdkMcpServer: ${field} must be an array`)
    const names = new Set<string>()
    for (const item of opts[field] ?? []) {
      requireNonEmptyString(item.name, `createSdkMcpServer: ${field}.name`)
      if (names.has(item.name))
        throw sdkError("configuration", `createSdkMcpServer: duplicate ${field} name "${item.name}"`)
      names.add(item.name)
    }
  }
  const uris = new Set<string>()
  for (const resource of opts.resources ?? []) {
    requireNonEmptyString(resource.uri, "createSdkMcpServer: resources.uri")
    if (typeof resource.read !== "function")
      throw sdkError("configuration", "createSdkMcpServer: resources.read must be a function")
    if (uris.has(resource.uri))
      throw sdkError("configuration", `createSdkMcpServer: duplicate resources URI "${resource.uri}"`)
    uris.add(resource.uri)
  }
  for (const prompt of opts.prompts ?? []) {
    if (typeof prompt.get !== "function")
      throw sdkError("configuration", "createSdkMcpServer: prompts.get must be a function")
    const arguments_ = new Set<string>()
    for (const argument of prompt.arguments ?? []) {
      requireNonEmptyString(argument.name, "createSdkMcpServer: prompts.arguments.name")
      requireOptionalBoolean(argument.required, "createSdkMcpServer: prompts.arguments.required")
      if (arguments_.has(argument.name))
        throw sdkError("configuration", `createSdkMcpServer: duplicate prompt argument "${argument.name}"`)
      arguments_.add(argument.name)
    }
  }
}

/**
 * Validate a session-scoped helper or subagent definition while preserving its type.
 * @param def - Prompt, model, tools and child-session policy.
 * @returns The validated definition.
 * @throws A configuration error for invalid prompt, model, tool rules, or MCP descriptors.
 * @example
 * ```ts
 * const reviewer = defineAgent({ prompt: "Review correctness.", tools: ["read", "grep"], spawnMode: "fresh" })
 * ```
 */
export function defineAgent<T extends AgentDefinition>(def: T): T {
  if (!def.prompt?.trim()) throw sdkError("configuration", "defineAgent: `prompt` is required")
  if (def.model !== undefined) parseModel(def.model)
  if (def.tools !== undefined) normalizeToolRules(def.tools, "agents.tools")
  if (def.disallowedTools !== undefined) normalizeToolRules(def.disallowedTools, "agents.disallowedTools")
  if (
    def.permissionMode !== undefined &&
    !["default", "acceptEdits", "dontAsk", "plan", "bypassPermissions", "auto"].includes(def.permissionMode)
  ) {
    throw sdkError("configuration", "defineAgent: `permissionMode` is invalid")
  }
  if (def.steps !== undefined && (!Number.isInteger(def.steps) || def.steps <= 0)) {
    throw sdkError("configuration", "defineAgent: `steps` must be a positive integer")
  }
  if (def.spawnMode !== undefined && def.spawnMode !== "fresh" && def.spawnMode !== "inherit") {
    throw sdkError("configuration", 'defineAgent: `spawnMode` must be "fresh" or "inherit"')
  }
  if (def.mcpServers !== undefined && !Array.isArray(def.mcpServers)) {
    throw sdkError("configuration", "defineAgent: `mcpServers` must be an array")
  }
  for (const server of def.mcpServers ?? []) {
    if (server.type === "local") {
      normalizeLocalMcpServer(server, "defineAgent.mcpServers")
      continue
    }
    if (server.type !== "remote")
      throw sdkError("configuration", "defineAgent: mcpServers only supports local or remote servers")
    if (!server.name) throw sdkError("configuration", "defineAgent: remote mcp server `name` is required")
    if (!server.url) throw sdkError("configuration", `defineAgent: remote mcp server "${server.name}" url is required`)
    try {
      new URL(server.url)
    } catch {
      throw sdkError("configuration", `defineAgent: remote mcp server "${server.name}" url must be valid`)
    }
  }
  return def
}

/**
 * Validate and preserve a programmatic skill definition.
 * @param def - Skill name, description, content and optional runtime constraints.
 * @returns The same definition with inferred literal types.
 * @throws Invalid required fields or model/tool policy.
 * @example
 * ```ts
 * const definition = defineSkill({ name: "style", description: "Plain writing", content: "Use clear words." })
 * ```
 */
export function defineSkill<T extends SkillDefinition>(def: T): T {
  requireNonEmptyString(def.name, "defineSkill: `name`")
  requireNonEmptyString(def.description, "defineSkill: `description`")
  requireNonEmptyString(def.content, "defineSkill: `content`")
  if (def.model !== undefined && typeof def.model === "string") parseModel(def.model)
  if (def.allowedTools !== undefined) normalizeToolRules(def.allowedTools, "skill.allowedTools")
  requireOptionalBoolean(def.disableModelInvocation, "defineSkill: `disableModelInvocation`")
  return def
}

/**
 * Validate a programmatic slash-command definition.
 * @param def - Named template and optional model/agent/tool policy.
 * @returns The validated definition.
 * @throws Invalid command fields.
 * @example
 * ```ts
 * const definition = defineCommand({ name: "review", template: "Review $ARGUMENTS" })
 * ```
 */
export function defineCommand<T extends CommandDefinition>(def: T): T {
  requireNonEmptyString(def.name, "defineCommand: `name`")
  requireNonEmptyString(def.template, "defineCommand: `template`")
  if (def.model !== undefined) parseModel(def.model)
  if (def.allowedTools !== undefined) normalizeToolRules(def.allowedTools, "command.allowedTools")
  if (def.disallowedTools !== undefined) normalizeToolRules(def.disallowedTools, "command.disallowedTools")
  requireOptionalBoolean(def.subtask, "defineCommand: `subtask`")
  return def
}

/**
 * Validate and normalize an inline session plugin.
 * @param spec - Named bundle of capabilities.
 * @returns An inline plugin descriptor.
 * @throws Invalid or conflicting component definitions.
 * @example
 * ```ts
 * const definition = definePlugin({ name: "editorial", skills: [skill] })
 * ```
 */
export function definePlugin<T extends Omit<InlinePluginSpec, "type"> | InlinePluginSpec>(spec: T): InlinePluginSpec {
  if ("type" in spec && spec.type !== "inline") throw sdkError("configuration", 'definePlugin: `type` must be "inline"')
  const plugin = { ...spec, type: "inline" as const }
  requireNonEmptyString(plugin.name, "definePlugin: `name`")
  plugin.skills?.forEach(defineSkill)
  plugin.commands?.forEach(defineCommand)
  if (plugin.agents) Object.values(plugin.agents).forEach(defineAgent)
  if (plugin.mcpServers !== undefined && !Array.isArray(plugin.mcpServers)) {
    throw sdkError("configuration", "definePlugin: `mcpServers` must be an array")
  }
  for (const server of plugin.mcpServers ?? []) {
    if (server.type === "local") {
      normalizeLocalMcpServer(server, "definePlugin.mcpServers")
      continue
    }
    if (server.type === "remote") {
      requireNonEmptyString(server.name, "definePlugin: remote mcp server `name`")
      requireNonEmptyString(server.url, `definePlugin: remote mcp server "${server.name}" url`)
      try {
        new URL(server.url)
      } catch {
        throw sdkError("configuration", `definePlugin: remote mcp server "${server.name}" url must be valid`)
      }
      requireOptionalBoolean(server.enabled, `definePlugin: remote mcp server "${server.name}" enabled`)
      requireOptionalPositiveNumber(server.timeout, `definePlugin: remote mcp server "${server.name}" timeout`)
      requireOptionalStringRecord(server.headers, `definePlugin: remote mcp server "${server.name}" headers`)
      if (server.oauth !== undefined && server.oauth !== false) {
        throw sdkError("configuration", `definePlugin: remote mcp server "${server.name}" oauth must be false`)
      }
      continue
    }
    if (server.type !== undefined && server.type !== "sdk") {
      throw sdkError("configuration", 'definePlugin: `mcpServers` entries must use type "sdk" or "remote"')
    }
    if (server.transport !== "direct") {
      throw sdkError("configuration", 'definePlugin: SDK mcp servers must use transport "direct"')
    }
    createSdkMcpServer(server)
  }
  return plugin
}

/**
 * Describe a local Claude-compatible plugin directory.
 * @param path - Path resolved by the runtime host.
 * @returns A compatible-plugin descriptor.
 * @throws An empty path.
 * @example
 * ```ts
 * const definition = claudeCompat("/srv/plugins/reviewer")
 * ```
 */
export function claudeCompat(path: string): ClaudePluginSpec {
  requireNonEmptyString(path, "claudeCompat: `path`")
  return { type: "claude", path }
}

/**
 * Build a single hook registration entry. Plumbed into a session's
 * `runtimeConfig.hooks` at create time and dispatched through the control channel.
 */
export function defineHook<Event extends HookEventName>(
  event: Event,
  callback: HookCallback<Event>,
): Partial<HookRegistration>
export function defineHook<Event extends HookEventName>(
  event: Event,
  callback: HookCallback<Event>,
  options: Omit<HookEntry<Event>, "callback" | "matcher">,
): Partial<HookRegistration>
export function defineHook<Event extends HookEventName>(
  event: Event,
  matcher: string | RegExp,
  callback: HookCallback<Event>,
  options?: Omit<HookEntry<Event>, "callback" | "matcher">,
): Partial<HookRegistration>
export function defineHook<Event extends HookEventName>(
  event: Event,
  matcherOrCallback: string | RegExp | HookCallback<Event>,
  maybeCallback?: HookCallback<Event> | Omit<HookEntry<Event>, "callback" | "matcher">,
  maybeOptions?: Omit<HookEntry<Event>, "callback" | "matcher">,
): Partial<HookRegistration> {
  const options = typeof matcherOrCallback === "function" ? maybeCallback : maybeOptions
  const entry: HookEntry<Event> =
    typeof matcherOrCallback === "function"
      ? { ...(options && typeof options === "object" ? options : {}), callback: matcherOrCallback }
      : { ...(maybeOptions ?? {}), matcher: matcherOrCallback, callback: maybeCallback as HookCallback<Event> }
  if (typeof entry.callback !== "function") {
    throw sdkError("configuration", `defineHook(${event}): callback is required`)
  }
  return { [event]: [entry] } as Partial<HookRegistration>
}

import { sdkError } from "../errors.js"
import type { CognitioConfig } from "../types.js"
import type {
  ClientOptions,
  ControlOptions,
  PromptInput,
  PromptTurn,
  RuntimeConfig,
  SessionCreateOptions,
  SpawnOptions,
  ToolDefinition,
  SdkMcpServer,
} from "../types.js"
import type { AgentClient } from "../client.js"
import { assertSupportedRuntimeConfig } from "./runtime-config.js"
import { createSdkMcpServer } from "../tools/index.js"

/**
 * Recursively freeze a facade default so the process-global constants cannot be
 * corrupted through a resolved profile. `mergeFacadeSpawn` allocates fresh
 * objects for the levels it merges but shares the leaves it does not touch, and
 * the canonical client is created straight from `FACADE_DEFAULT_SPAWN` — so one
 * stray mutation would otherwise change every later Agent in the process.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  Object.values(value as Record<string, unknown>).forEach(deepFreeze)
  return Object.freeze(value)
}

/** Default local-server profile used only by the high-level facade. */
export const FACADE_DEFAULT_SPAWN: SpawnOptions = deepFreeze({
  isolated: true,
  hostname: "127.0.0.1",
  port: 0,
  timeout: 30_000,
  autoCleanup: true,
  config: {
    lsp: false,
    formatter: false,
    agent: {
      title: {
        disable: true,
      },
    },
  },
})

/** Headless tools hidden by default by the high-level facade. */
export const FACADE_DEFAULT_DISALLOWED_TOOLS = deepFreeze(["question", "todowrite", "skill"])

/** Name of the direct SDK MCP server that wraps `AgentOptions.tools`. */
export const FACADE_TOOLS_SERVER_NAME = "sdk"

export const RUNTIME_CONFIG_KEYS = [
  "systemPrompt",
  "instructions",
  "appendSystemPrompt",
  "model",
  "effort",
  "thinkingConfig",
  "maxTurns",
  "maxBudgetUsd",
  "permissionMode",
  "autoPermissionClassifierModel",
  "allowedTools",
  "disallowedTools",
  "settingSources",
  "agents",
  "skills",
  "commands",
  "plugins",
  "hooks",
  "canUseTool",
  "sdkMcpServers",
  "enableToolSearch",
  "enableFileCheckpointing",
  "outputFormat",
  "backgroundTaskPolicy",
  "checkpointing",
  "compaction",
  "includeEnvironment",
] as const satisfies readonly (keyof RuntimeConfig)[]

/**
 * Compile-time guard, both directions. `satisfies` only proves every listed key
 * exists on `RuntimeConfig`; this proves the reverse. `resolveAgentProfile`
 * copies caller options key by key from this list, so a field added to
 * `RuntimeConfig` and forgotten here would be accepted by `AgentOptions` and
 * then silently dropped — no compile error, no test failure. Adding the field
 * above is the fix; there is no way to suppress this.
 */
type AssertNever<T extends never> = T
type _RuntimeConfigKeysAreExhaustive = AssertNever<Exclude<keyof RuntimeConfig, (typeof RUNTIME_CONFIG_KEYS)[number]>>

export interface AgentProfileInput extends RuntimeConfig {
  tools?: ToolDefinition[]
  cwd?: string
  directory?: string
  title?: string
  permission?: SessionCreateOptions["permission"]
  baseUrl?: string
  headers?: Record<string, string>
  spawn?: SpawnOptions
  client?: AgentClient
  control?: ControlOptions
  workspaceId?: string
}

export type AgentConnection =
  | { kind: "canonical" }
  | { kind: "dedicated"; options: ClientOptions }
  | { kind: "injected"; client: AgentClient }

export interface ResolvedAgentProfile {
  connection: AgentConnection
  create: SessionCreateOptions
  providedRuntimeKeys: (keyof RuntimeConfig)[]
  providedCreateKeys: string[]
}

/** Derive a stable non-default server-session title from a prompt. */
export function deriveAgentTitle(prompt: PromptInput | undefined): string {
  const text =
    typeof prompt === "string" ? prompt : prompt && !isAsyncIterable(prompt) ? (prompt as PromptTurn).text : undefined
  const title = text?.split(/\r?\n/, 1)[0].trim().replace(/\s+/g, " ").slice(0, 80) || "Agent session"
  if (!/^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)) {
    return title
  }
  return `${title} (Agent)`
}

/**
 * Resolve and validate the facade's process and per-session defaults without
 * creating a client or touching the network.
 *
 * @param options - Constructor-level facade options.
 * @returns A validated connection decision and session-create profile.
 * @throws When mutually exclusive connection options or colliding tools are supplied.
 */
export function resolveAgentProfile(options?: AgentProfileInput): ResolvedAgentProfile {
  if (options?.headers !== undefined && options.baseUrl === undefined) {
    throw sdkError("configuration", 'Agent option "headers" requires "baseUrl"')
  }
  if (options?.cwd !== undefined && options.directory !== undefined && options.cwd !== options.directory) {
    throw sdkError("configuration", 'Agent options "cwd" and "directory" must match when both are provided')
  }
  if (options?.baseUrl !== undefined && !options.baseUrl.trim()) {
    throw sdkError("configuration", 'Agent option "baseUrl" must be a non-empty URL')
  }
  if (options?.baseUrl !== undefined && options.spawn !== undefined) {
    throw sdkError("configuration", 'Agent options "baseUrl" and "spawn" cannot be combined')
  }
  if (
    options?.client !== undefined &&
    [options.baseUrl, options.headers, options.spawn, options.control, options.workspaceId].some(
      (value) => value !== undefined,
    )
  ) {
    throw sdkError(
      "configuration",
      'Agent option "client" cannot be combined with baseUrl, spawn, control, or workspaceId',
    )
  }

  const runtimeConfig = Object.fromEntries(
    RUNTIME_CONFIG_KEYS.flatMap((key) =>
      options?.[key] === undefined
        ? []
        : ([[key, options[key]]] as [keyof RuntimeConfig, RuntimeConfig[keyof RuntimeConfig]][]),
    ),
  ) as RuntimeConfig

  if (runtimeConfig.settingSources === undefined) runtimeConfig.settingSources = []
  if (runtimeConfig.disallowedTools === undefined && runtimeConfig.allowedTools === undefined) {
    runtimeConfig.disallowedTools = [...FACADE_DEFAULT_DISALLOWED_TOOLS]
  }

  // Validated twice on purpose, and both calls matter. Here, so a bad caller
  // field fails by its own name before the tools machinery can turn it into a
  // confusing collision error; again after wrapping, to validate the injected
  // `sdk` server itself.
  assertSupportedRuntimeConfig(runtimeConfig)
  if (options?.tools !== undefined && !Array.isArray(options.tools)) {
    throw sdkError("configuration", 'Agent option "tools" must be an array')
  }
  if (options?.tools?.length) {
    const existing = runtimeConfig.sdkMcpServers ?? []
    if (existing.some((server) => server.name === FACADE_TOOLS_SERVER_NAME)) {
      throw sdkError(
        "configuration",
        `Agent tools cannot be combined with an SDK MCP server named "${FACADE_TOOLS_SERVER_NAME}"`,
      )
    }
    runtimeConfig.sdkMcpServers = [
      ...existing,
      createSdkMcpServer({
        name: FACADE_TOOLS_SERVER_NAME,
        transport: "direct",
        tools: options.tools,
      }),
    ]
    assertFacadeToolNamespaceSafety(runtimeConfig, options.spawn?.config?.mcp)
  }

  assertVisibleToolNames(runtimeConfig)
  assertSupportedRuntimeConfig(runtimeConfig)

  const connection =
    options?.client !== undefined
      ? ({ kind: "injected", client: options.client } as const)
      : [options?.baseUrl, options?.spawn, options?.control, options?.workspaceId].some((value) => value !== undefined)
        ? ({
            kind: "dedicated",
            options: {
              ...(options?.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
              ...(options?.headers !== undefined ? { headers: options.headers } : {}),
              ...(options?.baseUrl === undefined ? { spawn: mergeFacadeSpawn(options?.spawn) } : {}),
              ...(options?.control !== undefined ? { control: options.control } : {}),
              ...(options?.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
            },
          } as const)
        : ({ kind: "canonical" } as const)

  return {
    connection,
    create: {
      ...(options?.cwd !== undefined || options?.directory !== undefined
        ? { cwd: options.cwd ?? options.directory }
        : {}),
      ...(options?.title !== undefined ? { title: options.title } : {}),
      ...(options?.permission !== undefined ? { permission: options.permission } : {}),
      runtimeConfig,
    },
    providedRuntimeKeys: RUNTIME_CONFIG_KEYS.filter((key) => options?.[key] !== undefined),
    providedCreateKeys: [
      ...["tools", "cwd", "directory", "title", "permission"].filter(
        (key) => options?.[key as keyof AgentProfileInput] !== undefined,
      ),
    ],
  }
}

function mergeFacadeSpawn(override: SpawnOptions | undefined): SpawnOptions {
  const config = mergeDefined(
    FACADE_DEFAULT_SPAWN.config as Record<string, unknown>,
    override?.config as Record<string, unknown> | undefined,
  ) as CognitioConfig
  // `config.agent` is merged by agent name so overriding one agent cannot
  // silently restore the title agent — and with it the hidden per-session
  // title LLM call. Each named agent object itself replaces wholesale, so
  // naming `title` at all means the caller owns its definition, `disable`
  // included.
  const defaultsAgent = FACADE_DEFAULT_SPAWN.config?.agent
  const overrideAgent = override?.config?.agent
  if (defaultsAgent !== undefined || overrideAgent !== undefined) {
    config.agent = mergeDefined(
      defaultsAgent as Record<string, unknown> | undefined,
      overrideAgent as Record<string, unknown> | undefined,
    ) as NonNullable<CognitioConfig["agent"]>
  }
  return {
    ...FACADE_DEFAULT_SPAWN,
    ...definedObject(override),
    config,
  }
}

function definedObject<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {}
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

function mergeDefined(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...definedObject(base),
    ...definedObject(override),
  }
}

function assertVisibleToolNames(runtimeConfig: RuntimeConfig): void {
  const visible = new Map<string, string>()
  const servers = [
    ...(runtimeConfig.sdkMcpServers?.filter(
      (server): server is SdkMcpServer => server.type === undefined || server.type === "sdk",
    ) ?? []),
    ...(runtimeConfig.plugins?.flatMap((plugin) =>
      plugin.type !== "inline"
        ? []
        : (plugin.mcpServers ?? [])
            .filter((server): server is SdkMcpServer => server.type === undefined || server.type === "sdk")
            .map((server) => ({ ...server, name: `plugin:${plugin.name}:${server.name}` })),
    ) ?? []),
  ]
  servers
    .flatMap((server) => server.tools.map((tool) => [server, tool] as const))
    .forEach(([server, tool]) => {
      const name = `${sanitizeToolName(server.name)}_${sanitizeToolName(tool.name)}`
      const existing = visible.get(name)
      if (existing !== undefined) {
        throw sdkError(
          "configuration",
          `Agent SDK tools "${existing}" and "${server.name}/${tool.name}" both resolve to "${name}"`,
        )
      }
      visible.set(name, `${server.name}/${tool.name}`)
    })
}

function assertFacadeToolNamespaceSafety(
  runtimeConfig: RuntimeConfig,
  configuredMcp: CognitioConfig["mcp"] | undefined,
): void {
  const unsafe = [
    ...(runtimeConfig.sdkMcpServers?.map((server) => server.name).filter((name) => name !== FACADE_TOOLS_SERVER_NAME) ??
      []),
    ...Object.keys(configuredMcp ?? {}),
  ].find((name) => {
    const sanitized = sanitizeToolName(name)
    return sanitized === FACADE_TOOLS_SERVER_NAME || sanitized.startsWith(`${FACADE_TOOLS_SERVER_NAME}_`)
  })
  if (unsafe === undefined) return
  throw sdkError(
    "configuration",
    `MCP server "${unsafe}" can collide with model-visible Agent tool names in the "${FACADE_TOOLS_SERVER_NAME}" namespace`,
  )
}

function sanitizeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  )
}

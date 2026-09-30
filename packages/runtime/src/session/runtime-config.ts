import { InstanceState } from "@/effect"
import { PermissionRuleSyntax } from "@/permission/rule-syntax"
import { Effect, Layer, Context } from "effect"
import z from "zod"
import { SessionID } from "./schema"
import { OutputFormatJsonSchema } from "./output-format"

export const PermissionMode = z
  .enum(["default", "acceptEdits", "dontAsk", "plan", "bypassPermissions", "auto"])
  .meta({ ref: "RuntimeConfigPermissionMode" })
export type PermissionMode = z.infer<typeof PermissionMode>

export const HookEventName = z
  .enum([
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "SessionStart",
    "SessionEnd",
    "SessionStateChange",
    "BeforeShellExecution",
    "AfterShellExecution",
    "PermissionAsked",
    "PermissionReplied",
  ])
  .meta({ ref: "RuntimeConfigHookEventName" })
export type HookEventName = z.infer<typeof HookEventName>

export const HookDescriptor = z
  .object({
    id: z.string().min(1),
    matcher: z.string().optional(),
    matcherFlags: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    async: z.boolean().optional(),
  })
  .meta({ ref: "RuntimeConfigHookDescriptor" })
export type HookDescriptor = z.infer<typeof HookDescriptor>

const ToolRules = z.array(z.string()).superRefine((rules, ctx) => {
  rules.forEach((rule, index) => {
    try {
      PermissionRuleSyntax.parse(rule)
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: [index],
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
})

export const RuntimeRemoteMcpServer = z
  .object({
    name: z.string().min(1),
    type: z.literal("remote"),
    url: z.string().url(),
    enabled: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: z.literal(false).optional(),
    timeout: z.number().positive().optional(),
    transport: z.enum(["http", "sse"]).optional(),
    ownership: z.literal("sdk").optional().describe("SDK-owned HTTP host; reattach when forking a session."),
  })
  .meta({ ref: "RuntimeRemoteMcpServer" })
export type RuntimeRemoteMcpServer = z.infer<typeof RuntimeRemoteMcpServer>

export const RuntimeLocalMcpServer = z
  .object({
    name: z.string().min(1),
    type: z.literal("local"),
    command: z.array(z.string().min(1)).min(1),
    environment: z.record(z.string(), z.string()).optional(),
    cwd: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().positive().optional(),
  })
  .meta({ ref: "RuntimeLocalMcpServer" })
export type RuntimeLocalMcpServer = z.infer<typeof RuntimeLocalMcpServer>

export const RuntimeExternalMcpServer = z.discriminatedUnion("type", [RuntimeRemoteMcpServer, RuntimeLocalMcpServer])

export const RuntimeDirectSdkMcpTool = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    metadata: z
      .object({
        searchHint: z.string().optional(),
        alwaysLoad: z.boolean().optional(),
      })
      .optional(),
    annotations: z
      .object({
        readOnly: z.boolean().optional(),
        destructive: z.boolean().optional(),
        idempotent: z.boolean().optional(),
        openWorld: z.boolean().optional(),
      })
      .optional(),
  })
  .meta({ ref: "RuntimeDirectSdkMcpTool" })
export type RuntimeDirectSdkMcpTool = z.infer<typeof RuntimeDirectSdkMcpTool>

export const RuntimeDirectSdkMcpServer = z
  .object({
    name: z.string().min(1),
    type: z.literal("sdk"),
    transport: z.literal("direct"),
    enabled: z.boolean().optional(),
    timeout: z.number().positive().optional(),
    tools: z.array(RuntimeDirectSdkMcpTool),
  })
  .meta({ ref: "RuntimeDirectSdkMcpServer" })
export type RuntimeDirectSdkMcpServer = z.infer<typeof RuntimeDirectSdkMcpServer>

export const RuntimeMcpServer = z
  .discriminatedUnion("type", [RuntimeRemoteMcpServer, RuntimeLocalMcpServer, RuntimeDirectSdkMcpServer])
  .meta({
    ref: "RuntimeMcpServer",
  })
export type RuntimeMcpServer = z.infer<typeof RuntimeMcpServer>

export const RuntimeAgentDefinition = z
  .object({
    prompt: z.string().min(1),
    description: z.string().optional(),
    model: z
      .object({
        providerID: z.string().min(1),
        modelID: z.string().min(1),
      })
      .optional(),
    tools: ToolRules.optional(),
    disallowedTools: ToolRules.optional(),
    permissionMode: PermissionMode.optional(),
    mcpServers: z.array(RuntimeExternalMcpServer).optional(),
    steps: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    spawnMode: z.enum(["fresh", "inherit"]).optional(),
  })
  .meta({ ref: "RuntimeAgentDefinition" })
export type RuntimeAgentDefinition = z.infer<typeof RuntimeAgentDefinition>

const RuntimeModelRef = z.object({
  providerID: nonEmptyString(),
  modelID: nonEmptyString(),
})

const RuntimeSkillModel = z.union([nonEmptyString(), RuntimeModelRef])

export const RuntimeSkillDefinition = z
  .object({
    name: nonEmptyString(),
    description: nonEmptyString(),
    content: nonEmptyString(),
    baseDir: nonEmptyString().optional(),
    allowedTools: ToolRules.optional(),
    model: RuntimeSkillModel.optional(),
    disableModelInvocation: z.boolean().optional(),
  })
  .meta({ ref: "RuntimeSkillDefinition" })
export type RuntimeSkillDefinition = z.infer<typeof RuntimeSkillDefinition>

export const RuntimeCommandDefinition = z
  .object({
    name: nonEmptyString(),
    description: z.string().optional(),
    template: nonEmptyString(),
    agent: nonEmptyString().optional(),
    model: nonEmptyString().optional(),
    subtask: z.boolean().optional(),
    allowedTools: ToolRules.optional(),
    disallowedTools: ToolRules.optional(),
  })
  .meta({ ref: "RuntimeCommandDefinition" })
export type RuntimeCommandDefinition = z.infer<typeof RuntimeCommandDefinition>

export const RuntimeInlinePlugin = z
  .object({
    type: z.literal("inline"),
    name: nonEmptyString(),
    description: z.string().optional(),
    version: z.string().optional(),
    skills: z.array(RuntimeSkillDefinition).optional(),
    commands: z.array(RuntimeCommandDefinition).optional(),
    agents: z.record(nonEmptyString(), RuntimeAgentDefinition).optional(),
    hooks: z.partialRecord(HookEventName, z.array(HookDescriptor)).optional(),
    mcpServers: z.array(RuntimeMcpServer).optional(),
  })
  .meta({ ref: "RuntimeInlinePlugin" })
export type RuntimeInlinePlugin = z.infer<typeof RuntimeInlinePlugin>

export const RuntimeClaudePlugin = z
  .object({
    type: z.literal("claude"),
    path: nonEmptyString(),
  })
  .meta({ ref: "RuntimeClaudePlugin" })
export type RuntimeClaudePlugin = z.infer<typeof RuntimeClaudePlugin>

export const RuntimePluginSpec = z.discriminatedUnion("type", [RuntimeInlinePlugin, RuntimeClaudePlugin]).meta({
  ref: "RuntimePluginSpec",
})
export type RuntimePluginSpec = z.infer<typeof RuntimePluginSpec>

function nonEmptyString() {
  return z.string().refine((value) => value.trim().length > 0, "must be a non-empty string")
}

function uniqueNames<T extends { name: string }>(label: string, items: T[] | undefined, ctx: z.RefinementCtx) {
  const seen = new Map<string, number>()
  for (const [index, item] of (items ?? []).entries()) {
    const first = seen.get(item.name)
    if (first === undefined) {
      seen.set(item.name, index)
      continue
    }
    ctx.addIssue({
      code: "custom",
      path: [index, "name"],
      message: `duplicate ${label} name "${item.name}" also appears at index ${first}`,
    })
  }
}

function uniquePlugins(items: RuntimePluginSpec[] | undefined, ctx: z.RefinementCtx) {
  const seen = new Map<string, number>()
  for (const [index, item] of (items ?? []).entries()) {
    const key = item.type === "inline" ? item.name : item.path
    const first = seen.get(key)
    if (first === undefined) {
      seen.set(key, index)
      continue
    }
    ctx.addIssue({
      code: "custom",
      path: [index, item.type === "inline" ? "name" : "path"],
      message: `duplicate plugin ${item.type === "inline" ? "name" : "path"} "${key}" also appears at index ${first}`,
    })
  }
}

export const RuntimeConfig = z
  .object({
    systemPrompt: z
      .union([
        z.string(),
        z.object({
          type: z.literal("preset"),
          preset: z.enum(["default", "none"]),
          append: z.string().optional(),
        }),
      ])
      .optional(),
    appendSystemPrompt: z.string().optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    effort: z.enum(["low", "medium", "high", "max"]).optional(),
    thinkingConfig: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("adaptive") }),
        z.object({ type: z.literal("disabled") }),
        z.object({ type: z.literal("enabled"), budgetTokens: z.number().int().min(1024) }),
      ])
      .optional(),
    compaction: z.object({ auto: z.boolean().optional(), includeFiles: z.boolean().optional() }).optional(),
    includeEnvironment: z.boolean().optional(),
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().optional(),
    permissionMode: PermissionMode.optional(),
    canUseTool: z.boolean().optional(),
    autoPermissionClassifierModel: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    allowedTools: ToolRules.optional(),
    disallowedTools: ToolRules.optional(),
    settingSources: z.array(z.enum(["user", "project", "local"])).optional(),
    agents: z.record(nonEmptyString(), RuntimeAgentDefinition).optional(),
    skills: z.array(RuntimeSkillDefinition).optional(),
    commands: z.array(RuntimeCommandDefinition).optional(),
    plugins: z.array(RuntimePluginSpec).optional(),
    hooks: z.partialRecord(HookEventName, z.array(HookDescriptor)).optional(),
    sdkMcpServers: z.array(RuntimeMcpServer).optional(),
    enableToolSearch: z.union([z.boolean(), z.literal("auto"), z.literal("always"), z.literal("never")]).optional(),
    enableFileCheckpointing: z.boolean().optional(),
    outputFormat: OutputFormatJsonSchema.optional(),
    backgroundTaskPolicy: z
      .object({ mode: z.literal("foreground") })
      .strict()
      .optional(),
    checkpointing: z
      .object({
        enabled: z.boolean().optional(),
        beforeTools: z.boolean().optional(),
        beforeCompaction: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .superRefine((config, ctx) => {
    uniqueNames("skill", config.skills, ctx)
    uniqueNames("command", config.commands, ctx)
    uniquePlugins(config.plugins, ctx)
  })
  .meta({ ref: "RuntimeConfig" })
export type RuntimeConfig = z.infer<typeof RuntimeConfig>
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<RuntimeConfig>
  readonly set: (input: { sessionID: SessionID; config: DeepPartial<RuntimeConfig> }) => Effect.Effect<RuntimeConfig>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@cognitio/SessionRuntimeConfig") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(
      Effect.fn("SessionRuntimeConfig.state")(function* () {
        const data = new Map<SessionID, RuntimeConfig>()
        yield* Effect.addFinalizer(() => Effect.sync(() => data.clear()))
        return data
      }),
    )

    const get = Effect.fn("SessionRuntimeConfig.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID) ?? {}
    })

    const set = Effect.fn("SessionRuntimeConfig.set")(function* (input: {
      sessionID: SessionID
      config: DeepPartial<RuntimeConfig>
    }) {
      const data = yield* InstanceState.get(state)
      const current = data.get(input.sessionID) ?? {}
      const config = Object.fromEntries(
        Object.entries(input.config).filter(([, value]) => value !== undefined),
      ) as RuntimeConfig
      const next = RuntimeConfig.parse({ ...current, ...config })
      data.set(input.sessionID, next)
      return next
    })

    const clear = Effect.fn("SessionRuntimeConfig.clear")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.delete(sessionID)
    })

    return Service.of({ get, set, clear })
  }),
)

export const defaultLayer = layer

export * as SessionRuntimeConfig from "./runtime-config"

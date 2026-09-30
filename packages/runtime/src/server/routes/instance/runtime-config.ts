import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Agent } from "@/agent/agent"
import { AgentRuntime } from "@/agent/runtime"
import { Provider } from "@/provider"
import { MCP } from "@/mcp"
import { Session } from "@/session"
import { SessionRuntimeConfig } from "@/session/runtime-config"
import { SessionID } from "@/session/schema"
import { RuntimeToolRules } from "@/permission/runtime-rules"
import { activeInstructionSources } from "@/session/system-prompt"
import { RuntimePlugin } from "@/plugin/runtime"
import { SkillRuntime } from "@/skill/runtime"
import { CommandRuntime } from "@/command/runtime"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"
import { Option } from "effect"

const RuntimeConfigEffective = SessionRuntimeConfig.RuntimeConfig.pick({
  model: true,
  maxTurns: true,
  maxBudgetUsd: true,
  permissionMode: true,
  autoPermissionClassifierModel: true,
})
  .extend({
    canUseTool: z
      .object({
        registered: z.boolean(),
      })
      .optional(),
    hooks: z.record(z.string(), z.object({ count: z.number().int().nonnegative() })).optional(),
    systemPrompt: z.object({
      mode: z.enum(["default", "custom", "preset"]),
      preset: z.string().optional(),
      hasAppend: z.boolean(),
    }),
    appendSystemPrompt: z
      .object({
        length: z.number().int().nonnegative(),
      })
      .optional(),
    settingSources: z.array(z.enum(["user", "project", "local"])),
    tools: z.object({
      allowed: z.array(z.string()),
      disallowed: z.array(z.string()),
    }),
    agents: z.record(
      z.string(),
      z.object({
        description: z.string().optional(),
        spawnMode: z.enum(["fresh", "inherit"]),
        hasModel: z.boolean(),
        toolCount: z.number().int().nonnegative(),
        disallowedToolCount: z.number().int().nonnegative(),
        mcpServerCount: z.number().int().nonnegative(),
        steps: z.number().int().positive().optional(),
      }),
    ),
    skills: z.array(
      z.object({
        name: z.string(),
        source: z.enum(["runtime", "plugin"]),
        pluginName: z.string().optional(),
      }),
    ),
    commands: z.array(
      z.object({
        name: z.string(),
        source: z.enum(["runtime", "plugin", "skill"]),
        pluginName: z.string().optional(),
      }),
    ),
    plugins: z.array(
      z.object({
        name: z.string(),
        source: z.enum(["inline", "claude"]),
        skillCount: z.number().int().nonnegative(),
        commandCount: z.number().int().nonnegative(),
        agentCount: z.number().int().nonnegative(),
        hookEventCount: z.number().int().nonnegative(),
        mcpServerCount: z.number().int().nonnegative(),
        diagnostics: z.array(z.string()).optional(),
      }),
    ),
  })
  .meta({ ref: "SessionRuntimeConfigEffective" })

const RuntimeConfigView = z
  .object({
    sessionID: SessionID.zod,
    runtimeConfig: SessionRuntimeConfig.RuntimeConfig,
    effective: RuntimeConfigEffective,
  })
  .meta({ ref: "SessionRuntimeConfigView" })

function effectiveSystemPrompt(runtimeConfig: SessionRuntimeConfig.RuntimeConfig) {
  const append =
    runtimeConfig.appendSystemPrompt !== undefined ||
    (typeof runtimeConfig.systemPrompt === "object" && runtimeConfig.systemPrompt.append !== undefined)
  if (runtimeConfig.systemPrompt === undefined) return { mode: "default" as const, hasAppend: append }
  if (typeof runtimeConfig.systemPrompt === "string") return { mode: "custom" as const, hasAppend: append }
  return { mode: "preset" as const, preset: runtimeConfig.systemPrompt.preset, hasAppend: append }
}

export const RuntimeConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/:sessionID/runtime-config",
      describeRoute({
        summary: "Get runtime config",
        description: "Retrieve the current session-scoped runtime config blob and effective view.",
        operationId: "session.runtimeConfig.get",
        tags: ["Session"],
        responses: {
          200: {
            description: "Runtime config",
            content: {
              "application/json": {
                schema: resolver(RuntimeConfigView),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) =>
        jsonRequest("RuntimeConfigRoutes.get", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const session = yield* Session.Service
          yield* session.get(sessionID)
          const runtimeConfig = yield* SessionRuntimeConfig.Service.use((svc) => svc.get(sessionID))
          const materializedPlugins = yield* RuntimePlugin.materialize(runtimeConfig, sessionID)
          const expandedRuntime = yield* RuntimePlugin.expand(runtimeConfig, sessionID)
          const lastUser = yield* session.findMessage(sessionID, (message) => message.info.role === "user")
          const agentSvc = yield* Agent.Service
          const providerSvc = yield* Provider.Service
          const agentName =
            Option.isSome(lastUser) && lastUser.value.info.role === "user"
              ? lastUser.value.info.agent
              : yield* agentSvc.runtimeDefaultAgent(runtimeConfig.settingSources)
          const agent = yield* AgentRuntime.get(agentName, expandedRuntime)
          const effectiveAgents = Object.fromEntries(
            (yield* AgentRuntime.list(expandedRuntime))
              .filter((item) => item.runtime)
              .map((item) => [
                item.name,
                {
                  ...(item.description ? { description: item.description } : {}),
                  spawnMode: item.runtime?.spawnMode ?? "fresh",
                  hasModel: !!item.model,
                  toolCount: item.runtime?.tools?.length ?? 0,
                  disallowedToolCount: item.runtime?.disallowedTools?.length ?? 0,
                  mcpServerCount: item.runtime?.mcpServers?.length ?? 0,
                  ...(item.steps ? { steps: item.steps } : {}),
                },
              ]),
          )
          const model =
            runtimeConfig.model ??
            agent?.model ??
            (Option.isSome(lastUser) && lastUser.value.info.role === "user"
              ? lastUser.value.info.model
              : yield* providerSvc.defaultModel())
          const maxTurns =
            runtimeConfig.maxTurns === undefined
              ? agent?.steps
              : agent?.steps === undefined
                ? runtimeConfig.maxTurns
                : Math.min(runtimeConfig.maxTurns, agent.steps)
          const tools = RuntimeToolRules.fromConfig(runtimeConfig)
          const skills = (yield* SkillRuntime.list(runtimeConfig, undefined, { includeModelDisabled: true }, sessionID))
            .filter((skill) => skill.source === "runtime" || skill.source === "plugin")
            .map((skill) => ({
              name: skill.name,
              source: skill.source === "plugin" ? ("plugin" as const) : ("runtime" as const),
              ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
            }))
          const commands = (yield* CommandRuntime.list(runtimeConfig, sessionID))
            .filter((command) => command.origin === "runtime" || command.origin === "plugin")
            .map((command) => ({
              name: command.name,
              source:
                command.source === "skill"
                  ? ("skill" as const)
                  : command.origin === "plugin"
                    ? ("plugin" as const)
                    : ("runtime" as const),
              ...(command.pluginName ? { pluginName: command.pluginName } : {}),
            }))
          const hookCounts = expandedRuntime.hooks
            ? Object.fromEntries(
                Object.entries(expandedRuntime.hooks)
                  .filter(([, descriptors]) => descriptors.length > 0)
                  .map(([event, descriptors]) => [event, { count: descriptors.length }]),
              )
            : undefined
          return {
            sessionID,
            runtimeConfig,
            effective: RuntimeConfigEffective.parse(
              Object.fromEntries(
                [
                  ["model", { providerID: model.providerID, modelID: model.modelID }],
                  ["maxTurns", maxTurns],
                  ["maxBudgetUsd", runtimeConfig.maxBudgetUsd],
                  ["permissionMode", runtimeConfig.permissionMode],
                  [
                    "canUseTool",
                    runtimeConfig.canUseTool === undefined ? undefined : { registered: runtimeConfig.canUseTool },
                  ],
                  ["hooks", hookCounts],
                  ["systemPrompt", effectiveSystemPrompt(runtimeConfig)],
                  [
                    "appendSystemPrompt",
                    runtimeConfig.appendSystemPrompt === undefined
                      ? undefined
                      : { length: runtimeConfig.appendSystemPrompt.length },
                  ],
                  ["settingSources", activeInstructionSources(runtimeConfig)],
                  ["autoPermissionClassifierModel", runtimeConfig.autoPermissionClassifierModel],
                  ["tools", { allowed: tools.allowed, disallowed: tools.disallowed }],
                  ["agents", effectiveAgents],
                  ["skills", skills],
                  ["commands", commands],
                  ["plugins", materializedPlugins.plugins],
                ].filter((entry) => entry[1] !== undefined),
              ),
            ),
          }
        }),
    )
    .patch(
      "/:sessionID/runtime-config",
      describeRoute({
        summary: "Patch runtime config",
        description: "Merge a partial runtime config into the current session-scoped blob.",
        operationId: "session.runtimeConfig.patch",
        tags: ["Session"],
        responses: {
          200: {
            description: "Updated runtime config",
            content: {
              "application/json": {
                schema: resolver(SessionRuntimeConfig.RuntimeConfig),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator("json", SessionRuntimeConfig.RuntimeConfig),
      async (c) =>
        jsonRequest("RuntimeConfigRoutes.patch", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          yield* Session.Service.use((svc) => svc.get(sessionID))
          if (body.plugins !== undefined) {
            yield* RuntimePlugin.materialize({ plugins: body.plugins }, sessionID)
          }
          const next = yield* SessionRuntimeConfig.Service.use((svc) => svc.set({ sessionID, config: body }))
          if (body.sdkMcpServers !== undefined || body.plugins !== undefined) {
            const expanded = yield* RuntimePlugin.expand(next, sessionID)
            yield* MCP.Service.use((svc) => svc.syncRuntime(sessionID, expanded.sdkMcpServers ?? []))
          }
          return next
        }),
    )
    .delete(
      "/:sessionID/runtime-config/mcp-scopes",
      describeRoute({
        summary: "Clear scoped runtime MCP clients",
        description: "Close accepted-snapshot runtime MCP clients without changing the session runtime config blob.",
        operationId: "session.runtimeConfig.clearMcpScopes",
        tags: ["Session"],
        responses: {
          200: {
            description: "Scoped runtime MCP clients cleared",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) =>
        jsonRequest("RuntimeConfigRoutes.clearMcpScopes", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          yield* Session.Service.use((svc) => svc.get(sessionID))
          yield* MCP.Service.use((svc) => svc.clearRuntimeScopes(sessionID))
          return true
        }),
    )
    .delete(
      "/:sessionID/runtime-config",
      describeRoute({
        summary: "Clear runtime config",
        description: "Reset the session-scoped runtime config blob to empty.",
        operationId: "session.runtimeConfig.clear",
        tags: ["Session"],
        responses: {
          200: {
            description: "Runtime config cleared",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) =>
        jsonRequest("RuntimeConfigRoutes.clear", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          yield* Session.Service.use((svc) => svc.get(sessionID))
          yield* SessionRuntimeConfig.Service.use((svc) => svc.clear(sessionID))
          yield* RuntimePlugin.clear(sessionID)
          yield* MCP.Service.use((svc) => svc.clearRuntime(sessionID))
          return true
        }),
    ),
)

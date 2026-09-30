import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { AgentRuntime } from "@/agent/runtime"
import { RuntimePlugin } from "@/plugin/runtime"
import { ModelID, ProviderID } from "../provider/schema"
import type { SessionPrompt } from "../session/prompt"
import { SessionRuntimeConfig } from "../session/runtime-config"
import { SubagentInherit } from "@/session/subagent-inherit"
import { ControlRequestRegistry } from "@/session/control-registry"
import { HookBridge } from "@/session/hook-bridge"
import { Config } from "../config"
import { MCP } from "@/mcp"
import { Bus } from "@/bus"
import type { BusEvent } from "@/bus/bus-event"
import { Cause, Effect, Option } from "effect"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(
    template: string,
    runtime?: SessionRuntimeConfig.RuntimeConfig,
  ): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(
    input: SessionPrompt.PromptInput & { runtime?: SessionRuntimeConfig.RuntimeConfig },
  ): Effect.Effect<MessageV2.WithParts>
}

type PreparedChildRun =
  | { type: "continue"; runtime?: SessionRuntimeConfig.RuntimeConfig }
  | { type: "blocked"; output: string }

const id = "task"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  spawnMode: z.enum(["fresh", "inherit"]).describe("Whether to start fresh or inherit parent context").optional(),
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const run = Effect.fn("TaskTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()
      const runtime = ctx.extra?.runtime as SessionRuntimeConfig.RuntimeConfig | undefined
      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      if (session && !(yield* canResumeTaskSession(sessions, ctx.sessionID, session))) {
        return yield* Effect.fail(new Error(`Cannot resume task_id outside the current session tree: ${session.id}`))
      }
      const created = !session
      const runtimeSvc = yield* Effect.serviceOption(SessionRuntimeConfig.Service)
      const storedRuntime =
        session && Option.isSome(runtimeSvc)
          ? yield* runtimeSvc.value.get(session.id).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
      const agentRuntime = storedRuntime?.plugins?.length
        ? yield* RuntimePlugin.expand(storedRuntime, session?.id)
        : (storedRuntime ?? runtime)
      const resolved = yield* Effect.gen(function* () {
        const primary = yield* AgentRuntime.get(params.subagent_type, agentRuntime).pipe(
          Effect.provideService(Agent.Service, agent),
        )
        const fallback = !primary && agentRuntime !== runtime
          ? yield* AgentRuntime.get(params.subagent_type, runtime).pipe(Effect.provideService(Agent.Service, agent))
          : undefined
        const next = primary ?? fallback
        if (!next) {
          return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
        }
        const spawnMode = params.spawnMode ?? next.runtime?.spawnMode ?? "fresh"
        return {
          fromParentRuntime: !primary && !!fallback,
          next,
          spawnMode,
          taskParams: { ...params, spawnMode },
        }
      })

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [resolved.taskParams.subagent_type],
          always: ["*"],
          toolInput: resolved.taskParams,
          metadata: {
            description: resolved.taskParams.description,
            subagent_type: resolved.taskParams.subagent_type,
            spawnMode: resolved.spawnMode,
          },
        })
      }

      const next = resolved.next
      const spawnMode = resolved.spawnMode
      const taskParams = resolved.taskParams

      const canTask = next.permission.some((rule) => rule.permission === id)
      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: taskParams.description + ` (@${next.name} subagent)`,
          permission: [
            ...(canTodo
              ? []
              : [
                  {
                    permission: "todowrite" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(canTask
              ? []
              : [
                  {
                    permission: id,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const messageID = MessageID.ascending()
      const model =
        next.model ??
        (runtime?.model
          ? {
              modelID: ModelID.make(runtime.model.modelID),
              providerID: ProviderID.make(runtime.model.providerID),
            }
          : {
              modelID: msg.info.modelID,
              providerID: msg.info.providerID,
            })

      yield* ctx.metadata({
        title: taskParams.description,
        metadata: {
          sessionId: nextSession.id,
          messageId: messageID,
          model,
          spawnMode,
        },
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      const prepareChildRun = ctx.extra?.prepareChildRun as (() => Effect.Effect<PreparedChildRun>) | undefined

      function cancel() {
        ops.cancel(nextSession.id)
      }
      const lineage = ControlRequestRegistry.lineage(ctx.sessionID)
      const eventBase = {
        sessionID: lineage.rootSessionID,
        parentSessionID: ctx.sessionID,
        childSessionID: nextSession.id,
        taskID: nextSession.id,
        agent: next.name,
        messageID: ctx.messageID,
        callID: ctx.callID,
        spawnMode,
      }
      const publish = <D extends BusEvent.Definition>(event: D, payload: z.output<D["properties"]>) =>
        Effect.gen(function* () {
          const busSvc = yield* Effect.serviceOption(Bus.Service)
          if (Option.isNone(busSvc)) return
          yield* busSvc.value.publish(event, payload)
        })
      let stopped = false
      const stopOnce = (payload: z.output<(typeof Session.Event.SubagentStopped)["properties"]>) =>
        Effect.gen(function* () {
          if (stopped) return
          stopped = true
          yield* publish(Session.Event.SubagentStopped, payload)
        })

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", cancel)
        }),
        () => {
          const childRun = Effect.gen(function* () {
            yield* publish(Session.Event.SubagentStarted, eventBase)
            const prepared = prepareChildRun ? yield* prepareChildRun() : { type: "continue" as const, runtime }
            if (prepared.type === "blocked") {
              yield* stopOnce({
                ...eventBase,
                status: "error",
                error: prepared.output,
              })
              return {
                title: taskParams.description,
                metadata: {
                  sessionId: nextSession.id,
                  messageId: messageID,
                  model,
                  spawnMode,
                },
                output: prepared.output,
              }
            }
            const baseRuntime = created
              ? (prepared.runtime ?? runtime ?? {})
              : mergeResumedRuntime(storedRuntime, prepared.runtime ?? runtime)
            const restoredRuntime = AgentRuntime.restoreAgentMcpServers(baseRuntime, next)
            const baseChildRuntime = created
              ? AgentRuntime.deriveChildRuntime(prepared.runtime ?? runtime ?? {}, next)
              : restoredRuntime.plugins?.length
                ? yield* RuntimePlugin.expand(restoredRuntime, nextSession.id)
                : restoredRuntime
            const childRuntime = restoreParentRuntimeFallback({
              childRuntime: baseChildRuntime,
              parentRuntime: runtime,
              agentName: next.name,
              enabled: resolved.fromParentRuntime,
            })
            if (created && Option.isSome(runtimeSvc)) {
              const stored = yield* runtimeSvc.value.set({
                sessionID: nextSession.id,
                config: RuntimePlugin.collapse(childRuntime),
              })
              const mcpSvc = yield* Effect.serviceOption(MCP.Service)
              if (Option.isSome(mcpSvc) && stored.sdkMcpServers !== undefined) {
                yield* mcpSvc.value.syncRuntime(nextSession.id, stored.sdkMcpServers)
              }
              yield* HookBridge.notify({
                sessionID: nextSession.id,
                runtime: childRuntime,
                event: "SessionStart",
                data: { parentSessionID: ctx.sessionID },
              })
            }
            if (created && spawnMode === "inherit") {
              yield* SubagentInherit.copy({
                parentSessionID: ctx.sessionID,
                childSessionID: nextSession.id,
                boundaryMessageID: ctx.messageID,
                model,
              }).pipe(Effect.provideService(Session.Service, sessions), Effect.provideService(Config.Service, config))
            }
            yield* publish(Session.Event.SubagentProgress, {
              ...eventBase,
              status: "running",
              title: taskParams.description,
            })
            const parts = yield* ops.resolvePromptParts(taskParams.prompt, childRuntime)
            const result = yield* ops.prompt({
              messageID,
              sessionID: nextSession.id,
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
              },
              runtime: childRuntime,
              agent: next.name,
              tools: {
                ...(canTodo ? {} : { todowrite: false }),
                ...(canTask ? {} : { task: false }),
                ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
              },
              parts,
            })
            yield* stopOnce({
              ...eventBase,
              status: "completed",
              result: result.parts.findLast((item) => item.type === "text")?.text,
            })

            return {
              title: taskParams.description,
              metadata: {
                sessionId: nextSession.id,
                messageId: messageID,
                model,
                spawnMode,
              },
              output: [
                `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                "",
                "<task_result>",
                result.parts.findLast((item) => item.type === "text")?.text ?? "",
                "</task_result>",
              ].join("\n"),
            }
          })
          return childRun.pipe(
            Effect.catchCause((cause) =>
              stopOnce({
                ...eventBase,
                status: Cause.hasInterruptsOnly(cause) ? "cancelled" : "error",
                ...(Cause.hasInterruptsOnly(cause) ? {} : { error: Cause.pretty(cause) }),
              }).pipe(Effect.catchCause(() => Effect.void), Effect.flatMap(() => Effect.failCause(cause))),
            ),
          )
        },
        () =>
          Effect.sync(() => {
            ctx.abort.removeEventListener("abort", cancel)
          }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

const canResumeTaskSession = Effect.fn("TaskTool.canResumeTaskSession")(function* (
  sessions: Session.Interface,
  currentSessionID: SessionID,
  taskSession: Session.Info,
) {
  if (!taskSession.parentID || currentSessionID === taskSession.id) return false
  if (ControlRequestRegistry.lineage(currentSessionID).rootSessionID !== ControlRequestRegistry.lineage(taskSession.id).rootSessionID) {
    return false
  }
  let cursor: SessionID | undefined = currentSessionID
  while (cursor) {
    if (cursor === taskSession.id) return false
    const current: Session.Info | undefined = yield* sessions.get(cursor).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    cursor = current?.parentID
  }
  return true
})

function mergeResumedRuntime(
  storedRuntime: SessionRuntimeConfig.RuntimeConfig | undefined,
  preparedRuntime: SessionRuntimeConfig.RuntimeConfig | undefined,
): SessionRuntimeConfig.RuntimeConfig {
  const base = storedRuntime ?? preparedRuntime ?? {}
  return {
    ...base,
    ...runtimeCaps(base, preparedRuntime),
  }
}

function runtimeCaps(
  base: SessionRuntimeConfig.RuntimeConfig,
  preparedRuntime: SessionRuntimeConfig.RuntimeConfig | undefined,
) {
  if (!preparedRuntime) return {}
  return {
    ...(minDefined(base.maxTurns, preparedRuntime.maxTurns) === undefined
      ? {}
      : { maxTurns: minDefined(base.maxTurns, preparedRuntime.maxTurns) }),
    ...(minDefined(base.maxBudgetUsd, preparedRuntime.maxBudgetUsd) === undefined
      ? {}
      : { maxBudgetUsd: minDefined(base.maxBudgetUsd, preparedRuntime.maxBudgetUsd) }),
  }
}

function minDefined(left: number | undefined, right: number | undefined) {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.min(left, right)
}

function restoreParentRuntimeFallback(input: {
  childRuntime: SessionRuntimeConfig.RuntimeConfig
  parentRuntime: SessionRuntimeConfig.RuntimeConfig | undefined
  agentName: string
  enabled: boolean
}) {
  if (!input.enabled || !input.parentRuntime) return input.childRuntime
  const agent = input.parentRuntime.agents?.[input.agentName]
  const withAgent =
    agent && input.childRuntime.agents?.[input.agentName] === undefined
      ? {
          ...input.childRuntime,
          agents: {
            ...(input.childRuntime.agents ?? {}),
            [input.agentName]: agent,
          },
        }
      : input.childRuntime
  if (!input.parentRuntime.sdkMcpServers?.length) return withAgent
  return {
    ...withAgent,
    sdkMcpServers: dedupeMcpServers([
      ...input.parentRuntime.sdkMcpServers,
      ...(withAgent.sdkMcpServers ?? []),
    ]),
  }
}

function dedupeMcpServers(servers: SessionRuntimeConfig.RuntimeMcpServer[]) {
  return Array.from(new Map(servers.map((server) => [server.name, server])).values())
}

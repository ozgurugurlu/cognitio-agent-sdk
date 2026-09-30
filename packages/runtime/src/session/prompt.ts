import path from "path"
import os from "os"
import z from "zod"
import Ajv, { type ErrorObject } from "ajv"
import Ajv2020 from "ajv/dist/2020.js"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Log } from "../util"
import { SessionRevert } from "./revert"
import { SessionCheckpoint } from "./checkpoint"
import * as Session from "./session"
import { SessionRuntimeConfig } from "./runtime-config"
import { resolveHelperSystemPrompt, resolveSystemPrompt } from "./system-prompt"
import { Agent } from "../agent/agent"
import { AgentRuntime } from "@/agent/runtime"
import { Provider } from "../provider"
import { ModelID, ProviderID } from "../provider/schema"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema, type ModelMessage } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { ToolRegistry } from "../tool"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { CommandRuntime } from "../command/runtime"
import { RuntimePlugin } from "@/plugin/runtime"
import { pathToFileURL, fileURLToPath } from "url"
import { ConfigMarkdown } from "../config"
import { SessionSummary } from "./summary"
import { NamedError } from "@cognitio/shared/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool"
import { Permission } from "@/permission"
import { PermissionClassifier } from "@/permission/classifier"
import { PermissionPipeline, type AskInput as PermissionPipelineAskInput } from "@/permission/pipeline"
import { RuntimeToolRules } from "@/permission/runtime-rules"
import { HookBridge, type HookAggregate, type HookInput } from "./hook-bridge"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@/shell/shell"
import { AppFileSystem } from "@cognitio/shared/filesystem"
import { Truncate } from "@/tool"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util"
import { Cause, Deferred, Effect, Exit, Layer, Option, Scope, Context } from "effect"
import { EffectLogger } from "@/effect"
import { InstanceState } from "@/effect"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { EffectBridge } from "@/effect"
import type { DeferredTool } from "@/tool/tool_search"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

const log = Log.create({ service: "session.prompt" })
const elog = EffectLogger.create({ service: "session.prompt" })
const MAX_PERMISSION_INPUT_UPDATES = 3
const FILE_CHECKPOINT_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch"])

class ToolInputUpdated extends Error {
  constructor(readonly updatedInput: Record<string, unknown>) {
    super("Tool input updated by permission callback")
  }
}

function mergeToolInput(args: unknown, updatedInput?: Record<string, unknown>) {
  if (!updatedInput) return args
  if (!args || typeof args !== "object" || Array.isArray(args)) return updatedInput
  return { ...args, ...updatedInput }
}

function hasToolInputUpdate(args: unknown, updatedInput?: Record<string, unknown>) {
  if (!updatedInput) return false
  if (!args || typeof args !== "object" || Array.isArray(args)) return Object.keys(updatedInput).length > 0
  return Object.entries(updatedInput).some(([key, value]) => !Object.is((args as Record<string, unknown>)[key], value))
}

function inputUpdateFromCause(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  if (error instanceof ToolInputUpdated) return error.updatedInput
}

function publishRuntimeDenied(
  plugin: Plugin.Interface,
  input: { sessionID: SessionID; tool: string; callID?: string; messageID?: MessageID; ruleset: Permission.Ruleset },
) {
  return plugin
    .trigger(
      "permission.denied",
      {
        request: {
          sessionID: input.sessionID,
          permission: input.tool,
          patterns: ["*"],
          always: ["*"],
          metadata: {},
          ...(input.callID && input.messageID ? { tool: { callID: input.callID, messageID: input.messageID } } : {}),
          ruleset: input.ruleset,
        },
        reason: "runtime_visibility",
      },
      {},
    )
    .pipe(Effect.catchCause(() => Effect.void))
}

function failFromHook(hook: HookAggregate) {
  if (hook.continue === false) {
    return new Permission.CorrectedError({ feedback: hook.stopReason ?? "Hook stopped tool execution" })
  }
  if (hook.permissionDecision?.behavior === "deny") {
    return hook.permissionDecision.message
      ? new Permission.CorrectedError({ feedback: hook.permissionDecision.message })
      : new Permission.RejectedError()
  }
}

function hookUpdatedInput(hook: HookAggregate) {
  const decisionInput = hook.permissionDecision?.behavior === "allow" ? hook.permissionDecision.updatedInput : undefined
  if (decisionInput && hook.updatedInput) return { ...decisionInput, ...hook.updatedInput }
  return hook.updatedInput ?? decisionInput
}

function applyPostHookOutput<T extends { output?: unknown }>(
  output: T,
  hook: HookAggregate,
  ...contextHooks: HookAggregate[]
): T {
  const next =
    hook.updatedToolOutput === undefined
      ? output
      : typeof hook.updatedToolOutput === "string" && typeof output.output === "string"
        ? { ...output, output: hook.updatedToolOutput }
        : { ...output, output: String(hook.updatedToolOutput) }
  return applyHookContext(next, ...contextHooks, hook)
}

function applyHookContext<T extends { output?: unknown }>(output: T, ...hooks: HookAggregate[]): T {
  const context = hooks.flatMap((hook) => [...hook.systemMessage, ...hook.additionalContext])
  if (context.length === 0 || typeof output.output !== "string") return output
  return {
    ...output,
    output: [output.output, "<hook_context>", ...context, "</hook_context>"].join("\n"),
  }
}

function causeMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

function recentText(messages: MessageV2.WithParts[]) {
  return messages
    .slice(-3)
    .flatMap((message) =>
      message.parts.flatMap((part) => {
        if (part.type === "text") return [part.text]
        if (part.type === "tool" && part.state.status === "completed") return [part.state.output]
        return []
      }),
    )
    .join("\n\n")
}

function toolSearchEnabled(
  value: SessionRuntimeConfig.RuntimeConfig["enableToolSearch"],
  totalTools: number,
  deferredTools: number,
) {
  if (value === true || value === "always") return true
  if (value === false || value === "never" || value === undefined) return false
  return totalTools >= 20 || deferredTools >= 10
}

function runtimeMcpScope(servers: SessionRuntimeConfig.RuntimeConfig["sdkMcpServers"]) {
  if (!servers) return undefined
  return `snapshot:${Bun.hash(JSON.stringify(servers)).toString(16)}`
}

function structuredOutputValidationMessage(errors: ErrorObject[] | null | undefined) {
  const details = errors
    ?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .filter(Boolean)
    .join("; ")
  if (details) return `Structured output does not match schema: ${details}`
  return "Structured output does not match schema"
}

function structuredOutputRetryMessage(input: { reason: string; attempt: number; retryCount: number }): ModelMessage {
  return {
    role: "user",
    content: [
      "<system-reminder>",
      "The previous response did not produce valid structured output.",
      `Reason: ${input.reason}`,
      `Retry ${input.attempt} of ${input.retryCount}. Call the StructuredOutput tool with JSON matching the requested schema.`,
      "</system-reminder>",
    ].join("\n"),
  }
}

function structuredOutputAjv(schema: Record<string, unknown>) {
  if (typeof schema.$schema === "string" && schema.$schema.includes("2020-12")) {
    return new Ajv2020({ strict: false, allErrors: true })
  }
  return new Ajv({ strict: false, allErrors: true })
}

function structuredOutputFailure(part: MessageV2.Part) {
  if (part.type !== "tool") return
  if (part.tool === "StructuredOutput" && part.state.status === "error") return part.state.error
  if (part.tool !== "invalid") return
  if (part.state.status !== "completed" && part.state.status !== "error") return
  const source = part.state.input.tool
  if (source !== "StructuredOutput") return
  if (typeof part.state.input.error === "string") return part.state.input.error
  if (part.state.status === "error") return part.state.error
  return part.state.output
}

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts>
  readonly promptAsync: (
    input: PromptInput & { runtime?: SessionRuntimeConfig.RuntimeConfig },
  ) => Effect.Effect<MessageV2.User>
  readonly loop: (
    input: z.infer<typeof LoopInput> & { runtime?: SessionRuntimeConfig.RuntimeConfig },
  ) => Effect.Effect<MessageV2.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts>
  readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts>
  readonly resolvePromptParts: (
    template: string,
    runtime?: SessionRuntimeConfig.RuntimeConfig,
  ) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@cognitio/SessionPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commandSvc = yield* Command.Service
    const permission = yield* Permission.Service
    const fsys = yield* AppFileSystem.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const runtimeConfig = yield* SessionRuntimeConfig.Service
    const checkpoints = yield* SessionCheckpoint.Service
    const activeRuntime = new Map<SessionID, SessionRuntimeConfig.RuntimeConfig>()
    const pendingRuntime = new Map<SessionID, SessionRuntimeConfig.RuntimeConfig>()
    const messageRuntime = new Map<MessageID, SessionRuntimeConfig.RuntimeConfig>()
    const finalizedRuntime = Symbol.for("cognitio.session.prompt.finalized-runtime")
    const isFinalizedRuntime = (runtime?: SessionRuntimeConfig.RuntimeConfig) =>
      !!runtime && (runtime as Record<symbol, unknown>)[finalizedRuntime] === true
    const finalizeRuntime = (runtime: SessionRuntimeConfig.RuntimeConfig) => {
      if (!isFinalizedRuntime(runtime)) {
        Object.defineProperty(runtime, finalizedRuntime, { value: true, enumerable: true })
      }
      return runtime
    }
    const runtimeAgentGet = (name: string, runtime?: SessionRuntimeConfig.RuntimeConfig) =>
      AgentRuntime.get(name, runtime).pipe(Effect.provideService(Agent.Service, agents))
    const runtimeAgentList = (runtime?: SessionRuntimeConfig.RuntimeConfig) =>
      AgentRuntime.list(runtime).pipe(Effect.provideService(Agent.Service, agents))
    const runtimeDefaultAgent = (runtime?: SessionRuntimeConfig.RuntimeConfig) =>
      AgentRuntime.defaultAgent(runtime).pipe(Effect.provideService(Agent.Service, agents))
    const hookRun = (input: HookInput) => HookBridge.run(input)
    const hookNotify = (input: HookInput) => HookBridge.notify(input)
    const pipelineAsk = (input: PermissionPipelineAskInput) =>
      PermissionPipeline.ask(input).pipe(
        Effect.provideService(Plugin.Service, plugin),
        Effect.provideService(Permission.Service, permission),
      )
    const runner = Effect.fn("SessionPrompt.runner")(function* () {
      return yield* EffectBridge.make()
    })
    const ops = Effect.fn("SessionPrompt.ops")(function* (runtime?: SessionRuntimeConfig.RuntimeConfig) {
      const run = yield* runner()
      return {
        cancel: (sessionID: SessionID) => run.fork(cancel(sessionID)),
        resolvePromptParts: (template: string, inputRuntime?: SessionRuntimeConfig.RuntimeConfig) =>
          resolvePromptParts(template, inputRuntime ?? runtime),
        prompt: (input: PromptInput & { runtime?: SessionRuntimeConfig.RuntimeConfig }) =>
          prompt({ ...input, runtime: input.runtime ?? runtime }),
      } satisfies TaskPromptOps
    })

    const autoCheckpoint = Effect.fn("SessionPrompt.autoCheckpoint")(function* (input: {
      runtime: SessionRuntimeConfig.RuntimeConfig
      tool: string
      sessionID: SessionID
      messageID: MessageID
      callID?: string
    }) {
      if ((input.runtime.checkpointing?.enabled ?? input.runtime.enableFileCheckpointing) !== true) return
      if (input.runtime.checkpointing?.beforeTools === false) return
      if (!FILE_CHECKPOINT_TOOLS.has(input.tool)) return
      yield* checkpoints
        .create({
          sessionID: input.sessionID,
          messageID: input.messageID,
          source: "auto",
          metadata: { tool: input.tool, ...(input.callID ? { callID: input.callID } : {}) },
          allowBusy: true,
        })
        .pipe(
          Effect.catchCause((cause) =>
            elog.warn("auto checkpoint failed", {
              sessionID: input.sessionID,
              tool: input.tool,
              callID: input.callID,
              errorType: Cause.squash(cause) instanceof Error ? "Error" : "Failure",
            }),
          ),
        )
    })

    const acceptedRuntime = Effect.fn("SessionPrompt.acceptedRuntime")(function* (input: {
      sessionID: SessionID
      runtime?: SessionRuntimeConfig.RuntimeConfig
    }) {
      const resolveRuntime = (runtime: SessionRuntimeConfig.RuntimeConfig) =>
        isFinalizedRuntime(runtime)
          ? Effect.succeed(runtime)
          : RuntimePlugin.expand(runtime, input.sessionID).pipe(Effect.map(finalizeRuntime))
      const current = yield* state.get(input.sessionID)
      const finalizedInput = isFinalizedRuntime(input.runtime) ? input.runtime : undefined
      if (current?._tag === "Running") {
        return {
          state: current,
          runtime: yield* resolveRuntime(
            finalizedInput ??
              activeRuntime.get(input.sessionID) ??
              input.runtime ??
              (yield* runtimeConfig.get(input.sessionID)),
          ),
        }
      }
      if (current?._tag === "InterruptingThenRun" || current?._tag === "ShellThenRun") {
        return {
          state: current,
          runtime: yield* resolveRuntime(
            finalizedInput ??
              pendingRuntime.get(input.sessionID) ??
              input.runtime ??
              (yield* runtimeConfig.get(input.sessionID)),
          ),
        }
      }
      return {
        state: current,
        runtime: yield* resolveRuntime(input.runtime ?? (yield* runtimeConfig.get(input.sessionID))),
      }
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* elog.info("cancel", { sessionID })
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (
      template: string,
      runtime?: SessionRuntimeConfig.RuntimeConfig,
    ) {
      const ctx = yield* InstanceState.context
      const parts: PromptInput["parts"] = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (seen.has(name)) return
          seen.add(name)
          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* runtimeAgentGet(name, runtime)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: MessageV2.WithParts[]
      providerID: ProviderID
      modelID: ModelID
      runtime?: SessionRuntimeConfig.RuntimeConfig
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: MessageV2.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is MessageV2.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* runtimeAgentGet("title", input.runtime)
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          systemPromptOverride: resolveHelperSystemPrompt(input.runtime ?? {}, ag.prompt),
          runtime: input.runtime,
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter((e): e is Extract<LLM.Event, { type: "text-delta" }> => e.type === "text-delta"),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => elog.error("failed to generate title", { error: Cause.squash(cause) })))
    })

    const insertReminders = Effect.fn("SessionPrompt.insertReminders")(function* (input: {
      messages: MessageV2.WithParts[]
      agent: Agent.Info
      session: Session.Info
    }) {
      const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
      if (!userMessage) return input.messages

      if (!Flag.COGNITIO_EXPERIMENTAL_PLAN_MODE) {
        if (input.agent.name === "plan") {
          userMessage.parts.push({
            id: PartID.ascending(),
            messageID: userMessage.info.id,
            sessionID: userMessage.info.sessionID,
            type: "text",
            text: PROMPT_PLAN,
            synthetic: true,
          })
        }
        const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
        if (wasPlan && input.agent.name === "build") {
          userMessage.parts.push({
            id: PartID.ascending(),
            messageID: userMessage.info.id,
            sessionID: userMessage.info.sessionID,
            type: "text",
            text: BUILD_SWITCH,
            synthetic: true,
          })
        }
        return input.messages
      }

      const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
      if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
        const plan = Session.plan(input.session)
        if (!(yield* fsys.existsSafe(plan))) return input.messages
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
        return input.messages
      }

      if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

      const plan = Session.plan(input.session)
      const exists = yield* fsys.existsSafe(plan)
      if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
 - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
 - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
 - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
 - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    })

    const resolveTools = Effect.fn("SessionPrompt.resolveTools")(function* (input: {
      agent: Agent.Info
      model: Provider.Model
      session: Session.Info
      parentMessageID?: MessageID
      tools?: Record<string, boolean>
      processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
      bypassAgentCheck: boolean
      messages: MessageV2.WithParts[]
      runtime: SessionRuntimeConfig.RuntimeConfig
      selectedDeferredTools: Set<string>
    }) {
      using _ = log.time("resolveTools")
      const tools: Record<string, AITool> = {}
      const run = yield* runner()
      const promptOps = yield* ops(input.runtime)
      const runtimePolicy = RuntimeToolRules.fromConfig(input.runtime)
      const basePermission = input.session.permission ?? []
      const effectivePermission = Permission.merge(input.agent.permission, basePermission)
      let deferredTools: DeferredTool[] = []

      const context = (toolID: string, args: any, options: ToolExecutionOptions): Tool.Context => ({
        sessionID: input.session.id,
        abort: options.abortSignal!,
        messageID: input.processor.message.id,
        callID: options.toolCallId,
        extra: {
          model: input.model,
          bypassAgentCheck: input.bypassAgentCheck,
          promptOps,
          runtime: input.runtime,
          toolSearch: { deferred: deferredTools, selected: input.selectedDeferredTools },
          prepareChildRun: () =>
            prepareChildRun({
              sessionID: input.session.id,
              parentMessageID: input.parentMessageID,
              runtime: input.runtime,
              effectiveMaxTurns: effectiveTurnCap(input.runtime, input.agent.steps),
              pendingParentAssistant: input.processor.message,
            }),
        },
        agent: input.agent.name,
        messages: input.messages,
        metadata: (val) =>
          input.processor.updateToolCall(options.toolCallId, (match) => {
            if (!["running", "pending"].includes(match.state.status)) return match
            return {
              ...match,
              state: {
                title: val.title,
                metadata: val.metadata,
                status: "running",
                input: args,
                time: { start: Date.now() },
              },
            }
          }),
        ask: (req) => {
          const { toolInput, ...request } = req
          return pipelineAsk({
            toolName: toolID,
            toolInput: toolInput ?? args,
            cwd: input.session.directory,
            recentContext: recentText(input.messages),
            runtime: input.runtime,
            request: {
              ...request,
              runtimePermission: runtimePolicy.permissionForAsk(toolID, req.permission),
              sessionID: input.session.id,
              tool: { messageID: input.processor.message.id, callID: options.toolCallId },
              ruleset: effectivePermission,
              runtimeRuleset: runtimePolicy.ruleset,
            },
          }).pipe(
            Effect.flatMap((result) => {
              if (!hasToolInputUpdate(args, result.updatedInput)) return Effect.void
              return Effect.fail(new ToolInputUpdated(result.updatedInput!))
            }),
            Effect.asVoid,
            Effect.orDie,
          )
        },
      })

      const registryTools = yield* registry.tools({
        modelID: ModelID.make(input.model.api.id),
        providerID: input.model.providerID,
        agent: input.agent,
        runtime: input.runtime,
      })
      const mcpTools = Object.entries(
        yield* mcp.tools({
          sessionID: input.session.id,
          servers: input.runtime.sdkMcpServers,
          scope: runtimeMcpScope(input.runtime.sdkMcpServers),
        }),
      ).filter(([key]) => runtimePolicy.isVisible(key))
      const searchEnabled = toolSearchEnabled(
        input.runtime.enableToolSearch,
        registryTools.length + mcpTools.length,
        mcpTools.length,
      )
      const searchTool = registryTools.find((item) => item.id === "tool_search")

      for (const item of registryTools.filter(
        (item) => item.id !== "tool_search" && runtimePolicy.isVisible(item.id),
      )) {
        const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
        if (
          searchEnabled &&
          item.metadata?.isDeferred &&
          !item.metadata.alwaysLoad &&
          !input.selectedDeferredTools.has(item.id)
        ) {
          deferredTools.push({
            id: item.id,
            description: item.description,
            schema,
            searchHint: item.metadata.searchHint,
            source: item.metadata.source,
          })
          continue
        }
        tools[item.id] = tool({
          description: item.description,
          inputSchema: jsonSchema(schema),
          execute(args, options) {
            const executeAttempt = (attemptArgs: unknown, inputUpdates: number): Effect.Effect<unknown, unknown> => {
              let failureArgs: unknown = attemptArgs
              return Effect.gen(function* () {
                if (!runtimePolicy.isVisible(item.id)) {
                  yield* publishRuntimeDenied(plugin, {
                    sessionID: input.session.id,
                    tool: item.id,
                    callID: options.toolCallId,
                    messageID: input.processor.message.id,
                    ruleset: runtimePolicy.toolRuleset,
                  })
                  return yield* new Permission.DeniedError({ ruleset: runtimePolicy.toolRuleset })
                }
                let nextArgs = attemptArgs
                failureArgs = nextArgs
                const before = yield* plugin.trigger(
                  "tool.execute.before",
                  { tool: item.id, sessionID: input.session.id, callID: options.toolCallId },
                  { args: nextArgs },
                )
                nextArgs = before.args
                failureArgs = nextArgs
                const pre = yield* hookRun({
                  sessionID: input.session.id,
                  runtime: input.runtime,
                  event: "PreToolUse",
                  target: item.id,
                  data: {
                    toolName: item.id,
                    input: nextArgs,
                    callID: options.toolCallId,
                    messageID: input.processor.message.id,
                  },
                })
                const preError = failFromHook(pre)
                if (preError) return yield* preError
                nextArgs = mergeToolInput(nextArgs, hookUpdatedInput(pre))
                failureArgs = nextArgs
                const ctx = context(item.id, nextArgs, options)
                const result = yield* item.execute(nextArgs, ctx)
                const output = {
                  ...result,
                  attachments: result.attachments?.map((attachment) => ({
                    ...attachment,
                    id: PartID.ascending(),
                    sessionID: ctx.sessionID,
                    messageID: input.processor.message.id,
                  })),
                }
                yield* plugin.trigger(
                  "tool.execute.after",
                  { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args: nextArgs },
                  output,
                )
                const post = yield* hookRun({
                  sessionID: ctx.sessionID,
                  runtime: input.runtime,
                  event: "PostToolUse",
                  target: item.id,
                  data: {
                    toolName: item.id,
                    input: nextArgs,
                    output,
                    callID: ctx.callID,
                    messageID: input.processor.message.id,
                  },
                })
                const postError = failFromHook(post)
                if (postError) return yield* postError
                const finalOutput = applyPostHookOutput(output, post, pre)
                yield* autoCheckpoint({
                  runtime: input.runtime,
                  tool: item.id,
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                  callID: ctx.callID,
                })
                if (options.abortSignal?.aborted) {
                  yield* input.processor.completeToolCall(options.toolCallId, finalOutput)
                }
                return finalOutput
              }).pipe(
                Effect.catchCause((cause) => {
                  const updatedInput = inputUpdateFromCause(cause)
                  if (updatedInput && inputUpdates < MAX_PERMISSION_INPUT_UPDATES) {
                    return executeAttempt(mergeToolInput(attemptArgs, updatedInput), inputUpdates + 1)
                  }
                  const error = updatedInput
                    ? new Permission.CorrectedError({
                        feedback:
                          "Permission updated tool input too many times; refusing to execute without stable permission metadata.",
                      }).message
                    : causeMessage(cause)
                  return plugin
                    .trigger(
                      "post_tool_use_failure",
                      {
                        tool: item.id,
                        sessionID: input.session.id,
                        callID: options.toolCallId,
                        args: failureArgs,
                        error,
                      },
                      {},
                    )
                    .pipe(
                      Effect.catchCause(() => Effect.void),
                      Effect.flatMap(() =>
                        updatedInput
                          ? Effect.fail(
                              new Permission.CorrectedError({
                                feedback:
                                  "Permission updated tool input too many times; refusing to execute without stable permission metadata.",
                              }),
                            )
                          : Effect.failCause(cause),
                      ),
                    )
                }),
              )
            }
            return run.promise(executeAttempt(args, 0))
          },
        })
      }

      for (const [key, item] of mcpTools) {
        const execute = item.execute
        if (!execute) continue

        const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
        const transformed = ProviderTransform.schema(input.model, schema)
        const metadata = (item as typeof item & { metadata?: Tool.SearchMetadata }).metadata
        if (searchEnabled && !metadata?.alwaysLoad && !input.selectedDeferredTools.has(key)) {
          deferredTools.push({
            id: key,
            description: item.description ?? "",
            schema: transformed,
            searchHint: metadata?.searchHint,
            capabilityFlags: metadata?.capabilityFlags,
            source: metadata?.source ?? "mcp",
          })
          continue
        }
        item.inputSchema = jsonSchema(transformed)
        item.execute = (args, opts) => {
          let failureArgs: unknown = args
          return run.promise(
            Effect.gen(function* () {
              if (!runtimePolicy.isVisible(key)) {
                yield* publishRuntimeDenied(plugin, {
                  sessionID: input.session.id,
                  tool: key,
                  callID: opts.toolCallId,
                  messageID: input.processor.message.id,
                  ruleset: runtimePolicy.toolRuleset,
                })
                return yield* new Permission.DeniedError({ ruleset: runtimePolicy.toolRuleset })
              }
              let nextArgs = args
              failureArgs = nextArgs
              const before = yield* plugin.trigger(
                "tool.execute.before",
                { tool: key, sessionID: input.session.id, callID: opts.toolCallId },
                { args: nextArgs },
              )
              nextArgs = before.args
              failureArgs = nextArgs
              const pre = yield* hookRun({
                sessionID: input.session.id,
                runtime: input.runtime,
                event: "PreToolUse",
                target: key,
                data: {
                  toolName: key,
                  input: nextArgs,
                  callID: opts.toolCallId,
                  messageID: input.processor.message.id,
                },
              })
              const preError = failFromHook(pre)
              if (preError) return yield* preError
              nextArgs = mergeToolInput(nextArgs, hookUpdatedInput(pre))
              failureArgs = nextArgs
              const permissionResult = yield* pipelineAsk({
                toolName: key,
                toolInput: nextArgs,
                cwd: input.session.directory,
                recentContext: recentText(input.messages),
                runtime: input.runtime,
                request: {
                  permission: key,
                  metadata: {},
                  patterns: ["*"],
                  always: ["*"],
                  sessionID: input.session.id,
                  tool: { messageID: input.processor.message.id, callID: opts.toolCallId },
                  ruleset: effectivePermission,
                  runtimePermission: runtimePolicy.permissionForAsk(key, key),
                  runtimeRuleset: runtimePolicy.ruleset,
                },
              }).pipe(Effect.orDie)
              nextArgs = mergeToolInput(nextArgs, permissionResult.updatedInput)
              failureArgs = nextArgs
              const ctx = context(key, nextArgs, opts)
              const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.promise(() =>
                execute(nextArgs, opts),
              )
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args: nextArgs },
                result,
              )

              const textParts: string[] = []
              const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
              for (const contentItem of result.content) {
                if (contentItem.type === "text") textParts.push(contentItem.text)
                else if (contentItem.type === "image") {
                  attachments.push({
                    type: "file",
                    mime: contentItem.mimeType,
                    url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
                  })
                } else if (contentItem.type === "resource") {
                  const { resource } = contentItem
                  if (resource.text) textParts.push(resource.text)
                  if (resource.blob) {
                    attachments.push({
                      type: "file",
                      mime: resource.mimeType ?? "application/octet-stream",
                      url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                      filename: resource.uri,
                    })
                  }
                }
              }

              const truncated = yield* truncate.output(textParts.join("\n\n"), { runtime: input.runtime }, input.agent)
              const metadata = {
                ...result.metadata,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              }

              const output = {
                title: "",
                metadata,
                output: truncated.content,
                attachments: attachments.map((attachment) => ({
                  ...attachment,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                })),
                content: result.content,
              }
              const post = yield* hookRun({
                sessionID: ctx.sessionID,
                runtime: input.runtime,
                event: "PostToolUse",
                target: key,
                data: {
                  toolName: key,
                  input: nextArgs,
                  output,
                  callID: ctx.callID,
                  messageID: input.processor.message.id,
                },
              })
              const postError = failFromHook(post)
              if (postError) return yield* postError
              const finalOutput = applyPostHookOutput(output, post, pre)
              yield* autoCheckpoint({
                runtime: input.runtime,
                tool: key,
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
                callID: ctx.callID,
              })
              if (opts.abortSignal?.aborted) {
                yield* input.processor.completeToolCall(opts.toolCallId, finalOutput)
              }
              return finalOutput
            }).pipe(
              Effect.catchCause((cause) =>
                plugin
                  .trigger(
                    "post_tool_use_failure",
                    {
                      tool: key,
                      sessionID: input.session.id,
                      callID: opts.toolCallId,
                      args: failureArgs,
                      error: causeMessage(cause),
                    },
                    {},
                  )
                  .pipe(
                    Effect.catchCause(() => Effect.void),
                    Effect.flatMap(() => Effect.failCause(cause)),
                  ),
              ),
            ),
          )
        }
        tools[key] = item
      }

      if (searchEnabled && deferredTools.length && searchTool && !runtimePolicy.isExplicitlyDenied("tool_search")) {
        const schema = ProviderTransform.schema(input.model, z.toJSONSchema(searchTool.parameters))
        tools[searchTool.id] = tool({
          description: searchTool.description,
          inputSchema: jsonSchema(schema),
          execute(args, options) {
            let failureArgs: unknown = args
            return run.promise(
              Effect.gen(function* () {
                let nextArgs = args
                failureArgs = nextArgs
                const before = yield* plugin.trigger(
                  "tool.execute.before",
                  { tool: searchTool.id, sessionID: input.session.id, callID: options.toolCallId },
                  { args: nextArgs },
                )
                nextArgs = before.args
                failureArgs = nextArgs
                const pre = yield* hookRun({
                  sessionID: input.session.id,
                  runtime: input.runtime,
                  event: "PreToolUse",
                  target: searchTool.id,
                  data: {
                    toolName: searchTool.id,
                    input: nextArgs,
                    callID: options.toolCallId,
                    messageID: input.processor.message.id,
                  },
                })
                const preError = failFromHook(pre)
                if (preError) return yield* preError
                nextArgs = mergeToolInput(nextArgs, hookUpdatedInput(pre))
                failureArgs = nextArgs
                const permissionResult = yield* pipelineAsk({
                  toolName: searchTool.id,
                  toolInput: nextArgs,
                  cwd: input.session.directory,
                  recentContext: recentText(input.messages),
                  runtime: input.runtime,
                  request: {
                    permission: searchTool.id,
                    metadata: {},
                    patterns: ["*"],
                    always: ["*"],
                    sessionID: input.session.id,
                    tool: { messageID: input.processor.message.id, callID: options.toolCallId },
                    ruleset: effectivePermission,
                    runtimePermission: runtimePolicy.permissionForAsk(searchTool.id, searchTool.id),
                    runtimeRuleset: runtimePolicy.ruleset,
                  },
                }).pipe(Effect.orDie)
                nextArgs = mergeToolInput(nextArgs, permissionResult.updatedInput)
                failureArgs = nextArgs
                const ctx = context(searchTool.id, nextArgs, options)
                const result = yield* searchTool.execute(nextArgs, ctx)
                const output = {
                  ...result,
                  attachments: result.attachments?.map((attachment) => ({
                    ...attachment,
                    id: PartID.ascending(),
                    sessionID: ctx.sessionID,
                    messageID: input.processor.message.id,
                  })),
                }
                yield* plugin.trigger(
                  "tool.execute.after",
                  { tool: searchTool.id, sessionID: ctx.sessionID, callID: ctx.callID, args: nextArgs },
                  output,
                )
                const post = yield* hookRun({
                  sessionID: ctx.sessionID,
                  runtime: input.runtime,
                  event: "PostToolUse",
                  target: searchTool.id,
                  data: {
                    toolName: searchTool.id,
                    input: nextArgs,
                    output,
                    callID: ctx.callID,
                    messageID: input.processor.message.id,
                  },
                })
                const postError = failFromHook(post)
                if (postError) return yield* postError
                const finalOutput = applyPostHookOutput(output, post, pre)
                if (options.abortSignal?.aborted)
                  yield* input.processor.completeToolCall(options.toolCallId, finalOutput)
                return finalOutput
              }).pipe(
                Effect.catchCause((cause) =>
                  plugin
                    .trigger(
                      "post_tool_use_failure",
                      {
                        tool: searchTool.id,
                        sessionID: input.session.id,
                        callID: options.toolCallId,
                        args: failureArgs,
                        error: causeMessage(cause),
                      },
                      {},
                    )
                    .pipe(
                      Effect.catchCause(() => Effect.void),
                      Effect.flatMap(() => Effect.failCause(cause)),
                    ),
                ),
              ),
            )
          },
        })
      }

      return tools
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: MessageV2.SubtaskPart
      model: Provider.Model
      lastUser: MessageV2.User
      sessionID: SessionID
      session: Session.Info
      msgs: MessageV2.WithParts[]
      runtime: SessionRuntimeConfig.RuntimeConfig
      parentMessageID?: MessageID
    }) {
      const { task, model, lastUser, sessionID, session, msgs, runtime, parentMessageID } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops(runtime)
      const { task: taskTool } = yield* registry.named()
      const taskModelRef = runtime.model ?? task.model
      const taskModel = taskModelRef
        ? yield* getModel(ProviderID.make(taskModelRef.providerID), ModelID.make(taskModelRef.modelID), sessionID)
        : model
      type DirectTaskArgs = {
        prompt: string
        description: string
        subagent_type: string
        command?: string
        spawnMode?: "fresh" | "inherit"
      }
      let explicitSpawnMode = task.spawnMode !== undefined
      const recordTaskUpdate = (update: unknown, previous?: DirectTaskArgs) => {
        if (!update || typeof update !== "object" || Array.isArray(update)) return
        if ("spawnMode" in update && (!previous || update.spawnMode !== previous.spawnMode)) {
          explicitSpawnMode = true
          return
        }
        if ("subagent_type" in update && (!previous || update.subagent_type !== previous.subagent_type)) {
          explicitSpawnMode = false
        }
      }
      const normalizeTaskArgs = Effect.fn("SessionPrompt.normalizeTaskArgs")(function* (args: DirectTaskArgs) {
        const taskAgent = yield* runtimeAgentGet(args.subagent_type, runtime)
        return {
          ...args,
          spawnMode: explicitSpawnMode
            ? (args.spawnMode ?? taskAgent?.runtime?.spawnMode ?? "fresh")
            : (taskAgent?.runtime?.spawnMode ?? "fresh"),
        }
      })
      const assistantMessage: MessageV2.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        parentMessageID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let taskArgs = yield* normalizeTaskArgs({
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
        spawnMode: task.spawnMode,
      })
      let part: MessageV2.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: taskArgs,
          time: { start: Date.now() },
        },
      })
      const runtimePolicy = RuntimeToolRules.fromConfig(runtime)
      const taskRuntimePolicy =
        task.command && !runtimePolicy.isExplicitlyDenied(TaskTool.id)
          ? RuntimeToolRules.fromConfig({
              ...runtime,
              allowedTools: [...(runtime.allowedTools ?? []), TaskTool.id],
            })
          : runtimePolicy
      if (!taskRuntimePolicy.isVisible(TaskTool.id)) {
        const error = new Permission.DeniedError({ ruleset: taskRuntimePolicy.toolRuleset })
        yield* publishRuntimeDenied(plugin, {
          sessionID,
          tool: TaskTool.id,
          callID: part.callID,
          messageID: assistantMessage.id,
          ruleset: taskRuntimePolicy.toolRuleset,
        })
        yield* plugin
          .trigger(
            "post_tool_use_failure",
            { tool: TaskTool.id, sessionID, callID: part.callID, args: taskArgs, error: error.message },
            {},
          )
          .pipe(Effect.catchCause(() => Effect.void))
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        yield* sessions.updateMessage(assistantMessage)
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error.message,
            time: { start: part.state.status === "running" ? part.state.time.start : Date.now(), end: Date.now() },
            input: part.state.input,
          },
        } satisfies MessageV2.ToolPart)
        return
      }
      const before = yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.callID },
        { args: taskArgs },
      )
      recordTaskUpdate(before.args, taskArgs)
      taskArgs = yield* normalizeTaskArgs(before.args as typeof taskArgs)
      const pre = yield* hookRun({
        sessionID,
        runtime,
        event: "PreToolUse",
        target: TaskTool.id,
        data: { toolName: TaskTool.id, input: taskArgs, callID: part.callID, messageID: assistantMessage.id },
      })
      const preError = failFromHook(pre)
      if (preError) {
        yield* plugin
          .trigger(
            "post_tool_use_failure",
            { tool: TaskTool.id, sessionID, callID: part.callID, args: taskArgs, error: preError.message },
            {},
          )
          .pipe(Effect.catchCause(() => Effect.void))
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: preError.message,
            time: { start: part.state.status === "running" ? part.state.time.start : Date.now(), end: Date.now() },
            input: part.state.input,
          },
        } satisfies MessageV2.ToolPart)
        return
      }
      const hookInputUpdate = hookUpdatedInput(pre)
      recordTaskUpdate(hookInputUpdate)
      taskArgs = yield* normalizeTaskArgs(mergeToolInput(taskArgs, hookInputUpdate) as typeof taskArgs)
      const parentAgent = yield* runtimeAgentGet(lastUser.agent, runtime)
      const authorizeTaskArgs = (
        nextArgs: typeof taskArgs,
        inputUpdates: number,
      ): Effect.Effect<typeof taskArgs, Permission.Error> =>
        normalizeTaskArgs(nextArgs).pipe(
          Effect.flatMap((resolvedArgs) =>
            pipelineAsk({
              toolName: TaskTool.id,
              toolInput: resolvedArgs,
              cwd: session.directory,
              recentContext: recentText(msgs),
              runtime,
              request: {
                permission: TaskTool.id,
                patterns: [resolvedArgs.subagent_type],
                always: ["*"],
                metadata: {
                  description: resolvedArgs.description,
                  subagent_type: resolvedArgs.subagent_type,
                  spawnMode: resolvedArgs.spawnMode,
                },
                sessionID,
                tool: { messageID: assistantMessage.id, callID: part.callID },
                ruleset: Permission.merge(parentAgent?.permission ?? [], session.permission ?? []),
                runtimePermission: taskRuntimePolicy.permissionForAsk(TaskTool.id, TaskTool.id),
                runtimeRuleset: taskRuntimePolicy.ruleset,
              },
            }).pipe(
              Effect.flatMap((result) => {
                if (!hasToolInputUpdate(resolvedArgs, result.updatedInput)) return Effect.succeed(resolvedArgs)
                if (inputUpdates >= MAX_PERMISSION_INPUT_UPDATES) {
                  return Effect.fail(
                    new Permission.CorrectedError({
                      feedback:
                        "Permission updated task input too many times; refusing to execute without stable permission metadata.",
                    }),
                  )
                }
                recordTaskUpdate(result.updatedInput)
                return authorizeTaskArgs(
                  mergeToolInput(resolvedArgs, result.updatedInput) as typeof taskArgs,
                  inputUpdates + 1,
                )
              }),
            ),
          ),
        )
      const permissionExit = yield* authorizeTaskArgs(taskArgs, 0).pipe(Effect.exit)
      if (Exit.isFailure(permissionExit)) {
        const error = Cause.squash(permissionExit.cause)
        const message = error instanceof Error ? error.message : String(error)
        yield* plugin
          .trigger(
            "post_tool_use_failure",
            { tool: TaskTool.id, sessionID, callID: part.callID, args: taskArgs, error: message },
            {},
          )
          .pipe(Effect.catchCause(() => Effect.void))
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        yield* sessions.updateMessage(assistantMessage)
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: message,
            time: { start: part.state.status === "running" ? part.state.time.start : Date.now(), end: Date.now() },
            input: part.state.input,
          },
        } satisfies MessageV2.ToolPart)
        return
      }
      taskArgs = permissionExit.value

      const taskAgentName = taskArgs.subagent_type
      const taskAgent = yield* runtimeAgentGet(taskAgentName, runtime)
      if (!taskAgent) {
        const available = (yield* runtimeAgentList(runtime)).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${taskAgentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      yield* plugin.trigger("subagent.start", { sessionID, agent: taskAgentName, callID: part.callID }, {})
      yield* hookNotify({
        sessionID,
        runtime,
        event: "SessionStateChange",
        data: { status: "subagent_start", agent: taskAgentName, callID: part.callID },
        target: "subagent_start",
      })
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: taskAgentName,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: {
            bypassAgentCheck: true,
            promptOps,
            runtime,
            prepareChildRun: () =>
              Effect.gen(function* () {
                const parentAgent = yield* runtimeAgentGet(lastUser.agent, runtime)
                return yield* prepareChildRun({
                  sessionID,
                  parentMessageID,
                  runtime,
                  effectiveMaxTurns: effectiveTurnCap(runtime, parentAgent?.steps),
                })
              }),
          },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              if (part.state.status !== "running") return
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: {
                  ...part.state,
                  title: val.title,
                  metadata: { ...val.metadata, subtask_bookkeeping: true },
                },
              } satisfies MessageV2.ToolPart)
            }),
          ask: (req: any) =>
            pipelineAsk({
              toolName: TaskTool.id,
              toolInput: taskArgs,
              cwd: session.directory,
              recentContext: recentText(msgs),
              runtime,
              request: {
                ...req,
                runtimePermission: taskRuntimePolicy.permissionForAsk(TaskTool.id, req.permission),
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
                runtimeRuleset: taskRuntimePolicy.ruleset,
              },
            }).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  taskArgs = mergeToolInput(taskArgs, result.updatedInput) as typeof taskArgs
                }),
              ),
              Effect.asVoid,
              Effect.orDie,
            ),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            log.error("subtask execution failed", { error, agent: taskAgentName, description: task.description })
            return plugin
              .trigger(
                "post_tool_use_failure",
                { tool: TaskTool.id, sessionID, callID: part.callID, args: taskArgs, error: error.message },
                {},
              )
              .pipe(
                Effect.catchCause(() => Effect.void),
                Effect.asVoid,
              )
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies MessageV2.ToolPart)
              }
            }),
          ),
        )

      if (!result) {
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        yield* sessions.updateMessage(assistantMessage)
        if (part.state.status === "running") {
          yield* sessions.updatePart({
            ...part,
            state: {
              status: "error",
              error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
              time: {
                start: part.state.time.start,
                end: Date.now(),
              },
              metadata: { ...part.state.metadata, subtask_bookkeeping: true },
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }
        return
      }

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.callID, args: taskArgs },
        result,
      )
      yield* plugin.trigger("subagent.stop", { sessionID, agent: taskAgentName, callID: part.callID }, {})
      yield* hookNotify({
        sessionID,
        runtime,
        event: "SubagentStop",
        data: { agent: taskAgentName, callID: part.callID, result },
        target: taskAgentName,
      })
      const post = yield* hookRun({
        sessionID,
        runtime,
        event: "PostToolUse",
        target: TaskTool.id,
        data: {
          toolName: TaskTool.id,
          input: taskArgs,
          output: result,
          callID: part.callID,
          messageID: assistantMessage.id,
        },
      })
      const postError = failFromHook(post)
      if (postError) {
        error = postError
        yield* plugin
          .trigger(
            "post_tool_use_failure",
            { tool: TaskTool.id, sessionID, callID: part.callID, args: taskArgs, error: postError.message },
            {},
          )
          .pipe(Effect.catchCause(() => Effect.void))
      }
      const finalResult = postError ? undefined : result ? applyPostHookOutput(result, post, pre) : result

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (finalResult && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: finalResult.title,
            metadata: { ...finalResult.metadata, subtask_bookkeeping: true },
            output: finalResult.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!finalResult) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata:
              part.state.status === "pending" ? undefined : { ...part.state.metadata, subtask_bookkeeping: true },
            input: part.state.input,
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        parentMessageID: assistantMessage.id,
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies MessageV2.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (
      input: ShellInput & { onStart?: (messageID: MessageID) => void; runtime?: SessionRuntimeConfig.RuntimeConfig },
    ) {
      const ctx = yield* InstanceState.context
      const run = yield* runner()
      const session = yield* sessions.get(input.sessionID)
      if (session.revert) {
        yield* revert.cleanup(session)
      }
      // Resolve the agent through the session's settingSources view so a
      // gated file-agent is "not found" (and its name is not enumerated).
      const agent = yield* runtimeAgentGet(input.agent, input.runtime)
      if (!agent) {
        const available = (yield* runtimeAgentList(input.runtime)).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const model = input.model ?? agent.model ?? (yield* lastModel(input.sessionID))
      const userMsg: MessageV2.User = {
        id: input.messageID ?? MessageID.ascending(),
        sessionID: input.sessionID,
        time: { created: Date.now() },
        role: "user",
        parentMessageID: yield* MessageV2.lookupLastMessageID(input.sessionID),
        agent: input.agent,
        model: { providerID: model.providerID, modelID: model.modelID },
      }
      yield* sessions.updateMessage(userMsg)
      input.onStart?.(userMsg.id)
      const userPart: MessageV2.Part = {
        type: "text",
        id: PartID.ascending(),
        messageID: userMsg.id,
        sessionID: input.sessionID,
        text: "The following tool was executed by the user",
        synthetic: true,
      }
      yield* sessions.updatePart(userPart)

      const msg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: userMsg.id,
        parentMessageID: userMsg.id,
        mode: input.agent,
        agent: input.agent,
        cost: 0,
        path: { cwd: ctx.directory, root: ctx.worktree },
        time: { created: Date.now() },
        role: "assistant",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
      }
      yield* sessions.updateMessage(msg)
      const part: MessageV2.ToolPart = {
        type: "tool",
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        tool: "bash",
        callID: ulid(),
        state: {
          status: "running",
          time: { start: Date.now() },
          input: { command: input.command },
        },
      }
      yield* sessions.updatePart(part)

      const sh = Shell.preferred()
      const shellName = (
        process.platform === "win32" ? path.win32.basename(sh, ".exe") : path.basename(sh)
      ).toLowerCase()
      const invocations: Record<string, { args: string[] }> = {
        nu: { args: ["-c", input.command] },
        fish: { args: ["-c", input.command] },
        zsh: {
          args: [
            "-l",
            "-c",
            `
              __oc_cwd=$PWD
              [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
              [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
              cd "$__oc_cwd"
              eval ${JSON.stringify(input.command)}
            `,
          ],
        },
        bash: {
          args: [
            "-l",
            "-c",
            `
              __oc_cwd=$PWD
              shopt -s expand_aliases
              [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
              cd "$__oc_cwd"
              eval ${JSON.stringify(input.command)}
            `,
          ],
        },
        cmd: { args: ["/c", input.command] },
        powershell: { args: ["-NoProfile", "-Command", input.command] },
        pwsh: { args: ["-NoProfile", "-Command", input.command] },
        "": { args: ["-c", input.command] },
      }

      const args = (invocations[shellName] ?? invocations[""]).args
      const cwd = ctx.directory
      const shellEnv = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: input.sessionID, callID: part.callID },
        { env: {} },
      )

      const cmd = ChildProcess.make(sh, args, {
        cwd,
        extendEnv: true,
        env: { ...shellEnv.env, TERM: "dumb" },
        stdin: "ignore",
        forceKillAfter: "3 seconds",
      })

      let output = ""
      let aborted = false

      const finish = Effect.uninterruptible(
        Effect.gen(function* () {
          if (aborted) {
            output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
          }
          if (!msg.time.completed) {
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          }
          if (part.state.status === "running") {
            part.state = {
              status: "completed",
              time: { ...part.state.time, end: Date.now() },
              input: part.state.input,
              title: "",
              metadata: { output, description: "" },
              output,
            }
            yield* sessions.updatePart(part)
          }
        }),
      )

      const exit = yield* Effect.gen(function* () {
        const handle = yield* spawner.spawn(cmd)
        yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
          Effect.sync(() => {
            output += chunk
            if (part.state.status === "running") {
              part.state.metadata = { output, description: "" }
              void run.fork(sessions.updatePart(part))
            }
          }),
        )
        yield* handle.exitCode
      }).pipe(
        Effect.scoped,
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            aborted = true
          }),
        ),
        Effect.orDie,
        Effect.ensuring(finish),
        Effect.exit,
      )

      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        return yield* Effect.failCause(exit.cause)
      }

      return { info: msg, parts: [part] }
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderID,
      modelID: ModelID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.data.suggestions?.length ? ` Did you mean: ${err.data.suggestions.join(", ")}?` : ""
        yield* bus.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.data.providerID}/${err.data.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.failCause(exit.cause)
    })

    const lastModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel()
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (
      input: PromptInput & {
        runtime?: SessionRuntimeConfig.RuntimeConfig
        onAccepted?: (message: MessageV2.User) => Effect.Effect<void>
      },
    ) {
      const agentName = input.agent || (yield* runtimeDefaultAgent(input.runtime))
      const ag = yield* runtimeAgentGet(agentName, input.runtime)
      if (!ag) {
        const available = (yield* runtimeAgentList(input.runtime)).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const model = input.runtime?.model
        ? {
            providerID: ProviderID.make(input.runtime.model.providerID),
            modelID: ModelID.make(input.runtime.model.modelID),
          }
        : (input.model ?? ag.model ?? (yield* lastModel(input.sessionID)))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.catchDefect(() => Effect.void))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: MessageV2.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        parentMessageID: yield* MessageV2.lookupLastMessageID(input.sessionID),
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format ?? input.runtime?.outputFormat,
      }

      yield* sessions.updateMessage(info)
      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      // Accept user text durably before potentially slow attachment or MCP resolution.
      // Stable IDs let later plugin transformations update these rows without duplicates.
      const acceptedParts = input.parts.map((part) => ({ ...part, id: part.id ?? PartID.ascending() }))
      for (const part of acceptedParts) {
        if (part.type !== "text") continue
        yield* sessions.updatePart(assign({ ...part, messageID: info.id, sessionID: input.sessionID }))
      }

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<MessageV2.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if ("text" in c && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && c.blob) {
                  const mime = "mimeType" in c ? c.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mime}]`,
                  })
                }
              }
              pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
            } else {
              const error = Cause.squash(exit.cause)
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              log.info("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              if (yield* fsys.isDir(filepath)) part.mime = "application/x-directory"

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, runtime: input.runtime, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read file", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read directory", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${part.mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const parts = yield* Effect.forEach(
        acceptedParts,
        (part, index) =>
          resolvePart(part).pipe(
            Effect.map((drafts) =>
              drafts.map((draft, position) =>
                assign({
                  ...draft,
                  // Reserve ordering before asynchronous expansion. Generated children
                  // remain under their source's prefix; supplied IDs remain opaque.
                  id:
                    part.type === "text"
                      ? part.id
                      : input.parts[index].id && draft.id
                        ? draft.id
                        : `${part.id}_${String(position).padStart(6, "0")}`,
                }),
              ),
            ),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((x) => x.flat()))

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts },
      )
      for (const part of acceptedParts) {
        if (part.type !== "text" || parts.some((item) => item.id === part.id)) continue
        yield* sessions.removePart({ sessionID: input.sessionID, messageID: info.id, partID: PartID.make(part.id) })
      }
      yield* plugin.trigger("user.prompt.submit", { sessionID: input.sessionID, messageID: info.id }, {})
      yield* hookNotify({
        sessionID: input.sessionID,
        runtime: input.runtime,
        event: "UserPromptSubmit",
        data: { messageID: info.id, agent: info.agent, model: info.model, parts },
      })

      const parsed = MessageV2.Info.safeParse(info)
      if (!parsed.success) {
        log.error("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          issues: parsed.error.issues,
        })
      }
      parts.forEach((part, index) => {
        const p = MessageV2.Part.safeParse(part)
        if (p.success) return
        log.error("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          issues: p.error.issues,
          part,
        })
      })

      yield* sessions.updateMessage(info)
      if (input.onAccepted) yield* input.onAccepted(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const prompt: (
      input: PromptInput & {
        runtime?: SessionRuntimeConfig.RuntimeConfig
        onAccepted?: (message: MessageV2.User) => Effect.Effect<void>
      },
    ) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.prompt")(function* (
      input: PromptInput & {
        runtime?: SessionRuntimeConfig.RuntimeConfig
        onAccepted?: (message: MessageV2.User) => Effect.Effect<void>
      },
    ) {
      const session = yield* sessions.get(input.sessionID)
      yield* revert.cleanup(session)
      const runtime = (yield* acceptedRuntime({ sessionID: input.sessionID, runtime: input.runtime })).runtime
      const message = yield* createUserMessage({ ...input, runtime })
      messageRuntime.set(message.info.id, runtime)
      yield* sessions.touch(input.sessionID)

      const permissions: Permission.Ruleset = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      return yield* loop({ sessionID: input.sessionID, parentMessageID: message.info.id, runtime })
    })

    const promptAsync = Effect.fn("SessionPrompt.promptAsync")(function* (
      input: PromptInput & { runtime?: SessionRuntimeConfig.RuntimeConfig },
    ) {
      const runtime = (yield* acceptedRuntime({ sessionID: input.sessionID, runtime: input.runtime })).runtime
      const accepted = yield* Deferred.make<MessageV2.User>()
      yield* prompt({
        ...input,
        runtime,
        onAccepted: (message) => Deferred.succeed(accepted, message).pipe(Effect.asVoid),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Deferred.die(accepted, Cause.squash(cause)).pipe(Effect.ignore)
            const message = Cause.pretty(cause)
            log.error("prompt_async failed", { sessionID: input.sessionID, cause: message })
            yield* bus.publish(Session.Event.Error, {
              sessionID: input.sessionID,
              error: new NamedError.Unknown({ message }).toObject(),
            })
          }),
        ),
        Effect.forkIn(scope),
      )
      return yield* Deferred.await(accepted)
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user")
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 })
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const zeroUsage = (): MessageV2.Assistant["tokens"] => ({
      total: undefined,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })

    const mergeUsage = (target: MessageV2.Assistant["tokens"], next: MessageV2.Assistant["tokens"]) => {
      target.total =
        target.total !== undefined || next.total !== undefined ? (target.total ?? 0) + (next.total ?? 0) : undefined
      target.input += next.input
      target.output += next.output
      target.reasoning += next.reasoning
      target.cache.read += next.cache.read
      target.cache.write += next.cache.write
      return target
    }

    const errorMessage = (error: NonNullable<MessageV2.Assistant["error"]>) => {
      const data = error.data
      if (typeof data !== "object" || !data) return error.name
      if (!("message" in data) || typeof data.message !== "string") return error.name
      return data.message
    }

    const isUserBoundary = (message: MessageV2.WithParts) => {
      if (message.info.role !== "user") return false
      if (message.parts.length === 0) return true
      return message.parts.some((part) => {
        if (part.type === "text") return part.synthetic !== true
        if (part.type === "compaction" || part.type === "subtask") return false
        return true
      })
    }

    const indexByID = (messages: MessageV2.WithParts[]) =>
      new Map(messages.map((message, index) => [message.info.id, index]))

    const isAfter = (
      messages: MessageV2.WithParts[],
      left: MessageV2.Info | undefined,
      right: MessageV2.Info | undefined,
    ) => {
      if (!left || !right) return false
      const indexes = indexByID(messages)
      const leftIndex = indexes.get(left.id)
      const rightIndex = indexes.get(right.id)
      if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex > rightIndex
      return left.time.created > right.time.created
    }

    const messagesForResult = (messages: MessageV2.WithParts[], parentMessageID?: MessageID) => {
      if (!parentMessageID) return messages
      const index = messages.findIndex((message) => message.info.id === parentMessageID)
      const candidates = index === -1 ? descendantsOf(messages, parentMessageID) : messages.slice(index + 1)
      const nextUser = candidates.findIndex(isUserBoundary)
      if (nextUser === -1) return candidates
      return candidates.slice(0, nextUser)
    }

    const descendantsOf = (messages: MessageV2.WithParts[], parentMessageID: MessageID) => {
      const parents = new Set<string>([parentMessageID])
      return messages.filter((message) => {
        const directParent =
          message.info.role === "assistant"
            ? parents.has(message.info.parentID) ||
              (!!message.info.parentMessageID && parents.has(message.info.parentMessageID))
            : !!message.info.parentMessageID && parents.has(message.info.parentMessageID)
        if (directParent) parents.add(message.info.id)
        return directParent
      })
    }

    const mergeModelUsage = (
      map: Map<string, { tokens: MessageV2.Assistant["tokens"]; cost: number }>,
      key: string,
      next: { tokens: MessageV2.Assistant["tokens"]; cost: number },
    ) => {
      const existing = map.get(key) ?? { tokens: zeroUsage(), cost: 0 }
      existing.cost += next.cost
      mergeUsage(existing.tokens, next.tokens)
      map.set(key, existing)
    }

    const taskChildRef = (part: MessageV2.ToolPart) => {
      if (part.tool !== TaskTool.id) return
      const metadata = part.state.status === "pending" ? undefined : part.state.metadata
      if (typeof metadata?.sessionId !== "string") return
      if (typeof metadata.messageId !== "string") return
      return {
        sessionID: SessionID.make(metadata.sessionId),
        parentMessageID: MessageID.make(metadata.messageId),
      }
    }

    const isSubtaskBookkeeping = (message: MessageV2.WithParts) =>
      message.info.role === "assistant" &&
      message.parts.some((part) => {
        if (part.type !== "tool") return false
        if (part.tool !== TaskTool.id) return false
        if (part.state.status === "pending") return false
        return part.state.metadata?.subtask_bookkeeping === true
      })

    const effectiveTurnCap = (runtime: SessionRuntimeConfig.RuntimeConfig, agentSteps?: number) =>
      runtime.maxTurns === undefined
        ? agentSteps
        : agentSteps === undefined
          ? runtime.maxTurns
          : Math.min(runtime.maxTurns, agentSteps)

    type ResultAggregateInput = {
      sessionID: SessionID
      parentMessageID?: MessageID
      visited?: Set<string>
    }
    type ResultAggregate = {
      assistants: MessageV2.Assistant[]
      numTurns: number
      last?: MessageV2.Assistant
      usage: MessageV2.Assistant["tokens"]
      totalCostUsd: number
      modelUsage?: Record<string, { tokens: MessageV2.Assistant["tokens"]; cost: number }>
    }

    const aggregateResult: (input: ResultAggregateInput) => Effect.Effect<ResultAggregate> = Effect.fn(
      "SessionPrompt.aggregateResult",
    )(function* (input: ResultAggregateInput) {
      const messages = yield* sessions.messages({ sessionID: input.sessionID })
      const resultMessages = messagesForResult(messages, input.parentMessageID)
      const assistants = resultMessages.flatMap((message) => {
        if (message.info.role !== "assistant") return []
        return [message.info]
      })
      const costAssistants = resultMessages.flatMap((message) => {
        if (message.info.role !== "assistant") return []
        if (isSubtaskBookkeeping(message)) return []
        return [message.info]
      })
      const turnAssistants = costAssistants.filter((assistant) => assistant.summary !== true)
      const usage = costAssistants.reduce((acc, assistant) => mergeUsage(acc, assistant.tokens), zeroUsage())
      let totalCostUsd = costAssistants.reduce((sum, assistant) => sum + assistant.cost, 0)
      const modelUsageMap = new Map<string, { tokens: MessageV2.Assistant["tokens"]; cost: number }>()

      for (const assistant of costAssistants) {
        mergeModelUsage(modelUsageMap, `${assistant.providerID}/${assistant.modelID}`, {
          tokens: assistant.tokens,
          cost: assistant.cost,
        })
      }

      let numTurns = turnAssistants.length
      const visited = input.visited ?? new Set<string>()
      for (const child of resultMessages.flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.type !== "tool") return []
          const ref = taskChildRef(part)
          return ref ? [ref] : []
        }),
      )) {
        const key = `${child.sessionID}:${child.parentMessageID}`
        if (visited.has(key)) continue
        visited.add(key)
        const childSummary = yield* aggregateResult({
          sessionID: child.sessionID,
          parentMessageID: child.parentMessageID,
          visited,
        })
        totalCostUsd += childSummary.totalCostUsd
        numTurns += childSummary.numTurns
        mergeUsage(usage, childSummary.usage)
        for (const [modelKey, item] of Object.entries(childSummary.modelUsage ?? {})) {
          mergeModelUsage(modelUsageMap, modelKey, item)
        }
      }

      return {
        assistants,
        numTurns,
        last: assistants.at(-1),
        usage,
        totalCostUsd,
        modelUsage: modelUsageMap.size ? Object.fromEntries(modelUsageMap.entries()) : undefined,
      } satisfies ResultAggregate
    })

    // Cost/usage span annotation (GenAI semconv): input_tokens covers cached
    // input, output_tokens covers reasoning; the cognitio.usage.* breakdown
    // preserves the split.
    const annotateUsage = (summary: ResultAggregate) =>
      Effect.annotateCurrentSpan({
        "gen_ai.usage.input_tokens": summary.usage.input + summary.usage.cache.read + summary.usage.cache.write,
        "gen_ai.usage.output_tokens": summary.usage.output + summary.usage.reasoning,
        "cognitio.usage.cache_read_tokens": summary.usage.cache.read,
        "cognitio.usage.cache_write_tokens": summary.usage.cache.write,
        "cognitio.usage.reasoning_tokens": summary.usage.reasoning,
        "cognitio.cost_usd": summary.totalCostUsd,
        "cognitio.num_turns": summary.numTurns,
      })

    type HardResult = {
      subtype: "error_max_turns" | "error_max_budget" | "error_max_structured_output_retries"
      error: {
        name: string
        message: string
      }
    }
    type HardResultLatch = {
      value?: HardResult
    }
    type CountModelTurnsInput = {
      sessionID: SessionID
      parentMessageID?: MessageID
      visited?: Set<string>
    }
    type PreparedChildRun =
      | { type: "continue"; runtime?: SessionRuntimeConfig.RuntimeConfig }
      | { type: "blocked"; output: string }

    const latchHardResult = (latch: HardResultLatch, result: HardResult) => {
      if (latch.value) return
      latch.value = result
    }

    const countModelTurns: (input: CountModelTurnsInput) => Effect.Effect<number> = Effect.fn(
      "SessionPrompt.countModelTurns",
    )(function* (input: CountModelTurnsInput) {
      const messages = yield* sessions.messages({ sessionID: input.sessionID })
      const resultMessages = messagesForResult(messages, input.parentMessageID)
      const ownTurns = resultMessages.filter((message) => {
        if (message.info.role !== "assistant") return false
        if (message.info.summary === true) return false
        return !isSubtaskBookkeeping(message)
      }).length
      let childTurns = 0
      const visited = input.visited ?? new Set<string>()
      for (const child of resultMessages.flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.type !== "tool") return []
          const ref = taskChildRef(part)
          return ref ? [ref] : []
        }),
      )) {
        const key = `${child.sessionID}:${child.parentMessageID}`
        if (visited.has(key)) continue
        visited.add(key)
        childTurns += yield* countModelTurns({
          sessionID: child.sessionID,
          parentMessageID: child.parentMessageID,
          visited,
        })
      }
      return ownTurns + childTurns
    })

    const checkBudget = Effect.fn("SessionPrompt.checkBudget")(function* (input: {
      sessionID: SessionID
      parentMessageID?: MessageID
      runtime: SessionRuntimeConfig.RuntimeConfig
      hardResult: HardResultLatch
    }) {
      if (input.runtime.maxBudgetUsd === undefined) return false
      const summary = yield* aggregateResult({ sessionID: input.sessionID, parentMessageID: input.parentMessageID })
      if (summary.totalCostUsd < input.runtime.maxBudgetUsd) return false
      latchHardResult(input.hardResult, {
        subtype: "error_max_budget",
        error: {
          name: "MaxBudgetExceededError",
          message: `Maximum budget exceeded: ${summary.totalCostUsd} >= ${input.runtime.maxBudgetUsd}`,
        },
      })
      return true
    })

    const prepareChildRun: (input: {
      sessionID: SessionID
      parentMessageID?: MessageID
      runtime: SessionRuntimeConfig.RuntimeConfig
      effectiveMaxTurns?: number
      pendingParentAssistant?: MessageV2.Assistant
    }) => Effect.Effect<PreparedChildRun> = Effect.fn("SessionPrompt.prepareChildRun")(function* (input: {
      sessionID: SessionID
      parentMessageID?: MessageID
      runtime: SessionRuntimeConfig.RuntimeConfig
      effectiveMaxTurns?: number
      pendingParentAssistant?: MessageV2.Assistant
    }) {
      const summary = yield* aggregateResult({
        sessionID: input.sessionID,
        parentMessageID: input.parentMessageID,
      })
      const modelTurns =
        input.effectiveMaxTurns === undefined
          ? undefined
          : yield* countModelTurns({
              sessionID: input.sessionID,
              parentMessageID: input.parentMessageID,
            })
      const remainingTurns =
        input.effectiveMaxTurns === undefined || modelTurns === undefined
          ? undefined
          : input.effectiveMaxTurns - modelTurns
      if (remainingTurns !== undefined && remainingTurns <= 0) {
        return {
          type: "blocked" as const,
          output: `Maximum turns exceeded: ${input.effectiveMaxTurns}`,
        }
      }
      const remainingBudget =
        input.runtime.maxBudgetUsd === undefined ? undefined : input.runtime.maxBudgetUsd - summary.totalCostUsd
      if (remainingBudget !== undefined && remainingBudget <= 0) {
        return {
          type: "blocked" as const,
          output: `Maximum budget exceeded: ${summary.totalCostUsd} >= ${input.runtime.maxBudgetUsd}`,
        }
      }
      if (
        remainingBudget !== undefined &&
        input.pendingParentAssistant !== undefined &&
        input.pendingParentAssistant.finish === undefined
      ) {
        return {
          type: "blocked" as const,
          output: "Child task blocked until parent assistant budget is finalized under maxBudgetUsd",
        }
      }
      return {
        type: "continue" as const,
        runtime: {
          ...input.runtime,
          ...(remainingTurns === undefined ? {} : { maxTurns: remainingTurns }),
          ...(remainingBudget === undefined ? {} : { maxBudgetUsd: remainingBudget }),
        },
      }
    })

    const publishResult = Effect.fn("SessionPrompt.publishResult")(function* (input: {
      sessionID: SessionID
      parentMessageID?: MessageID
      exit: Exit.Exit<MessageV2.WithParts, never>
      hardResult?: HardResult
      runtime?: SessionRuntimeConfig.RuntimeConfig
    }) {
      const parentMessageID = input.parentMessageID
      const summary = yield* aggregateResult({ sessionID: input.sessionID, parentMessageID })
      const last = summary.last

      const interrupted = Exit.isFailure(input.exit) && Cause.hasInterruptsOnly(input.exit.cause)
      const assistantAborted = !!last?.error && MessageV2.AbortedError.isInstance(last.error)
      const failed = !!last?.error || (Exit.isFailure(input.exit) && !interrupted)
      const subtype =
        input.hardResult?.subtype ??
        (interrupted || assistantAborted ? "error_aborted" : failed ? "error_during_execution" : "success")

      let error: { name: string; message: string } | undefined = input.hardResult?.error
      if (last?.error && subtype === "error_during_execution") {
        error = { name: last.error.name, message: errorMessage(last.error) }
      }
      if (!error && Exit.isFailure(input.exit) && !interrupted) {
        const cause = Cause.squash(input.exit.cause)
        error = {
          name: cause instanceof Error ? cause.name : "Error",
          message: cause instanceof Error ? cause.message : String(cause),
        }
      }

      yield* plugin.trigger("agent.stop", { sessionID: input.sessionID, subtype, stopReason: last?.finish }, {})
      yield* hookNotify({
        sessionID: input.sessionID,
        runtime: (last?.parentID ? messageRuntime.get(last.parentID) : undefined) ?? input.runtime,
        event: "Stop",
        data: { subtype, stopReason: last?.finish, error },
      })
      const finalMessage = last
        ? yield* sessions.findMessage(input.sessionID, (message) => message.info.id === last.id)
        : Option.none()
      const finalText = Option.isSome(finalMessage)
        ? finalMessage.value.parts
            .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.ignored)
            .map((part) => part.text)
            .join("") || undefined
        : undefined
      yield* bus.publish(Session.Event.Result, {
        sessionID: input.sessionID,
        messageID: last?.id,
        parentMessageID,
        subtype,
        stopReason: last?.finish,
        numTurns: summary.numTurns,
        totalCostUsd: summary.totalCostUsd,
        usage: summary.numTurns || summary.modelUsage ? summary.usage : undefined,
        modelUsage: summary.modelUsage,
        structuredOutput: last?.structured,
        finalText,
        error,
      })
    })

    const runLoop: (input: {
      sessionID: SessionID
      parentMessageID?: MessageID
      hardResult: HardResultLatch
      runtime: SessionRuntimeConfig.RuntimeConfig
    }) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.run")(function* (input) {
      const sessionID = input.sessionID
      const ctx = yield* InstanceState.context
      const slog = elog.with({ sessionID })
      let structured: unknown | undefined
      let structuredUserID: MessageID | undefined
      let structuredRetries = 0
      let structuredRetryFeedback: ModelMessage | undefined
      let step = 0
      const session = yield* sessions.get(sessionID)
      const selectedDeferredTools = new Set<string>()

      while (true) {
        yield* status.set(sessionID, { type: "busy" }, input.runtime)
        yield* slog.info("loop", { step })

        let msgs = yield* MessageV2.filterCompactedEffect(sessionID)

        let lastUser: MessageV2.User | undefined
        let lastAssistant: MessageV2.Assistant | undefined
        let lastFinished: MessageV2.Assistant | undefined
        let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (!lastUser && msg.info.role === "user") lastUser = msg.info
          if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info
          if (!lastFinished && msg.info.role === "assistant" && msg.info.finish) lastFinished = msg.info
          if (lastUser && lastFinished) break
          const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
          if (task && !lastFinished) tasks.push(...task)
        }

        if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
        if (structuredUserID !== lastUser.id) {
          structuredUserID = lastUser.id
          structured = undefined
          structuredRetries = 0
          structuredRetryFeedback = undefined
        }
        const runtime = messageRuntime.get(lastUser.id) ?? input.runtime

        if (
          yield* checkBudget({
            sessionID,
            parentMessageID: input.parentMessageID,
            runtime,
            hardResult: input.hardResult,
          })
        )
          break

        const lastAssistantMsg = msgs.findLast(
          (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
        )
        // Some providers return "stop" even when the assistant message contains tool calls.
        // Keep the loop running so tool results can be sent back to the model.
        // Skip provider-executed tool parts — those were fully handled within the
        // provider's stream (e.g. DWS Agent Platform) and don't need a re-loop.
        const hasToolCalls =
          lastAssistantMsg?.parts.some((part) => part.type === "tool" && !part.metadata?.providerExecuted) ?? false

        if (
          lastAssistant?.finish &&
          !["tool-calls"].includes(lastAssistant.finish) &&
          !hasToolCalls &&
          !structuredRetryFeedback &&
          isAfter(msgs, lastAssistant, lastUser)
        ) {
          yield* slog.info("exiting loop")
          break
        }

        step++
        if (step === 1)
          yield* title({
            runtime,
            session,
            modelID: lastUser.model.modelID,
            providerID: lastUser.model.providerID,
            history: msgs,
          }).pipe(Effect.ignore, Effect.forkIn(scope))

        const modelRef = runtime.model ?? lastUser.model
        const model = yield* getModel(ProviderID.make(modelRef.providerID), ModelID.make(modelRef.modelID), sessionID)
        const task = tasks.pop()

        if (task?.type === "subtask") {
          yield* handleSubtask({
            task,
            model,
            lastUser,
            sessionID,
            session,
            msgs,
            runtime,
            parentMessageID: input.parentMessageID,
          })
          if (
            yield* checkBudget({
              sessionID,
              parentMessageID: input.parentMessageID,
              runtime,
              hardResult: input.hardResult,
            })
          )
            break
          continue
        }

        if (task?.type === "compaction") {
          const result = yield* compaction.process({
            messages: msgs,
            parentID: lastUser.id,
            sessionID,
            auto: task.auto,
            model: lastUser.model,
            overflow: task.overflow,
            runtime,
          })
          if (
            yield* checkBudget({
              sessionID,
              parentMessageID: input.parentMessageID,
              runtime,
              hardResult: input.hardResult,
            })
          )
            break
          if (result === "stop") break
          continue
        }

        if (
          lastFinished &&
          lastFinished.summary !== true &&
          runtime.compaction?.auto !== false &&
          (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
        ) {
          yield* compaction.create({
            sessionID,
            agent: lastUser.agent,
            model: runtime.model
              ? {
                  providerID: ProviderID.make(runtime.model.providerID),
                  modelID: ModelID.make(runtime.model.modelID),
                }
              : lastUser.model,
            auto: true,
          })
          continue
        }

        const agent = yield* runtimeAgentGet(lastUser.agent, runtime)
        if (!agent) {
          const available = (yield* runtimeAgentList(runtime)).filter((a) => !a.hidden).map((a) => a.name)
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
          yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
          throw error
        }
        const runtimeTurnCap = effectiveTurnCap(runtime, agent.steps)
        if (runtimeTurnCap !== undefined) {
          const modelTurns = yield* countModelTurns({
            sessionID,
            parentMessageID: input.parentMessageID,
          })
          if (modelTurns >= runtimeTurnCap) {
            latchHardResult(input.hardResult, {
              subtype: "error_max_turns",
              error: {
                name: "MaxTurnsExceededError",
                message: `Maximum turns exceeded: ${runtimeTurnCap}`,
              },
            })
            yield* slog.info("max turns exceeded", { maxTurns: runtimeTurnCap, turns: modelTurns })
            break
          }
        }
        const maxSteps = agent.steps ?? Infinity
        const isLastStep = step >= maxSteps
        msgs = yield* insertReminders({ messages: msgs, agent, session })

        const msg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          parentID: lastUser.id,
          parentMessageID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.model.variant,
          path: { cwd: ctx.directory, root: ctx.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.id,
          providerID: model.providerID,
          time: { created: Date.now() },
          sessionID,
        }
        yield* sessions.updateMessage(msg)
        const handle = yield* processor.create({
          assistantMessage: msg,
          sessionID,
          model,
          runtime,
        })

        const outcome: "break" | "continue" = yield* Effect.gen(function* () {
          const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
          const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

          const tools = yield* resolveTools({
            agent,
            session,
            model,
            parentMessageID: input.parentMessageID,
            tools: lastUser.tools,
            processor: handle,
            bypassAgentCheck,
            messages: msgs,
            runtime,
            selectedDeferredTools,
          })

          const format = lastUser.format ?? { type: "text" as const }
          if (format.type === "json_schema") {
            tools["StructuredOutput"] = createStructuredOutputTool({
              schema: format.schema,
              onSuccess(output) {
                structured = output
                structuredUserID = lastUser.id
              },
            })
          }

          if (step === 1)
            yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

          if (step > 1 && lastFinished) {
            const lastFinishedIndex = msgs.findIndex((m) => m.info.id === lastFinished.id)
            for (const [index, m] of msgs.entries()) {
              if (m.info.role !== "user") continue
              if (lastFinishedIndex !== -1 && index <= lastFinishedIndex) continue
              if (lastFinishedIndex === -1 && !isAfter(msgs, m.info, lastFinished)) continue
              for (const p of m.parts) {
                if (p.type !== "text" || p.ignored || p.synthetic) continue
                if (!p.text.trim()) continue
                p.text = [
                  "<system-reminder>",
                  "The user sent the following message:",
                  p.text,
                  "",
                  "Please address this message and continue with your tasks.",
                  "</system-reminder>",
                ].join("\n")
              }
            }
          }

          yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

          const resolvedSystemPrompt = resolveSystemPrompt(runtime)
          const [skills, env, instructions, modelMsgs] = yield* Effect.all([
            sys.skills(agent, runtime, input.sessionID),
            Effect.sync(() => (runtime.includeEnvironment === false ? [] : sys.environment(model))),
            instruction.system(resolvedSystemPrompt.instructionSources).pipe(Effect.orDie),
            MessageV2.toModelMessagesEffect(msgs, model),
          ])
          const system = [...env, ...(skills ? [skills] : []), ...instructions]
          if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
          const retryFeedback = structuredRetryFeedback
          structuredRetryFeedback = undefined
          const runtimePolicy = RuntimeToolRules.fromConfig(runtime)
          const runtimePermission = Permission.merge(
            session.permission ?? [],
            runtimePolicy.toolRuleset,
            tools.tool_search && !runtimePolicy.isExplicitlyDenied("tool_search")
              ? [{ permission: "tool_search", pattern: "*", action: "allow" }]
              : [],
          )
          const result = yield* handle.process({
            user: lastUser,
            agent,
            permission: runtimePermission,
            sessionID,
            parentSessionID: session.parentID,
            system,
            systemPromptOverride: {
              ...(resolvedSystemPrompt.agentPromptOverride !== undefined
                ? { agentPromptOverride: resolvedSystemPrompt.agentPromptOverride }
                : {}),
              ...(resolvedSystemPrompt.appendToFinal !== undefined
                ? { appendToFinal: resolvedSystemPrompt.appendToFinal }
                : {}),
            },
            messages: [
              ...modelMsgs,
              ...(retryFeedback ? [retryFeedback] : []),
              ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : []),
            ],
            tools,
            model,
            toolChoice: format.type === "json_schema" ? "required" : undefined,
          })

          if (structuredUserID === lastUser.id && structured !== undefined) {
            handle.message.structured = structured
            handle.message.finish = handle.message.finish ?? "stop"
            yield* sessions.updateMessage(handle.message)
            return "break" as const
          }

          const finished = handle.message.finish && handle.message.finish !== "tool-calls"
          if (format.type === "json_schema" && !handle.message.error) {
            const structuredFailure =
              MessageV2.parts(handle.message.id).map(structuredOutputFailure).findLast(Boolean) ??
              (finished ? "Model did not produce structured output" : undefined)
            if (structuredFailure) {
              if (structuredRetries < format.retryCount) {
                structuredRetries++
                structuredRetryFeedback = structuredOutputRetryMessage({
                  reason: structuredFailure,
                  attempt: structuredRetries,
                  retryCount: format.retryCount,
                })
                return "continue" as const
              }
              handle.message.error = new MessageV2.StructuredOutputError({
                message: structuredFailure,
                retries: structuredRetries,
              }).toObject()
              yield* sessions.updateMessage(handle.message)
              latchHardResult(input.hardResult, {
                subtype: "error_max_structured_output_retries",
                error: {
                  name: "StructuredOutputError",
                  message: structuredFailure,
                },
              })
              return "break" as const
            }
          }

          if (result === "stop") return "break" as const
          if (result === "compact") {
            yield* compaction.create({
              sessionID,
              agent: lastUser.agent,
              model: runtime.model
                ? {
                    providerID: ProviderID.make(runtime.model.providerID),
                    modelID: ModelID.make(runtime.model.modelID),
                  }
                : lastUser.model,
              auto: true,
              overflow: !handle.message.finish,
            })
          }
          return "continue" as const
        }).pipe(Effect.ensuring(instruction.clear(handle.message.id)))
        if (
          yield* checkBudget({
            sessionID,
            parentMessageID: input.parentMessageID,
            runtime,
            hardResult: input.hardResult,
          })
        )
          break
        if (outcome === "break") break
        continue
      }

      yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
      // Single success exit of the run loop: stamp aggregate cost/usage on the
      // SessionPrompt.run span (GenAI semconv totals: input includes cache,
      // output includes reasoning). Interrupt/defect exits skip this.
      yield* annotateUsage(yield* aggregateResult({ sessionID, parentMessageID: input.parentMessageID }))
      return yield* lastAssistant(sessionID)
    })

    const loop: (
      input: z.infer<typeof LoopInput> & { runtime?: SessionRuntimeConfig.RuntimeConfig },
    ) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: z.infer<typeof LoopInput> & { runtime?: SessionRuntimeConfig.RuntimeConfig },
    ) {
      const lastUser = yield* sessions.findMessage(input.sessionID, (message) => message.info.role === "user")
      const parentMessageID =
        input.parentMessageID ??
        (() => {
          if (Option.isNone(lastUser) || lastUser.value.info.role !== "user") return undefined
          return lastUser.value.info.id
        })()
      const hardResult: HardResultLatch = {}
      const snapshot = yield* acceptedRuntime({ sessionID: input.sessionID, runtime: input.runtime })
      const runtime = snapshot.runtime
      const trackPending = snapshot.state?._tag === "Interrupting" || snapshot.state?._tag === "Shell"
      if (trackPending && !pendingRuntime.has(input.sessionID)) pendingRuntime.set(input.sessionID, runtime)
      const work = Effect.gen(function* () {
        const ownsRuntime = !activeRuntime.has(input.sessionID)
        if (ownsRuntime) activeRuntime.set(input.sessionID, runtime)
        if (pendingRuntime.get(input.sessionID) === runtime) pendingRuntime.delete(input.sessionID)
        return yield* runLoop({ sessionID: input.sessionID, parentMessageID, hardResult, runtime }).pipe(
          Effect.ensuring(
            ownsRuntime
              ? Effect.sync(() => {
                  if (activeRuntime.get(input.sessionID) === runtime) activeRuntime.delete(input.sessionID)
                })
              : Effect.void,
          ),
        )
      })
      return yield* state
        .ensureRunning(
          input.sessionID,
          lastAssistant(input.sessionID),
          work,
          (exit) =>
            publishResult({
              sessionID: input.sessionID,
              parentMessageID,
              exit,
              hardResult: hardResult.value,
              runtime,
            }),
          runtime,
        )
        .pipe(
          trackPending
            ? Effect.ensuring(
                Effect.sync(() => {
                  if (pendingRuntime.get(input.sessionID) === runtime) pendingRuntime.delete(input.sessionID)
                }),
              )
            : (effect) => effect,
        )
    })

    const shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.shell")(
      function* (input: ShellInput) {
        let parentMessageID = yield* MessageV2.lookupLastMessageID(input.sessionID)
        const snapshot = yield* acceptedRuntime({ sessionID: input.sessionID })
        return yield* state.startShell(
          input.sessionID,
          lastAssistant(input.sessionID),
          shellImpl({
            ...input,
            runtime: snapshot.runtime,
            onStart(messageID) {
              parentMessageID = messageID
            },
          }),
          (exit) => publishResult({ sessionID: input.sessionID, parentMessageID, exit, runtime: snapshot.runtime }),
          // Feed the accepted runtime to the run-state so SessionStateChange /
          // Stop hooks fire with the session's runtime snapshot.
          snapshot.runtime,
        )
      },
    )

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* elog.info("command", { sessionID: input.sessionID, command: input.command, agent: input.agent })
      const snapshot = yield* acceptedRuntime({ sessionID: input.sessionID })
      const runtime = snapshot.runtime
      const cmd = yield* CommandRuntime.get(input.command, runtime, input.sessionID).pipe(
        Effect.provideService(Command.Service, commandSvc),
      )
      if (!cmd) {
        const available = (yield* CommandRuntime.list(runtime, input.sessionID).pipe(
          Effect.provideService(Command.Service, commandSvc),
        )).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent ?? (yield* runtimeDefaultAgent(runtime))

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = RuntimePlugin.substitute(yield* Effect.promise(async () => cmd.template), {
        sessionID: input.sessionID,
        pluginRoot: cmd.pluginRoot,
        skillDir: cmd.skillDir,
      })

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const sh = Shell.preferred()
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const runtimeModel = runtime.model
        ? {
            providerID: ProviderID.make(runtime.model.providerID),
            modelID: ModelID.make(runtime.model.modelID),
          }
        : undefined
      const taskModel =
        runtimeModel ??
        (yield* Effect.gen(function* () {
          if (cmd.model) return Provider.parseModel(cmd.model)
          if (cmd.agent) {
            const cmdAgent = yield* runtimeAgentGet(cmd.agent, runtime)
            if (cmdAgent?.model) return cmdAgent.model
          }
          if (input.model) return Provider.parseModel(input.model)
          return yield* lastModel(input.sessionID)
        }))

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = yield* runtimeAgentGet(agentName, runtime)
      if (!agent) {
        const available = (yield* runtimeAgentList(runtime)).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const commandRuntime = finalizeRuntime(CommandRuntime.applyToolPolicy(runtime, cmd))
      const templateParts = yield* resolvePromptParts(template, commandRuntime)
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              spawnMode: agent.runtime?.spawnMode,
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...templateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* runtimeDefaultAgent(runtime))) : agentName
      const userModel =
        runtimeModel ??
        (isSubtask ? (input.model ? Provider.parseModel(input.model) : yield* lastModel(input.sessionID)) : taskModel)

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
        runtime: commandRuntime,
      })
      yield* bus.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      promptAsync,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(PermissionClassifier.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(ToolRegistry.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        Session.defaultLayer,
        SessionCheckpoint.defaultLayer,
        SessionRuntimeConfig.defaultLayer,
        SessionRevert.defaultLayer,
        SessionSummary.defaultLayer,
        Agent.defaultLayer,
        SystemPrompt.defaultLayer,
        LLM.defaultLayer,
        Bus.layer,
        CrossSpawnSpawner.defaultLayer,
      ),
    ),
  ),
)
export const PromptInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  agent: z.string().optional(),
  noReply: z.boolean().optional(),
  tools: z
    .record(z.string(), z.boolean())
    .optional()
    .describe("@deprecated tools and permissions have been merged, you can set permissions on the session itself now"),
  format: MessageV2.Format.optional(),
  system: z.string().optional(),
  variant: z.string().optional(),
  parts: z.array(
    z.discriminatedUnion("type", [
      MessageV2.TextPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "TextPartInput",
        }),
      MessageV2.FilePart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "FilePartInput",
        }),
      MessageV2.AgentPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "AgentPartInput",
        }),
      MessageV2.SubtaskPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "SubtaskPartInput",
        }),
    ]),
  ),
})
export type PromptInput = z.infer<typeof PromptInput>

export const LoopInput = z.object({
  sessionID: SessionID.zod,
  parentMessageID: MessageID.zod.optional(),
})

export const ShellInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
  agent: z.string(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  command: z.string(),
})
export type ShellInput = z.infer<typeof ShellInput>

export const CommandInput = z.object({
  messageID: MessageID.zod.optional(),
  sessionID: SessionID.zod,
  agent: z.string().optional(),
  model: z.string().optional(),
  arguments: z.string(),
  command: z.string(),
  variant: z.string().optional(),
  parts: z
    .array(
      z.discriminatedUnion("type", [
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        }).partial({
          id: true,
        }),
      ]),
    )
    .optional(),
})
export type CommandInput = z.infer<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, unknown>
  onSuccess: (output: unknown) => void
  onFailure?: (message: string) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const toolSchema = Object.fromEntries(Object.entries(input.schema).filter(([key]) => key !== "$schema"))
  const validate = structuredOutputAjv(input.schema).compile(input.schema)

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      if (!validate(args)) {
        const message = structuredOutputValidationMessage(validate.errors)
        input.onFailure?.(message)
        throw new Error(message)
      }
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export * as SessionPrompt from "./prompt"

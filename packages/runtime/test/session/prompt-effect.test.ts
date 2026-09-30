import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { NamedError } from "@cognitio/shared/util/error"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "../../src/config"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider"
import { Env } from "../../src/env"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Server } from "../../src/server/server"
import { Todo } from "../../src/session/todo"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "@cognitio/shared/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRuntimeConfig } from "../../src/session/runtime-config"
import { ControlRequestRegistry } from "../../src/session/control-registry"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "../../src/tool"
import { Truncate } from "../../src/tool"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}
const altRef = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("alt-model"),
}
const patchRef = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("gpt-5-test"),
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function waitForControl(
  registry: { list: (sessionID?: SessionID) => Effect.Effect<ReadonlyArray<ControlRequestRegistry.Request>> },
  sessionID: SessionID,
  predicate: (request: ControlRequestRegistry.Request) => boolean,
) {
  return Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const match = (yield* registry.list(sessionID)).find(predicate)
      if (match) return match
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error("timed out waiting for control request"))
  })
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    syncRuntime: () => Effect.void,
    clearRuntimeScopes: () => Effect.void,
    clearRuntime: () => Effect.void,
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
function makeHttp() {
  return Layer.mergeAll(
    TestLLMServer.layer,
    createPromptLayer({
      llmLayer: LLM.defaultLayer,
      providerLayer: ProviderSvc.defaultLayer,
    }),
  )
}

function createPromptLayer(input: {
  llmLayer: Layer.Layer<LLM.Service>
  providerLayer: Layer.Layer<ProviderSvc.Service>
  pluginLayer?: Layer.Layer<Plugin.Service>
  mcpLayer?: Layer.Layer<MCP.Service>
}) {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    SessionRuntimeConfig.defaultLayer,
    Snapshot.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    ControlRequestRegistry.defaultLayer,
    input.pluginLayer ?? Plugin.defaultLayer,
    Config.defaultLayer,
    input.providerLayer,
    lsp,
    input.mcpLayer ?? mcp,
    AppFileSystem.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(input.llmLayer),
    Layer.provideMerge(deps),
  )
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  const checkpoint = SessionCheckpoint.layer.pipe(Layer.provideMerge(run), Layer.provideMerge(deps))
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provideMerge(checkpoint),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(input.llmLayer),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

function makePromptLayer(input: {
  llmLayer: Layer.Layer<LLM.Service>
  providerLayer: Layer.Layer<ProviderSvc.Service>
  pluginLayer?: Layer.Layer<Plugin.Service>
  mcpLayer?: Layer.Layer<MCP.Service>
}) {
  return createPromptLayer(input)
}

const it = testEffect(makeHttp())
const fakeProviderModel = ProviderTest.model({
  id: ref.modelID,
  providerID: ref.providerID,
})
const fakeProviderAltModel = ProviderTest.model({
  id: altRef.modelID,
  providerID: altRef.providerID,
})
const fakeProvider = ProviderTest.fake({
  model: fakeProviderModel,
  info: ProviderTest.info(
    { models: { [ref.modelID]: fakeProviderModel, [altRef.modelID]: fakeProviderAltModel } },
    fakeProviderModel,
  ),
  getModel: Effect.fn("PromptEffectProvider.getModel")((providerID, modelID) => {
    if (providerID === ref.providerID && modelID === ref.modelID) return Effect.succeed(fakeProviderModel)
    if (providerID === altRef.providerID && modelID === altRef.modelID) return Effect.succeed(fakeProviderAltModel)
    return Effect.die(new Error(`Unknown test model: ${providerID}/${modelID}`))
  }),
})
const fakeProviderPatchModel = ProviderTest.model({
  id: patchRef.modelID,
  providerID: patchRef.providerID,
})
const fakeProviderPatch = ProviderTest.fake({
  model: fakeProviderPatchModel,
  info: ProviderTest.info({ models: { [patchRef.modelID]: fakeProviderPatchModel } }, fakeProviderPatchModel),
  getModel: Effect.fn("PromptEffectProviderPatch.getModel")((providerID, modelID) => {
    if (providerID === patchRef.providerID && modelID === patchRef.modelID)
      return Effect.succeed(fakeProviderPatchModel)
    return Effect.die(new Error(`Unknown test model: ${providerID}/${modelID}`))
  }),
})

function llmText(text: string): Stream.Stream<LLM.Event, unknown> {
  return Stream.make(
    { type: "start" } satisfies LLM.Event,
    { type: "text-start", id: "txt-1" } satisfies LLM.Event,
    { type: "text-delta", id: "txt-1", delta: text, text } as LLM.Event,
    { type: "text-end", id: "txt-1" } satisfies LLM.Event,
    {
      type: "finish-step",
      finishReason: "stop",
      rawFinishReason: "stop",
      response: { id: "res-1", modelId: ref.modelID, timestamp: new Date() },
      providerMetadata: undefined,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    } satisfies LLM.Event,
    {
      type: "finish",
      finishReason: "stop",
      rawFinishReason: "stop",
      totalUsage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    } satisfies LLM.Event,
  )
}

function llmFinish(
  finishReason: Extract<LLM.Event, { type: "finish" }>["finishReason"],
  usage?: { inputTokens?: number; outputTokens?: number },
): Stream.Stream<LLM.Event, unknown> {
  return Stream.make(
    { type: "start" } satisfies LLM.Event,
    {
      type: "finish-step",
      finishReason,
      rawFinishReason: finishReason,
      response: { id: "res-1", modelId: ref.modelID, timestamp: new Date() },
      providerMetadata: undefined,
      usage: {
        inputTokens: usage?.inputTokens ?? 1,
        outputTokens: usage?.outputTokens ?? 1,
        totalTokens: (usage?.inputTokens ?? 1) + (usage?.outputTokens ?? 1),
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    } satisfies LLM.Event,
    {
      type: "finish",
      finishReason,
      rawFinishReason: finishReason,
      totalUsage: {
        inputTokens: usage?.inputTokens ?? 1,
        outputTokens: usage?.outputTokens ?? 1,
        totalTokens: (usage?.inputTokens ?? 1) + (usage?.outputTokens ?? 1),
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    } satisfies LLM.Event,
  )
}

function llmFinishOnly(finishReason: Extract<LLM.Event, { type: "finish" }>["finishReason"]) {
  return Stream.make(
    {
      type: "finish-step",
      finishReason,
      rawFinishReason: finishReason,
      response: { id: "res-1", modelId: ref.modelID, timestamp: new Date() },
      providerMetadata: undefined,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    } satisfies LLM.Event,
    {
      type: "finish",
      finishReason,
      rawFinishReason: finishReason,
      totalUsage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    } satisfies LLM.Event,
  )
}

function llmStructuredOutput(args: Record<string, unknown>) {
  return (input: LLM.StreamInput): Stream.Stream<LLM.Event, unknown> => {
    const execute = input.tools.StructuredOutput?.execute
    if (!execute) throw new Error("StructuredOutput tool missing execute")
    const toolCallId = "structured-call"
    return Stream.concat(
      Stream.concat(
        Stream.make(
          { type: "start" } satisfies LLM.Event,
          { type: "tool-input-start", id: toolCallId, toolName: "StructuredOutput" } satisfies LLM.Event,
          { type: "tool-call", toolCallId, toolName: "StructuredOutput", input: args } as LLM.Event,
        ),
        Stream.fromEffect(
          Effect.promise(() =>
            Promise.resolve(
              execute(args, {
                toolCallId,
                messages: input.messages,
                abortSignal: new AbortController().signal,
              }),
            ).then(
              (output) => ({ type: "tool-result", toolCallId, output }) as LLM.Event,
              (error) => ({ type: "tool-error", toolCallId, error }) as LLM.Event,
            ),
          ),
        ),
      ),
      llmFinishOnly("stop"),
    )
  }
}

function llmInvalidStructuredOutput(error: string) {
  const toolCallId = "invalid-structured-call"
  return Stream.concat(
    Stream.make(
      { type: "start" } satisfies LLM.Event,
      { type: "tool-input-start", id: toolCallId, toolName: "invalid" } satisfies LLM.Event,
      {
        type: "tool-call",
        toolCallId,
        toolName: "invalid",
        input: { tool: "StructuredOutput", error },
      } as LLM.Event,
      {
        type: "tool-result",
        toolCallId,
        output: {
          title: "Invalid Tool",
          output: `The arguments provided to the tool are invalid: ${error}`,
          metadata: {},
        },
      } as LLM.Event,
    ),
    llmFinishOnly("stop"),
  )
}

function llm() {
  const queue: Array<
    Stream.Stream<LLM.Event, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLM.Event, unknown>)
  > = []

  return {
    reset() {
      queue.length = 0
    },
    push(stream: Stream.Stream<LLM.Event, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLM.Event, unknown>)) {
      queue.push(stream)
    },
    text(value: string) {
      queue.push(llmText(value))
    },
    toolHang(name: string, args: unknown, onStart?: () => void) {
      queue.push((input) =>
        Stream.scoped(
          Stream.fromEffect(
            Effect.gen(function* () {
              const tool = input.tools[name]
              if (!tool?.execute) throw new Error(`Unknown tool: ${name}`)

              const ctrl = new AbortController()
              yield* Effect.promise(() =>
                Promise.resolve(
                  tool.execute!(args, {
                    toolCallId: "call-1",
                    messages: input.messages,
                    abortSignal: ctrl.signal,
                  }),
                ),
              ).pipe(
                Effect.onInterrupt(() => Effect.sync(() => ctrl.abort())),
                Effect.ignore,
                Effect.forkScoped,
              )

              onStart?.()
            }),
          ).pipe(
            Stream.flatMap(() =>
              Stream.concat(
                Stream.make(
                  { type: "start" } satisfies LLM.Event,
                  { type: "tool-input-start", id: "call-1", toolName: name } satisfies LLM.Event,
                  { type: "tool-call", toolCallId: "call-1", toolName: name, input: args } as LLM.Event,
                ),
                Stream.never,
              ),
            ),
          ),
        ),
      )
    },
    layer: Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        stream: (input) => {
          const item = queue.shift() ?? Stream.empty
          return typeof item === "function" ? item(input) : item
        },
      }),
    ),
  }
}

const fakeLLM = llm()
const failChatMessagePlugin = Layer.mock(Plugin.Service)({
  trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) =>
    name === "chat.message" ? Effect.die(new Error("chat.message hook failed")) : Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
})
const itFake = testEffect(
  makePromptLayer({
    llmLayer: fakeLLM.layer,
    providerLayer: fakeProvider.layer,
  }),
)
const patchLLM = llm()
const itFakePatch = testEffect(
  makePromptLayer({
    llmLayer: patchLLM.layer,
    providerLayer: fakeProviderPatch.layer,
  }),
)
const itFakeHookFail = testEffect(
  makePromptLayer({
    llmLayer: fakeLLM.layer,
    providerLayer: fakeProvider.layer,
    pluginLayer: failChatMessagePlugin,
  }),
)
const permissionDeniedEvents: Array<unknown> = []
const permissionDeniedPlugin = Layer.mock(Plugin.Service)({
  trigger: <Name extends string, Input, Output>(name: Name, input: Input, output: Output) =>
    Effect.sync(() => {
      if (name === "permission.denied") permissionDeniedEvents.push(input)
      return output
    }),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
})
const itPermissionDenied = testEffect(
  Layer.mergeAll(
    TestLLMServer.layer,
    createPromptLayer({
      llmLayer: LLM.defaultLayer,
      providerLayer: ProviderSvc.defaultLayer,
      pluginLayer: permissionDeniedPlugin,
    }),
  ),
)
const toolSearchLLM = llm()
const toolSearchMcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () =>
      Effect.succeed({
        runtime_weather: tool({
          description: "Return weather forecast",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => ({ content: [{ type: "text" as const, text: "sunny" }] }),
        }),
        runtime_secret: tool({
          description: "Secret administrative tool",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => ({ content: [{ type: "text" as const, text: "secret" }] }),
        }),
        runtime_pinned: Object.assign(
          tool({
            description: "Pinned runtime tool",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            execute: async () => ({ content: [{ type: "text" as const, text: "pinned" }] }),
          }),
          {
            metadata: {
              source: "mcp" as const,
              alwaysLoad: true,
              searchHint: "must stay loaded",
              capabilityFlags: { readOnly: true },
            },
          },
        ),
      }),
    syncRuntime: () => Effect.void,
    clearRuntimeScopes: () => Effect.void,
    clearRuntime: () => Effect.void,
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)
const itToolSearch = testEffect(
  makePromptLayer({
    llmLayer: toolSearchLLM.layer,
    providerLayer: fakeProvider.layer,
    mcpLayer: toolSearchMcp,
  }),
)
const budgetLLM = llm()
const budgetProvider = ProviderTest.fake({
  model: ProviderTest.model({
    id: ref.modelID,
    providerID: ref.providerID,
    cost: { input: 1_000_000, output: 0, cache: { read: 0, write: 0 } },
  }),
})
const itBudget = testEffect(
  makePromptLayer({
    llmLayer: budgetLLM.layer,
    providerLayer: budgetProvider.layer,
  }),
)
const unixFake = process.platform !== "win32" ? itFake.live.serial : itFake.live.skip
const unix = process.platform !== "win32" ? it.live : it.live.skip

itFake.live.serial("runtime allowedTools filters model-facing built-in tools", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const chat = yield* sessions.create({ title: "Tool allowlist" })

      yield* runtime.set({ sessionID: chat.id, config: { allowedTools: ["Read"] } })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "inspect files" }],
      })
      fakeLLM.push((input) => {
        expect(Object.keys(input.tools)).toContain("read")
        expect(Object.keys(input.tools)).not.toContain("edit")
        expect(Object.keys(input.tools)).not.toContain("write")
        expect(Object.keys(input.tools)).not.toContain("bash")
        return llmText("done")
      })

      yield* prompt.loop({ sessionID: chat.id })
    }),
    { git: true },
  ),
)

itFake.live.serial("session runtime disables environment and automatic compaction and emits finalText", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* runtime.set({
        sessionID: chat.id,
        config: { compaction: { auto: false }, includeEnvironment: false, settingSources: [], allowedTools: ["read"] },
      })
      const results: Array<{ finalText?: string }> = []
      const unsubscribe = yield* bus.subscribeCallback(Session.Event.Result, (event) => {
        if (event.properties.sessionID === chat.id) results.push(event.properties)
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
      fakeLLM.push((input) => {
        expect(input.runtime?.compaction?.auto).toBe(false)
        expect(input.system.join("\n")).not.toContain("<env>")
        return llmText("Completed without compaction").pipe(
          Stream.map((event) =>
            event.type === "finish-step"
              ? {
                  ...event,
                  usage: { ...event.usage, inputTokens: 500000, totalTokens: 500001 },
                }
              : event,
          ),
        )
      })
      yield* prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "Complete this" }] })
      yield* Effect.promise(() => Bun.sleep(50))
      expect(results).toMatchObject([{ finalText: "Completed without compaction" }])
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).some((message) =>
          message.parts.some((part) => part.type === "compaction"),
        ),
      ).toBe(false)
    }),
    { git: true },
  ),
)

itFake.live.serial("runtime exact edit-family allowlist permits allowed write execution", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const chat = yield* sessions.create({ title: "Exact write allowlist" })

        yield* runtime.set({ sessionID: chat.id, config: { allowedTools: ["Write"] } })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "write a file" }],
        })
        fakeLLM.push((input) => {
          expect(Object.keys(input.tools)).toContain("write")
          expect(Object.keys(input.tools)).not.toContain("edit")
          expect(Object.keys(input.tools)).not.toContain("apply_patch")
          const execute = input.tools.write?.execute
          if (!execute) throw new Error("write tool missing execute")
          return Stream.fromEffect(
            Effect.promise(() =>
              Promise.resolve(
                execute(
                  { filePath: path.join(dir, "allowed.txt"), content: "ok" },
                  {
                    toolCallId: "call-write",
                    messages: input.messages,
                    abortSignal: new AbortController().signal,
                  },
                ),
              ),
            ),
          ).pipe(Stream.flatMap(() => llmText("done")))
        })

        yield* prompt.loop({ sessionID: chat.id })
      }),
    { git: true },
  ),
)

unixFake("auto-checkpointing covers write, edit, multiedit and excludes bash", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const checkpoints = yield* SessionCheckpoint.Service
        const chat = yield* sessions.create({
          title: "Auto checkpoint matrix",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const file = path.join(dir, "matrix.txt")

        yield* runtime.set({ sessionID: chat.id, config: { enableFileCheckpointing: true } })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "edit files" }],
        })
        fakeLLM.push((input) =>
          Stream.fromEffect(
            Effect.gen(function* () {
              const ctx = {
                toolCallId: "call",
                messages: input.messages,
                abortSignal: new AbortController().signal,
              }
              if (!input.tools.write?.execute) throw new Error("write tool missing execute")
              if (!input.tools.edit?.execute) throw new Error("edit tool missing execute")
              if (!input.tools.multiedit?.execute) throw new Error("multiedit tool missing execute")
              if (!input.tools.bash?.execute) throw new Error("bash tool missing execute")
              yield* Effect.promise(() =>
                Promise.resolve(
                  input.tools.write!.execute!({ filePath: file, content: "one" }, { ...ctx, toolCallId: "call-write" }),
                ),
              )
              yield* Effect.promise(() =>
                Promise.resolve(
                  input.tools.edit!.execute!(
                    { filePath: file, oldString: "one", newString: "two" },
                    { ...ctx, toolCallId: "call-edit" },
                  ),
                ),
              )
              yield* Effect.promise(() =>
                Promise.resolve(
                  input.tools.multiedit!.execute!(
                    {
                      filePath: file,
                      edits: [{ filePath: file, oldString: "two", newString: "three" }],
                    },
                    { ...ctx, toolCallId: "call-multiedit" },
                  ),
                ),
              )
              yield* Effect.promise(() =>
                Promise.resolve(
                  input.tools.bash!.execute!(
                    {
                      command: `printf bash > ${JSON.stringify(path.join(dir, "bash.txt"))}`,
                      description: "write bash file",
                    },
                    { ...ctx, toolCallId: "call-bash" },
                  ),
                ),
              )
            }),
          ).pipe(Stream.flatMap(() => llmText("done"))),
        )

        yield* prompt.loop({ sessionID: chat.id })
        expect((yield* checkpoints.list(chat.id)).map((item) => item.metadata?.tool)).toEqual([
          "write",
          "edit",
          "multiedit",
        ])
      }),
    { git: true },
  ),
)

itFake.live.serial("auto-checkpointing respects disabled runtime config", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const checkpoints = yield* SessionCheckpoint.Service
        const chat = yield* sessions.create({
          title: "Auto checkpoint disabled",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* runtime.set({ sessionID: chat.id, config: { enableFileCheckpointing: false } })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "write file" }],
        })
        fakeLLM.push((input) => {
          if (!input.tools.write?.execute) throw new Error("write tool missing execute")
          return Stream.fromEffect(
            Effect.promise(() =>
              Promise.resolve(
                input.tools.write!.execute!(
                  { filePath: path.join(dir, "disabled.txt"), content: "disabled" },
                  {
                    toolCallId: "call-write",
                    messages: input.messages,
                    abortSignal: new AbortController().signal,
                  },
                ),
              ),
            ),
          ).pipe(Stream.flatMap(() => llmText("done")))
        })

        yield* prompt.loop({ sessionID: chat.id })
        expect(yield* checkpoints.list(chat.id)).toEqual([])
      }),
    { git: true },
  ),
)

itFakePatch.live.serial("auto-checkpointing covers apply_patch when patch mode is active", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      patchLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const checkpoints = yield* SessionCheckpoint.Service
      const chat = yield* sessions.create({
        title: "Auto checkpoint apply_patch",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* runtime.set({ sessionID: chat.id, config: { enableFileCheckpointing: true } })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "patch file" }],
      })
      patchLLM.push((input) => {
        if (!input.tools.apply_patch?.execute) throw new Error("apply_patch tool missing execute")
        return Stream.fromEffect(
          Effect.promise(() =>
            Promise.resolve(
              input.tools.apply_patch!.execute!(
                { patchText: "*** Begin Patch\n*** Add File: patch.txt\n+patched\n*** End Patch" },
                {
                  toolCallId: "call-patch",
                  messages: input.messages,
                  abortSignal: new AbortController().signal,
                },
              ),
            ),
          ),
        ).pipe(Stream.flatMap(() => llmText("done")))
      })

      yield* prompt.loop({ sessionID: chat.id })
      expect((yield* checkpoints.list(chat.id)).map((item) => item.metadata?.tool)).toEqual(["apply_patch"])
    }),
    { git: true },
  ),
)

unixFake("canUseTool updatedInput re-runs built-in permission metadata before execution", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const registry = yield* ControlRequestRegistry.Service
      const chat = yield* sessions.create({ title: "canUseTool updated input" })

      yield* runtime.set({ sessionID: chat.id, config: { canUseTool: true } })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })
      fakeLLM.push((input) => {
        const execute = input.tools.bash?.execute
        if (!execute) throw new Error("bash tool missing execute")
        return Stream.fromEffect(
          Effect.gen(function* () {
            const result = Promise.resolve(
              execute(
                { command: "printf original", description: "print original" },
                {
                  toolCallId: "call-bash",
                  messages: input.messages,
                  abortSignal: new AbortController().signal,
                },
              ),
            )

            const first = yield* waitForControl(
              registry,
              chat.id,
              (request) =>
                request.subtype === "can_use_tool" &&
                Array.isArray(request.payload.patterns) &&
                request.payload.patterns.includes("printf original"),
            )
            yield* registry.resolve({
              requestID: first.id,
              response: {
                behavior: "allow",
                updatedInput: { command: "printf updated" },
              },
            })

            const second = yield* waitForControl(
              registry,
              chat.id,
              (request) =>
                request.subtype === "can_use_tool" &&
                Array.isArray(request.payload.patterns) &&
                request.payload.patterns.includes("printf updated"),
            )
            yield* registry.resolve({ requestID: second.id, response: { behavior: "allow" } })

            const output = yield* Effect.promise(() => result)
            const text = typeof output === "object" && output && "output" in output ? String(output.output) : ""
            expect(text).toContain("updated")
            expect(text).not.toContain("original")
          }),
        ).pipe(Stream.flatMap(() => llmText("done")))
      })

      yield* prompt.loop({ sessionID: chat.id })
    }),
    { git: true },
  ),
)

itFake.live.serial("tool hooks execute with updated input and can replace final output", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const registry = yield* ControlRequestRegistry.Service
        const chat = yield* sessions.create({
          title: "Hook updated input",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const original = path.join(dir, "original.txt")
        const updated = path.join(dir, "updated.txt")

        yield* runtime.set({
          sessionID: chat.id,
          config: {
            hooks: {
              PreToolUse: [{ id: "pre-write", matcher: "write", timeoutMs: 1_000 }],
              PostToolUse: [{ id: "post-write", matcher: "write", timeoutMs: 1_000 }],
            },
          },
        })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "write file" }],
        })
        fakeLLM.push((input) => {
          const execute = input.tools.write?.execute
          if (!execute) throw new Error("write tool missing execute")
          return Stream.fromEffect(
            Effect.gen(function* () {
              const result = Promise.resolve(
                execute(
                  { filePath: original, content: "original" },
                  {
                    toolCallId: "call-write",
                    messages: input.messages,
                    abortSignal: new AbortController().signal,
                  },
                ),
              )

              const pre = yield* waitForControl(
                registry,
                chat.id,
                (request) => request.subtype === "hook_callback" && request.payload.event === "PreToolUse",
              )
              yield* registry.resolve({
                requestID: pre.id,
                response: {
                  updatedInput: { filePath: updated, content: "updated" },
                  systemMessage: "pre system",
                  additionalContext: "pre context",
                },
              })

              const post = yield* waitForControl(
                registry,
                chat.id,
                (request) => request.subtype === "hook_callback" && request.payload.event === "PostToolUse",
              )
              const postData = post.payload.data
              if (!postData || typeof postData !== "object") throw new Error("missing PostToolUse data")
              expect(postData).toMatchObject({ input: { filePath: updated, content: "updated" } })
              yield* registry.resolve({
                requestID: post.id,
                response: { updatedToolOutput: "hooked output", additionalContext: "post context" },
              })

              const output = yield* Effect.promise(() => result)
              expect(typeof output === "object" && output && "output" in output ? output.output : "").toBe(
                "hooked output\n<hook_context>\npre system\npre context\npost context\n</hook_context>",
              )
              expect(yield* Effect.promise(() => Bun.file(updated).text())).toBe("updated")
              expect(yield* Effect.promise(() => Bun.file(original).exists())).toBe(false)
            }),
          ).pipe(Stream.flatMap(() => llmText("done")))
        })

        yield* prompt.loop({ sessionID: chat.id })
      }),
    { git: true },
  ),
)

itFake.live.serial("runtime disallowedTools hides matching built-in tools", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const chat = yield* sessions.create({ title: "Tool denylist" })

      yield* runtime.set({ sessionID: chat.id, config: { disallowedTools: ["Write"] } })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "inspect files" }],
      })
      fakeLLM.push((input) => {
        expect(Object.keys(input.tools)).toContain("read")
        expect(Object.keys(input.tools)).toContain("edit")
        expect(Object.keys(input.tools)).not.toContain("write")
        return llmText("done")
      })

      yield* prompt.loop({ sessionID: chat.id })
    }),
    { git: true },
  ),
)

itToolSearch.live.serial("tool_search defers MCP tools and reveals selected tools on the next step", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      toolSearchLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const chat = yield* sessions.create({ title: "Tool search" })

      yield* runtime.set({ sessionID: chat.id, config: { enableToolSearch: true } })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "find weather" }],
      })
      toolSearchLLM.push((input) => {
        expect(input.tools.runtime_weather).toBeUndefined()
        expect(input.tools.tool_search).toBeDefined()
        return Stream.fromEffect(
          Effect.promise(() =>
            Promise.resolve(
              input.tools.tool_search!.execute!(
                { query: "select:runtime_weather" },
                {
                  toolCallId: "search-call",
                  messages: input.messages,
                  abortSignal: new AbortController().signal,
                },
              ),
            ),
          ),
        ).pipe(Stream.flatMap(() => llmFinish("tool-calls")))
      })
      toolSearchLLM.push((input) => {
        expect(input.tools.runtime_weather).toBeDefined()
        return llmText("done")
      })

      yield* prompt.loop({ sessionID: chat.id })
    }),
    { git: true },
  ),
)

itToolSearch.live.serial("tool_search remains visible under strict allowlist with allowed deferred tools", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      toolSearchLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const chat = yield* sessions.create({ title: "Tool search strict allow" })

      yield* runtime.set({
        sessionID: chat.id,
        config: { enableToolSearch: true, allowedTools: ["runtime_weather"] },
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "find weather" }],
      })
      toolSearchLLM.push((input) => {
        expect(input.tools.runtime_weather).toBeUndefined()
        expect(input.tools.runtime_pinned).toBeUndefined()
        expect(input.tools.tool_search).toBeDefined()
        return llmText("done")
      })

      yield* prompt.loop({ sessionID: chat.id })
    }),
    { git: true },
  ),
)

itToolSearch.live.serial("MCP alwaysLoad metadata prevents tool_search deferral", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      toolSearchLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const chat = yield* sessions.create({ title: "Tool search always load" })

      yield* runtime.set({ sessionID: chat.id, config: { enableToolSearch: true } })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "use pinned" }],
      })
      toolSearchLLM.push((input) => {
        expect(input.tools.runtime_weather).toBeUndefined()
        expect(input.tools.runtime_pinned).toBeDefined()
        expect(input.tools.tool_search).toBeDefined()
        return llmText("done")
      })

      yield* prompt.loop({ sessionID: chat.id })
    }),
    { git: true },
  ),
)

itToolSearch.live.serial("tool_search does not reveal runtime denied deferred tools", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      toolSearchLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const chat = yield* sessions.create({ title: "Tool search denied tools" })

      yield* runtime.set({
        sessionID: chat.id,
        config: { enableToolSearch: true, disallowedTools: ["runtime_secret"] },
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "find tools" }],
      })
      toolSearchLLM.push((input) => {
        expect(input.tools.runtime_secret).toBeUndefined()
        expect(input.tools.tool_search).toBeDefined()
        return Stream.fromEffect(
          Effect.promise(() =>
            Promise.resolve(
              input.tools.tool_search!.execute!(
                { query: "secret weather" },
                {
                  toolCallId: "search-denied",
                  messages: input.messages,
                  abortSignal: new AbortController().signal,
                },
              ),
            ),
          ),
        ).pipe(
          Stream.tap((result) => {
            const output = typeof result === "object" && result && "output" in result ? String(result.output) : ""
            expect(output).not.toContain("runtime_secret")
            return Effect.void
          }),
          Stream.flatMap(() => llmText("done")),
        )
      })

      yield* prompt.loop({ sessionID: chat.id })
    }),
    { git: true },
  ),
)

itToolSearch.live.serial("tool_search is hidden when explicitly disallowed", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      toolSearchLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const chat = yield* sessions.create({ title: "Tool search denied" })

      yield* runtime.set({
        sessionID: chat.id,
        config: { enableToolSearch: true, disallowedTools: ["tool_search"] },
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "find weather" }],
      })
      toolSearchLLM.push((input) => {
        expect(input.tools.runtime_weather).toBeUndefined()
        expect(input.tools.tool_search).toBeUndefined()
        return llmText("done")
      })

      yield* prompt.loop({ sessionID: chat.id })
    }),
    { git: true },
  ),
)

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
        "alt-model": {
          id: "alt-model",
          name: "Alt Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function budgetProviderCfg(url: string) {
  const base = providerCfg(url)
  return {
    ...base,
    provider: {
      ...base.provider,
      test: {
        ...base.provider.test,
        models: {
          ...base.provider.test.models,
          "test-model": {
            ...base.provider.test.models["test-model"],
            cost: { input: 1_000_000, output: 0 },
          },
        },
      },
    },
  }
}

function structuredOutputFormat(retryCount = 2) {
  return {
    type: "json_schema" as const,
    schema: {
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
      additionalProperties: false,
    },
    retryCount,
  }
}

function structuredOutputFormatWithSchema(schema: Record<string, unknown>, retryCount = 2) {
  return {
    type: "json_schema" as const,
    schema,
    retryCount,
  }
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (
  sessionID: SessionID,
  opts?: {
    finish?: string
    structured?: unknown
    cost?: number
    tokens?: MessageV2.Assistant["tokens"]
  },
) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: opts?.cost ?? 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: opts?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
    ...(opts?.structured !== undefined ? { structured: opts.structured } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const syntheticUser = Effect.fn("test.syntheticUser")(function* (input: {
  sessionID: SessionID
  parentMessageID: MessageID
  text?: string
}) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: input.sessionID,
    agent: "build",
    model: ref,
    parentMessageID: input.parentMessageID,
    time: { created: Date.now() },
  } satisfies MessageV2.User)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: input.sessionID,
    type: "text",
    text: input.text ?? "Continue if you have next steps.",
    synthetic: true,
  } satisfies MessageV2.TextPart)
  return msg
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, input?: { command?: string; model?: typeof ref }) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model: input?.model ?? ref,
      command: input?.command,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

it.live("loop exits immediately when last assistant has stop finish", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
      expect(yield* llm.calls).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

itFake.live.serial("pre-persist keeps the user message entry when resource resolution fails", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        const exit = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            parts: [
              { type: "text", text: "hello" },
              {
                type: "file",
                url: "mcp://missing/resource",
                filename: "missing.txt",
                mime: "text/plain",
                source: {
                  type: "resource",
                  clientName: "missing",
                  uri: "missing://resource",
                  text: {
                    value: "missing resource",
                    start: 0,
                    end: 16,
                  },
                },
              },
            ],
          })
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages).toHaveLength(1)
        expect(messages[0]?.info.role).toBe("user")
        expect(messages[0]?.parts).toMatchObject([{ type: "text", text: "hello" }])
      }),
    { git: true },
  ),
)

itFakeHookFail.live.serial("pre-persist keeps the user message entry when chat.message hook throws", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        const exit = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            parts: [{ type: "text", text: "hello" }],
          })
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages).toHaveLength(1)
        expect(messages[0]?.info.role).toBe("user")
        if (messages[0]?.info.role === "user") {
          expect(messages[0].info.agent).toBe("build")
          expect(messages[0].info.model.providerID).toBe(ref.providerID)
          expect(messages[0].info.model.modelID).toBe(ref.modelID)
          expect(messages[0].info.parentMessageID).toBeUndefined()
        }
        expect(messages[0]?.parts).toMatchObject([{ type: "text", text: "hello" }])
      }),
    { git: true },
  ),
)

it.live("loop calls LLM and returns assistant message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      const parts = result.parts.filter((p) => p.type === "text")
      expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
    }),
    { git: true, config: providerCfg },
  ),
)

itFake.live.serial("runtime model overrides prompt model for LLM calls", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const chat = yield* sessions.create({ title: "Runtime model" })
        yield* runtime.set({
          sessionID: chat.id,
          config: {
            model: { providerID: ref.providerID, modelID: ref.modelID },
            systemPrompt: "Runtime base should not affect compaction.",
          },
        })
        fakeLLM.push((input) => {
          expect(input.model.providerID).toBe(ref.providerID)
          expect(input.model.id).toBe(ref.modelID)
          return llmText("runtime model")
        })

        const result = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: {
            providerID: ProviderID.make("prompt-provider"),
            modelID: ModelID.make("prompt-model"),
          },
          parts: [{ type: "text", text: "hello" }],
        })

        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") {
          expect(result.info.providerID).toBe(ref.providerID)
          expect(result.info.modelID).toBe(ref.modelID)
        }
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const savedUser = messages.find((message) => message.info.role === "user")
        expect(savedUser?.info.role).toBe("user")
        if (savedUser?.info.role === "user") {
          expect(savedUser.info.model.providerID).toBe(ref.providerID)
          expect(savedUser.info.model.modelID).toBe(ref.modelID)
        }
      }),
    {
      git: true,
      config: {
        agent: {
          build: {
            model: "agent/agent-model",
          },
        },
      },
    },
  ),
)

itFake.live.serial("runtime system prompt overrides base and filters instruction sources", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        yield* Effect.promise(() => Bun.write(path.join(dir, "AGENTS.md"), "# Project Instructions\nAGENTS marker"))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const chat = yield* sessions.create({ title: "Runtime system prompt" })
        yield* runtime.set({
          sessionID: chat.id,
          config: {
            systemPrompt: "Runtime base",
            appendSystemPrompt: "Runtime tail",
            settingSources: [],
          },
        })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        fakeLLM.push((input) => {
          expect(input.systemPromptOverride).toEqual({
            agentPromptOverride: "Runtime base",
            appendToFinal: "Runtime tail",
          })
          expect(JSON.stringify(input.system)).not.toContain("AGENTS marker")
          return llmText("done")
        })

        yield* prompt.loop({ sessionID: chat.id })
      }),
    { git: true },
  ),
)

itFake.live.serial("runtime model overrides explicit direct subtask model", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const chat = yield* sessions.create({ title: "Runtime subtask model" })
        yield* runtime.set({
          sessionID: chat.id,
          config: { model: { providerID: ref.providerID, modelID: ref.modelID } },
        })
        const seen: Array<{ providerID: string; modelID: string }> = []
        fakeLLM.push((input) => {
          seen.push({ providerID: input.model.providerID, modelID: input.model.id })
          return llmText("child done")
        })
        fakeLLM.push((input) => {
          seen.push({ providerID: input.model.providerID, modelID: input.model.id })
          return llmText("parent done")
        })
        const msg = yield* user(chat.id, "delegate")
        yield* addSubtask(chat.id, msg.id, {
          model: { providerID: ProviderID.make("missing"), modelID: ModelID.make("missing-model") },
        })

        const result = yield* prompt.loop({ sessionID: chat.id, parentMessageID: msg.id })
        expect(result.info.role).toBe("assistant")
        expect(seen).toEqual([
          { providerID: ref.providerID, modelID: ref.modelID },
          { providerID: ref.providerID, modelID: ref.modelID },
        ])

        const messages = yield* MessageV2.filterCompactedEffect(chat.id)
        const taskMessage = messages.find((item) => item.info.role === "assistant" && item.info.agent === "general")
        expect(taskMessage?.info.role).toBe("assistant")
        if (!taskMessage || taskMessage.info.role !== "assistant") return
        expect(taskMessage.info.providerID).toBe(ref.providerID)
        expect(taskMessage.info.modelID).toBe(ref.modelID)
        const tool = completedTool(taskMessage.parts)
        expect(tool?.state.metadata?.model).toEqual(ref)
        expect(typeof tool?.state.metadata?.messageId).toBe("string")
      }),
    { git: true },
  ),
)

itFake.live.serial("derived child runtime emits SessionStart hooks for direct subtasks", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const registry = yield* ControlRequestRegistry.Service
        const chat = yield* sessions.create({ title: "Runtime subtask SessionStart" })
        yield* runtime.set({
          sessionID: chat.id,
          config: {
            hooks: {
              SessionStart: [{ id: "child-start", timeoutMs: 30_000 }],
            },
            agents: {
              general: {
                prompt: "General runtime agent.",
              },
            },
          },
        })
        fakeLLM.text("child done")
        fakeLLM.text("parent done")
        const msg = yield* user(chat.id, "delegate")
        yield* addSubtask(chat.id, msg.id)

        const result = yield* prompt.loop({ sessionID: chat.id, parentMessageID: msg.id })
        expect(result.info.role).toBe("assistant")

        const request = yield* Effect.gen(function* () {
          for (let i = 0; i < 100; i++) {
            const match = (yield* registry.list()).find(
              (item) =>
                item.subtype === "hook_callback" &&
                item.payload.event === "SessionStart" &&
                item.payload.activeSessionID !== chat.id,
            )
            if (match) return match
            yield* Effect.sleep("10 millis")
          }
          return yield* Effect.fail(new Error("timed out waiting for child SessionStart hook"))
        })
        expect(request.payload).toMatchObject({
          descriptors: [{ id: "child-start", timeoutMs: 30_000 }],
          data: { parentSessionID: chat.id },
        })
      }),
    { git: true },
  ),
)

itFake.live.serial("runtime model overrides compaction model and continuation users", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const chat = yield* sessions.create({ title: "Runtime compaction model" })
        yield* runtime.set({
          sessionID: chat.id,
          config: { model: { providerID: ref.providerID, modelID: ref.modelID } },
        })
        const seen: Array<{ providerID: string; modelID: string }> = []
        fakeLLM.push((input) => {
          seen.push({ providerID: input.model.providerID, modelID: input.model.id })
          return llmFinish("stop", { inputTokens: 200_000, outputTokens: 0 })
        })
        fakeLLM.push((input) => {
          seen.push({ providerID: input.model.providerID, modelID: input.model.id })
          return llmFinish("stop")
        })
        fakeLLM.push((input) => {
          seen.push({ providerID: input.model.providerID, modelID: input.model.id })
          return llmText("after compaction")
        })
        yield* user(chat.id, "overflow")

        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info.role).toBe("assistant")
        expect(seen).toEqual([
          { providerID: ref.providerID, modelID: ref.modelID },
          { providerID: ref.providerID, modelID: ref.modelID },
          { providerID: ref.providerID, modelID: ref.modelID },
        ])

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const compactionUser = messages.find(
          (message) => message.info.role === "user" && message.parts.some((part) => part.type === "compaction"),
        )
        expect(compactionUser?.info.role).toBe("user")
        if (compactionUser?.info.role === "user") expect(compactionUser.info.model).toEqual(ref)
        const continueUser = messages.find(
          (message) =>
            message.info.role === "user" &&
            message.parts.some((part) => part.type === "text" && part.metadata?.compaction_continue === true),
        )
        expect(continueUser?.info.role).toBe("user")
        if (continueUser?.info.role === "user") expect(continueUser.info.model).toEqual(ref)
      }),
    {
      git: true,
      config: {
        agent: {
          compaction: {
            model: "missing/missing-model",
          },
        },
      },
    },
  ),
)

itFake.live.serial("manual compaction model overrides runtime model", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const chat = yield* sessions.create({ title: "Manual compaction model" })
        yield* runtime.set({
          sessionID: chat.id,
          config: {
            model: { providerID: ref.providerID, modelID: ref.modelID },
            systemPrompt: "Runtime base should not affect compaction.",
          },
        })
        yield* user(chat.id, "before compact")
        yield* SessionCompaction.Service.use((compact) =>
          compact.create({
            sessionID: chat.id,
            agent: "build",
            model: altRef,
            auto: false,
          }),
        )

        fakeLLM.push((input) => {
          expect(input.model.providerID).toBe(altRef.providerID)
          expect(input.model.id).toBe(altRef.modelID)
          expect(input.systemPromptOverride).toBeUndefined()
          expect(input.system).toEqual([])
          return llmFinish("stop")
        })

        yield* prompt.loop({ sessionID: chat.id })
      }),
    { git: true },
  ),
)

itFake.live.serial("mid-run runtime-config patch does not affect current run", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const bus = yield* Bus.Service
        const chat = yield* sessions.create({ title: "Runtime snapshot" })
        yield* runtime.set({ sessionID: chat.id, config: { maxTurns: 2 } })
        yield* user(chat.id, "continue once")
        let calls = 0
        fakeLLM.push(() => {
          calls++
          Effect.runSync(runtime.set({ sessionID: chat.id, config: { maxTurns: 1 } }))
          return llmFinish("tool-calls")
        })
        fakeLLM.push(() => {
          calls++
          return llmText("second turn")
        })

        let result: { subtype?: string; numTurns?: number } | undefined
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === Session.Event.Result.type) result = event.properties as typeof result
            }),
          ),
          Effect.forkScoped,
        )

        yield* prompt.loop({ sessionID: chat.id })
        yield* Effect.promise(() => Bun.sleep(50))
        expect(calls).toBe(2)
        expect(result).toMatchObject({ subtype: "success", numTurns: 2 })
      }),
    { git: true },
  ),
)

it.live(
  "runtime model patch plus queued prompt does not affect the active run snapshot",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const chat = yield* sessions.create({ title: "Runtime queued prompt snapshot" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("second")

        const first = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* runtime.set({ sessionID: chat.id, config: { model: altRef } })

        const secondID = MessageID.ascending()
        const second = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: secondID,
            agent: "build",
            parts: [{ type: "text", text: "second" }],
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === secondID)) return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for second prompt to save")
        })

        gate.resolve()

        const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
        expect(Exit.isSuccess(firstExit)).toBe(true)
        expect(Exit.isSuccess(secondExit)).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const inputs = yield* llm.inputs
        expect(inputs.map((input) => (input as { model?: string }).model)).toEqual([ref.modelID, ref.modelID])

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const secondUser = messages.find((msg) => msg.info.role === "user" && msg.info.id === secondID)
        expect(secondUser?.info.role).toBe("user")
        if (secondUser?.info.role === "user") expect(secondUser.info.model).toEqual(ref)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "runtime command accepted behind an active run uses the accepted runtime snapshot",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const chat = yield* sessions.create({ title: "Runtime queued command snapshot" })
        const commandMessageID = MessageID.ascending()

        yield* runtime.set({
          sessionID: chat.id,
          config: { commands: [{ name: "custom", template: "old command template $ARGUMENTS" }] },
        })
        yield* llm.hold("first", gate.promise)
        yield* llm.text("second")

        const first = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        const second = yield* prompt
          .command({
            sessionID: chat.id,
            messageID: commandMessageID,
            command: "custom",
            arguments: "queued",
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === commandMessageID)) return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for command prompt to save")
        })
        yield* runtime.set({
          sessionID: chat.id,
          config: { commands: [{ name: "custom", template: "new command template $ARGUMENTS" }] },
        })

        gate.resolve()
        yield* Fiber.join(first)
        yield* Fiber.join(second)

        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs[1])).toContain("old command template queued")
        expect(JSON.stringify(inputs[1])).not.toContain("new command template")

        yield* llm.text("third")
        yield* prompt.command({
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          command: "custom",
          arguments: "later",
        })
        expect(JSON.stringify((yield* llm.inputs)[2])).toContain("new command template later")
      }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

itFake.live.serial("queued command preserves command-specific tool policy while active run owns runtime", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const gate = defer<void>()
      const firstStarted = defer<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const chat = yield* sessions.create({ title: "Queued command tool policy" })
      const commandMessageID = MessageID.ascending()

      yield* runtime.set({
        sessionID: chat.id,
        config: {
          allowedTools: ["Read", "Write"],
          commands: [{ name: "locked", template: "write only", allowedTools: ["Write"] }],
        },
      })

      fakeLLM.push((input) => {
        expect(Object.keys(input.tools)).toContain("read")
        expect(Object.keys(input.tools)).toContain("write")
        firstStarted.resolve()
        return Stream.fromEffect(Effect.promise(() => gate.promise)).pipe(Stream.flatMap(() => llmText("first done")))
      })
      fakeLLM.push((input) => {
        expect(Object.keys(input.tools)).toContain("write")
        expect(Object.keys(input.tools)).not.toContain("read")
        return llmText("command done")
      })

      const first = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* Effect.promise(() => firstStarted.promise)
      const second = yield* prompt
        .command({
          sessionID: chat.id,
          messageID: commandMessageID,
          command: "locked",
          arguments: "",
        })
        .pipe(Effect.forkChild)

      yield* Effect.promise(async () => {
        const end = Date.now() + 5000
        while (Date.now() < end) {
          const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
          if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === commandMessageID)) return
          await new Promise((done) => setTimeout(done, 20))
        }
        throw new Error("timed out waiting for command prompt to save")
      })

      gate.resolve()
      yield* Fiber.join(first)
      yield* Fiber.join(second)
    }),
    { git: true },
  ),
)

it.live(
  "PATCHed runtime skill reaches the model skill prompt",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        yield* llm.reset
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Runtime skill prompt injection" })
        const app = Server.Default().app
        const route = `/session/${chat.id}/runtime-config?directory=${encodeURIComponent(dir)}`
        const messageRoute = `/session/${chat.id}/message?directory=${encodeURIComponent(dir)}`

        const patched = yield* Effect.promise(() =>
          Promise.resolve(
            app.request(route, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                skills: [
                  {
                    name: "runtime-visible",
                    description: "Visible runtime skill",
                    content: "RUNTIME_SKILL_SYSTEM_MARKER",
                  },
                ],
              }),
            }),
          ),
        )
        expect(patched.status).toBe(200)

        yield* llm.text("done")
        const response = yield* Effect.promise(() =>
          Promise.resolve(
            app.request(messageRoute, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                agent: "build",
                parts: [{ type: "text", text: "use available skills" }],
              }),
            }),
          ),
        )
        expect(response.status).toBe(200)
        yield* Effect.promise(() => response.text())

        const inputs = JSON.stringify(yield* llm.inputs)
        expect(inputs).toContain("<name>runtime-visible</name>")
        expect(inputs).toContain("Visible runtime skill")
      }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

it.live(
  "POST session command executes runtime command, skill command, and inline plugin command",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        yield* llm.reset
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Runtime command route execution" })
        const app = Server.Default().app
        const runtimeRoute = `/session/${chat.id}/runtime-config?directory=${encodeURIComponent(dir)}`
        const commandRoute = `/session/${chat.id}/command?directory=${encodeURIComponent(dir)}`

        const patched = yield* Effect.promise(() =>
          Promise.resolve(
            app.request(runtimeRoute, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                skills: [
                  {
                    name: "runtime-review",
                    description: "Review runtime work",
                    content: "RUNTIME_SKILL_COMMAND_MARKER",
                  },
                ],
                commands: [{ name: "runtime-ship", template: "RUNTIME_COMMAND_MARKER $ARGUMENTS" }],
                plugins: [
                  {
                    type: "inline",
                    name: "team",
                    commands: [{ name: "handoff", template: "PLUGIN_COMMAND_MARKER $ARGUMENTS" }],
                  },
                ],
              }),
            }),
          ),
        )
        expect(patched.status).toBe(200)

        for (const item of [
          { command: "runtime-ship", arguments: "now" },
          { command: "runtime-review", arguments: "" },
          { command: "team:handoff", arguments: "next" },
        ]) {
          yield* llm.text(`done ${item.command}`)
          const response = yield* Effect.promise(() =>
            Promise.resolve(
              app.request(commandRoute, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ...item, agent: "build" }),
              }),
            ),
          )
          expect(response.status).toBe(200)
        }

        const inputs = JSON.stringify(yield* llm.inputs)
        expect(inputs).toContain("RUNTIME_COMMAND_MARKER now")
        expect(inputs).toContain("RUNTIME_SKILL_COMMAND_MARKER")
        expect(inputs).toContain("PLUGIN_COMMAND_MARKER next")
      }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

itFake.live.serial("runtime Skill tool execution uses the accepted runtime", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const chat = yield* sessions.create({
        title: "Runtime skill tool",
        permission: [{ permission: "skill", pattern: "*", action: "allow" }],
      })

      yield* runtime.set({
        sessionID: chat.id,
        config: {
          skills: [{ name: "runtime-tool-skill", description: "Runtime skill", content: "SKILL_TOOL_MARKER" }],
        },
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "load a skill" }],
      })
      fakeLLM.push((input) => {
        const execute = input.tools.skill?.execute
        if (!execute) throw new Error("skill tool missing execute")
        return Stream.fromEffect(
          Effect.promise(() =>
            Promise.resolve(
              execute(
                { name: "runtime-tool-skill" },
                {
                  toolCallId: "call-skill",
                  messages: input.messages,
                  abortSignal: new AbortController().signal,
                },
              ),
            ),
          ).pipe(
            Effect.map((output) => {
              const text = typeof output === "object" && output && "output" in output ? String(output.output) : ""
              expect(text).toContain("SKILL_TOOL_MARKER")
            }),
          ),
        ).pipe(Stream.flatMap(() => llmText("done")))
      })

      yield* prompt.loop({ sessionID: chat.id })
    }),
    { git: true },
  ),
)

itFake.live.serial("inline plugin hooks route through HookBridge during tool execution", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const registry = yield* ControlRequestRegistry.Service
      const chat = yield* sessions.create({
        title: "Plugin hook routing",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* runtime.set({
        sessionID: chat.id,
        config: {
          plugins: [
            {
              type: "inline",
              name: "team",
              hooks: { PreToolUse: [{ id: "audit", matcher: "bash", timeoutMs: 1_000 }] },
            },
          ],
        },
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })
      fakeLLM.push((input) => {
        const execute = input.tools.bash?.execute
        if (!execute) throw new Error("bash tool missing execute")
        return Stream.fromEffect(
          Effect.gen(function* () {
            const result = Promise.resolve(
              execute(
                { command: "printf plugin-hook", description: "print plugin hook" },
                {
                  toolCallId: "call-bash",
                  messages: input.messages,
                  abortSignal: new AbortController().signal,
                },
              ),
            )
            const hook = yield* waitForControl(
              registry,
              chat.id,
              (request) => request.subtype === "hook_callback" && request.payload.event === "PreToolUse",
            )
            expect(hook.payload.descriptors).toEqual([{ id: "team:audit", matcher: "bash", timeoutMs: 1_000 }])
            yield* registry.resolve({ requestID: hook.id, response: { continue: true } })
            const output = yield* Effect.promise(() => result)
            const text = typeof output === "object" && output && "output" in output ? String(output.output) : ""
            expect(text).toContain("plugin-hook")
          }),
        ).pipe(Stream.flatMap(() => llmText("done")))
      })

      yield* prompt.loop({ sessionID: chat.id })
    }),
    { git: true },
  ),
)

itFake.live.serial("SessionStateChange hooks use the accepted runtime snapshot through idle", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const gate = defer<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const registry = yield* ControlRequestRegistry.Service
      const chat = yield* sessions.create({ title: "Status hook runtime snapshot" })

      yield* runtime.set({
        sessionID: chat.id,
        config: { hooks: { SessionStateChange: [{ id: "old-status", matcher: "*", timeoutMs: 30_000 }] } },
      })
      fakeLLM.push(() =>
        Stream.fromEffect(Effect.promise(() => gate.promise)).pipe(Stream.flatMap(() => llmText("done"))),
      )

      const running = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "hold" }],
        })
        .pipe(Effect.forkChild)

      const busy = yield* waitForControl(
        registry,
        chat.id,
        (request) =>
          request.subtype === "hook_callback" &&
          request.payload.event === "SessionStateChange" &&
          request.payload.target === "busy",
      )
      expect(busy.payload.descriptors).toEqual([{ id: "old-status", matcher: "*", timeoutMs: 30_000 }])
      yield* registry.resolve({ requestID: busy.id, response: { continue: true } })

      yield* runtime.set({
        sessionID: chat.id,
        config: { hooks: { SessionStateChange: [{ id: "new-status", matcher: "*", timeoutMs: 30_000 }] } },
      })
      gate.resolve()
      yield* Fiber.join(running)

      const idle = yield* waitForControl(
        registry,
        chat.id,
        (request) =>
          request.subtype === "hook_callback" &&
          request.payload.event === "SessionStateChange" &&
          request.payload.target === "idle",
      )
      expect(idle.payload.descriptors).toEqual([{ id: "old-status", matcher: "*", timeoutMs: 30_000 }])
      yield* registry.resolve({ requestID: idle.id, response: { continue: true } })
    }),
    { git: true },
  ),
)

itFake.live.serial("subtask slash command keeps the internal task wrapper visible under a narrow allowlist", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const chat = yield* sessions.create({
        title: "Subtask command policy",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* runtime.set({
        sessionID: chat.id,
        config: {
          commands: [
            {
              name: "delegate",
              template: "Review via subtask",
              subtask: true,
              agent: "general",
              allowedTools: ["Read"],
            },
          ],
          agents: { general: { prompt: "General runtime agent." } },
        },
      })
      fakeLLM.text("child done")
      fakeLLM.text("parent done")

      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "delegate",
        arguments: "",
      })
      expect(result.info.role).toBe("assistant")

      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      const child = messages.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(child?.info.role).toBe("assistant")
      if (!child || child.info.role !== "assistant") return
      const tool = completedTool(child.parts)
      expect(tool?.tool).toBe("task")
      expect(tool?.state.output).toContain("child done")
    }),
    { git: true },
  ),
)

itFake.live.serial("structured output succeeds on the first attempt", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({ title: "Structured output success" })

      yield* runtime.set({ sessionID: chat.id, config: { outputFormat: structuredOutputFormat() } })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "answer in json" }],
      })
      fakeLLM.push(llmStructuredOutput({ answer: "ok" }))

      let result: { subtype?: string; numTurns?: number; structuredOutput?: unknown } | undefined
      yield* bus.subscribeAll().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === Session.Event.Result.type) result = event.properties as typeof result
          }),
        ),
        Effect.forkScoped,
      )

      const response = yield* prompt.loop({ sessionID: chat.id })
      expect(response.info.role).toBe("assistant")
      if (response.info.role === "assistant") expect(response.info.structured).toEqual({ answer: "ok" })
      yield* Effect.promise(() => Bun.sleep(50))
      expect(result).toMatchObject({ subtype: "success", numTurns: 1, structuredOutput: { answer: "ok" } })
    }),
    { git: true },
  ),
)

itFake.live.serial("structured output retryCount:0 fails immediately", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({ title: "Structured output no retry" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        format: structuredOutputFormat(0),
        parts: [{ type: "text", text: "answer in json" }],
      })
      fakeLLM.push(llmText("plain text"))

      let result: { subtype?: string; numTurns?: number; error?: { name?: string; message?: string } } | undefined
      yield* bus.subscribeAll().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === Session.Event.Result.type) result = event.properties as typeof result
          }),
        ),
        Effect.forkScoped,
      )

      const response = yield* prompt.loop({ sessionID: chat.id })
      expect(response.info.role).toBe("assistant")
      if (response.info.role === "assistant") {
        expect(MessageV2.StructuredOutputError.Schema.parse(response.info.error).data.retries).toBe(0)
      }
      yield* Effect.promise(() => Bun.sleep(50))
      expect(result).toMatchObject({
        subtype: "error_max_structured_output_retries",
        numTurns: 1,
        error: { name: "StructuredOutputError", message: "Model did not produce structured output" },
      })
    }),
    { git: true },
  ),
)

itFake.live.serial("structured output retries invalid output and succeeds with ephemeral feedback", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({ title: "Structured output repair" })
      const requests: LLM.StreamInput[] = []

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        format: structuredOutputFormat(),
        parts: [{ type: "text", text: "answer in json" }],
      })
      fakeLLM.push((input) => {
        requests.push(input)
        return llmStructuredOutput({})(input)
      })
      fakeLLM.push((input) => {
        requests.push(input)
        return llmStructuredOutput({ answer: "fixed" })(input)
      })

      let result: { subtype?: string; numTurns?: number; structuredOutput?: unknown } | undefined
      yield* bus.subscribeAll().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === Session.Event.Result.type) result = event.properties as typeof result
          }),
        ),
        Effect.forkScoped,
      )

      const response = yield* prompt.loop({ sessionID: chat.id })
      expect(response.info.role).toBe("assistant")
      if (response.info.role === "assistant") expect(response.info.structured).toEqual({ answer: "fixed" })
      yield* Effect.promise(() => Bun.sleep(50))

      expect(requests).toHaveLength(2)
      expect(
        requests[1]?.messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("previous response did not produce valid structured output"),
        ),
      ).toBe(true)
      const persistedText = (yield* MessageV2.filterCompactedEffect(chat.id)).flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )
      expect(
        persistedText.some((text) => text.includes("previous response did not produce valid structured output")),
      ).toBe(false)
      expect(result).toMatchObject({ subtype: "success", numTurns: 2, structuredOutput: { answer: "fixed" } })
    }),
    { git: true },
  ),
)

itFake.live.serial("structured output retries AI SDK repaired invalid tool calls", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Structured output repaired invalid tool" })
      const requests: LLM.StreamInput[] = []

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        format: structuredOutputFormat(),
        parts: [{ type: "text", text: "answer in json" }],
      })
      fakeLLM.push((input) => {
        requests.push(input)
        return llmInvalidStructuredOutput("StructuredOutput input did not match schema")
      })
      fakeLLM.push((input) => {
        requests.push(input)
        return llmStructuredOutput({ answer: "fixed" })(input)
      })

      const response = yield* prompt.loop({ sessionID: chat.id })
      expect(response.info.role).toBe("assistant")
      if (response.info.role === "assistant") expect(response.info.structured).toEqual({ answer: "fixed" })
      expect(requests).toHaveLength(2)
      expect(
        requests[1]?.messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("StructuredOutput input did not match schema"),
        ),
      ).toBe(true)
    }),
    { git: true },
  ),
)

itFake.live.serial("structured output retries finishReason unknown as missing output", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({ title: "Structured output unknown finish" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        format: structuredOutputFormat(0),
        parts: [{ type: "text", text: "answer in json" }],
      })
      fakeLLM.push(llmFinishOnly("unknown" as never))

      let result: { subtype?: string; error?: { message?: string } } | undefined
      yield* bus.subscribeAll().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === Session.Event.Result.type) result = event.properties as typeof result
          }),
        ),
        Effect.forkScoped,
      )

      const response = yield* prompt.loop({ sessionID: chat.id })
      expect(response.info.role).toBe("assistant")
      if (response.info.role === "assistant") {
        expect(MessageV2.StructuredOutputError.Schema.parse(response.info.error).data.retries).toBe(0)
      }
      yield* Effect.promise(() => Bun.sleep(50))
      expect(result).toMatchObject({
        subtype: "error_max_structured_output_retries",
        error: { message: "Model did not produce structured output" },
      })
    }),
    { git: true },
  ),
)

itFake.live.serial("structured output retries schemas with stable id without Ajv duplicate errors", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Structured output schema id" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        format: structuredOutputFormatWithSchema(
          {
            $id: "https://example.com/cognitio/structured-output-test.schema.json",
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
          2,
        ),
        parts: [{ type: "text", text: "answer in json" }],
      })
      fakeLLM.push(llmStructuredOutput({}))
      fakeLLM.push(llmStructuredOutput({ answer: "fixed" }))

      const response = yield* prompt.loop({ sessionID: chat.id })
      expect(response.info.role).toBe("assistant")
      if (response.info.role === "assistant") expect(response.info.structured).toEqual({ answer: "fixed" })
    }),
    { git: true },
  ),
)

itFake.live.serial("structured output validates draft 2020-12 schemas from SDK output formats", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Structured output draft 2020" })
      const requests: LLM.StreamInput[] = []

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        format: structuredOutputFormatWithSchema({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            tuple: {
              type: "array",
              prefixItems: [{ type: "string" }, { type: "number" }],
              minItems: 2,
              maxItems: 2,
            },
          },
          required: ["tuple"],
          additionalProperties: false,
        }),
        parts: [{ type: "text", text: "answer in json" }],
      })
      fakeLLM.push((input) => {
        requests.push(input)
        return llmStructuredOutput({ tuple: ["ok", "not-a-number"] })(input)
      })
      fakeLLM.push((input) => {
        requests.push(input)
        return llmStructuredOutput({ tuple: ["ok", 1] })(input)
      })

      const response = yield* prompt.loop({ sessionID: chat.id })
      expect(response.info.role).toBe("assistant")
      if (response.info.role === "assistant") expect(response.info.structured).toEqual({ tuple: ["ok", 1] })
      expect(requests).toHaveLength(2)
    }),
    { git: true },
  ),
)

itFake.live.serial("structured output exhausts retryCount and publishes ordered result", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({ title: "Structured output exhaustion" })
      const requests: LLM.StreamInput[] = []

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        format: structuredOutputFormat(2),
        parts: [{ type: "text", text: "answer in json" }],
      })
      ;["plain one", "plain two", "plain three"].forEach((text) =>
        fakeLLM.push((input) => {
          requests.push(input)
          return llmText(text)
        }),
      )

      const events: string[] = []
      let result: { subtype?: string; numTurns?: number; error?: { name?: string; message?: string } } | undefined
      yield* bus.subscribeAll().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === Session.Event.Result.type) {
              events.push(event.type)
              result = event.properties as typeof result
            }
            if (event.type === SessionStatus.Event.Idle.type) events.push(event.type)
          }),
        ),
        Effect.forkScoped,
      )

      const response = yield* prompt.loop({ sessionID: chat.id })
      expect(response.info.role).toBe("assistant")
      if (response.info.role === "assistant") {
        expect(MessageV2.StructuredOutputError.Schema.parse(response.info.error).data.retries).toBe(2)
      }
      yield* Effect.promise(() => Bun.sleep(50))
      expect(requests).toHaveLength(3)
      expect(events).toEqual([Session.Event.Result.type, SessionStatus.Event.Idle.type])
      expect(result).toMatchObject({
        subtype: "error_max_structured_output_retries",
        numTurns: 3,
        error: { name: "StructuredOutputError", message: "Model did not produce structured output" },
      })
    }),
    { git: true },
  ),
)

itFake.live.serial("maxTurns wins over structured output retry exhaustion", () =>
  provideTmpdirInstance(
    Effect.fnUntraced(function* () {
      fakeLLM.reset()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({ title: "Structured output max turns" })
      const requests: LLM.StreamInput[] = []

      yield* runtime.set({ sessionID: chat.id, config: { maxTurns: 1 } })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        format: structuredOutputFormat(2),
        parts: [{ type: "text", text: "answer in json" }],
      })
      fakeLLM.push((input) => {
        requests.push(input)
        return llmText("plain")
      })

      let result: { subtype?: string; numTurns?: number; error?: { message?: string } } | undefined
      yield* bus.subscribeAll().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === Session.Event.Result.type) result = event.properties as typeof result
          }),
        ),
        Effect.forkScoped,
      )

      yield* prompt.loop({ sessionID: chat.id })
      yield* Effect.promise(() => Bun.sleep(50))
      expect(requests).toHaveLength(1)
      expect(result).toMatchObject({
        subtype: "error_max_turns",
        numTurns: 1,
        error: { message: "Maximum turns exceeded: 1" },
      })
    }),
    { git: true },
  ),
)

itFake.live.serial("maxTurns:1 allows one assistant turn then publishes error_max_turns", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const bus = yield* Bus.Service
        const chat = yield* sessions.create({ title: "Max turns" })
        yield* runtime.set({ sessionID: chat.id, config: { maxTurns: 1 } })
        yield* user(chat.id, "use a tool")
        fakeLLM.push(llmFinish("tool-calls"))

        let result: { subtype?: string; numTurns?: number } | undefined
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === Session.Event.Result.type) result = event.properties as typeof result
            }),
          ),
          Effect.forkScoped,
        )

        const response = yield* prompt.loop({ sessionID: chat.id })
        expect(response.info.role).toBe("assistant")
        yield* Effect.promise(() => Bun.sleep(50))
        expect(result).toMatchObject({ subtype: "error_max_turns", numTurns: 1 })
      }),
    { git: true },
  ),
)

it.live("maxTurns blocks task child model calls after the parent turn is spent", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({
        title: "Task max turns",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* runtime.set({ sessionID: chat.id, config: { maxTurns: 1 } })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "delegate" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.text("child should not run")

      let result: { subtype?: string; numTurns?: number; error?: { message?: string } } | undefined
      yield* bus.subscribeAll().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === Session.Event.Result.type) result = event.properties as typeof result
          }),
        ),
        Effect.forkScoped,
      )

      yield* prompt.loop({ sessionID: chat.id })
      yield* Effect.promise(() => Bun.sleep(50))
      expect(yield* llm.calls).toBe(1)
      expect(result).toMatchObject({
        subtype: "error_max_turns",
        numTurns: 1,
        error: { message: "Maximum turns exceeded: 1" },
      })
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("agent.steps blocks task child model calls after the parent turn is spent", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({
        title: "Task steps",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "delegate" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.text("child should not run")

      let result: { subtype?: string; numTurns?: number; error?: { message?: string } } | undefined
      yield* bus.subscribeAll().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === Session.Event.Result.type) result = event.properties as typeof result
          }),
        ),
        Effect.forkScoped,
      )

      yield* prompt.loop({ sessionID: chat.id })
      yield* Effect.promise(() => Bun.sleep(50))
      expect(yield* llm.calls).toBe(1)
      expect(result).toMatchObject({
        subtype: "error_max_turns",
        numTurns: 1,
        error: { message: "Maximum turns exceeded: 1" },
      })
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          build: {
            steps: 1,
          },
        },
      }),
    },
  ),
)

it.live("maxTurns passes remaining task child turns without counting compaction summaries", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({
        title: "Task max turns after compaction",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* runtime.set({ sessionID: chat.id, config: { maxTurns: 2 } })
      const seeded = yield* seed(chat.id, { finish: "tool-calls" })
      const summary = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: seeded.assistant.id,
        parentMessageID: seeded.assistant.id,
        sessionID: chat.id,
        mode: "compaction",
        agent: "compaction",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
        finish: "stop",
        summary: true,
      } satisfies MessageV2.Assistant)
      const subtaskUser = yield* syntheticUser({
        sessionID: chat.id,
        parentMessageID: summary.id,
      })
      yield* addSubtask(chat.id, subtaskUser.id)
      yield* llm.text("child ran")
      yield* llm.text("parent should not run")

      let result: { subtype?: string; numTurns?: number; error?: { message?: string } } | undefined
      yield* bus.subscribeAll().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === Session.Event.Result.type) result = event.properties as typeof result
          }),
        ),
        Effect.forkScoped,
      )

      yield* prompt.loop({ sessionID: chat.id, parentMessageID: seeded.user.id })
      yield* Effect.promise(() => Bun.sleep(50))
      expect(yield* llm.calls).toBe(1)
      expect(result).toMatchObject({
        subtype: "error_max_turns",
        numTurns: 2,
        error: { message: "Maximum turns exceeded: 2" },
      })
    }),
    { git: true, config: providerCfg },
  ),
)

itFake.live.serial("hard stop result is not overwritten by late abort", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const bus = yield* Bus.Service
        const chat = yield* sessions.create({ title: "Late abort hard stop" })
        yield* runtime.set({ sessionID: chat.id, config: { maxTurns: 1 } })
        yield* user(chat.id, "use a tool")
        fakeLLM.push(llmFinish("tool-calls"))

        const results: Array<{ subtype?: string; numTurns?: number; error?: { message?: string } }> = []
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === Session.Event.Result.type) results.push(event.properties as (typeof results)[number])
            }),
          ),
          Effect.forkScoped,
        )

        yield* prompt.loop({ sessionID: chat.id })
        yield* prompt.cancel(chat.id)
        yield* Effect.promise(() => Bun.sleep(50))
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
          subtype: "error_max_turns",
          numTurns: 1,
          error: { message: "Maximum turns exceeded: 1" },
        })
      }),
    { git: true },
  ),
)

itFake.live.serial("maxTurns counts run-wide turns across internal synthetic continuation users", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const bus = yield* Bus.Service
        const chat = yield* sessions.create({ title: "Max turns continuation" })
        yield* runtime.set({ sessionID: chat.id, config: { maxTurns: 1 } })
        const seeded = yield* seed(chat.id, { finish: "tool-calls" })
        yield* syntheticUser({ sessionID: chat.id, parentMessageID: seeded.assistant.id })
        fakeLLM.push(llmText("should not run"))

        let result: { subtype?: string; numTurns?: number } | undefined
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === Session.Event.Result.type) result = event.properties as typeof result
            }),
          ),
          Effect.forkScoped,
        )

        const response = yield* prompt.loop({ sessionID: chat.id, parentMessageID: seeded.user.id })
        expect(response.info.id).toBe(seeded.assistant.id)
        yield* Effect.promise(() => Bun.sleep(50))
        expect(result).toMatchObject({ subtype: "error_max_turns", numTurns: 1 })
      }),
    { git: true },
  ),
)

itFake.live.serial("agent.steps alone allows one assistant turn then publishes error_max_turns", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const bus = yield* Bus.Service
        const chat = yield* sessions.create({ title: "Agent steps" })
        yield* user(chat.id, "use a tool")
        fakeLLM.push(llmFinish("tool-calls"))

        let result: { subtype?: string; numTurns?: number } | undefined
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === Session.Event.Result.type) result = event.properties as typeof result
            }),
          ),
          Effect.forkScoped,
        )

        const response = yield* prompt.loop({ sessionID: chat.id })
        expect(response.info.role).toBe("assistant")
        yield* Effect.promise(() => Bun.sleep(50))
        expect(result).toMatchObject({ subtype: "error_max_turns", numTurns: 1 })
      }),
    {
      git: true,
      config: {
        agent: {
          build: {
            steps: 1,
          },
        },
      },
    },
  ),
)

itFake.live.serial("hard turn cap uses min(runtime maxTurns, agent.steps) and publishes full result payload", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        fakeLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const bus = yield* Bus.Service
        const chat = yield* sessions.create({ title: "Turn cap min" })
        yield* runtime.set({ sessionID: chat.id, config: { maxTurns: 5 } })
        const seeded = yield* seed(chat.id, {
          finish: "tool-calls",
          structured: { answer: "ok" },
          cost: 2,
          tokens: {
            input: 3,
            output: 4,
            reasoning: 5,
            cache: { read: 6, write: 7 },
          },
        })

        let result:
          | {
              subtype?: string
              messageID?: string
              parentMessageID?: string
              stopReason?: string
              numTurns?: number
              totalCostUsd?: number
              usage?: MessageV2.Assistant["tokens"]
              modelUsage?: Record<string, { tokens: MessageV2.Assistant["tokens"]; cost: number }>
              structuredOutput?: unknown
              error?: { message: string }
            }
          | undefined
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === Session.Event.Result.type) result = event.properties as typeof result
            }),
          ),
          Effect.forkScoped,
        )

        const response = yield* prompt.loop({ sessionID: chat.id, parentMessageID: seeded.user.id })
        expect(response.info.id).toBe(seeded.assistant.id)
        yield* Effect.promise(() => Bun.sleep(50))
        expect(result).toMatchObject({
          subtype: "error_max_turns",
          messageID: seeded.assistant.id,
          parentMessageID: seeded.user.id,
          stopReason: "tool-calls",
          numTurns: 1,
          totalCostUsd: 2,
          usage: {
            input: 3,
            output: 4,
            reasoning: 5,
            cache: { read: 6, write: 7 },
          },
          modelUsage: {
            [`${ref.providerID}/${ref.modelID}`]: {
              cost: 2,
              tokens: {
                input: 3,
                output: 4,
                reasoning: 5,
                cache: { read: 6, write: 7 },
              },
            },
          },
          structuredOutput: { answer: "ok" },
          error: {
            message: "Maximum turns exceeded: 1",
          },
        })
      }),
    {
      git: true,
      config: {
        agent: {
          build: {
            steps: 1,
          },
        },
      },
    },
  ),
)

itBudget.live.serial("maxBudgetUsd publishes error_max_budget at exact persisted assistant cost", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        budgetLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const bus = yield* Bus.Service
        const chat = yield* sessions.create({ title: "Max budget" })
        yield* runtime.set({ sessionID: chat.id, config: { maxBudgetUsd: 1 } })
        yield* user(chat.id, "expensive")
        budgetLLM.push(llmFinish("stop", { inputTokens: 1, outputTokens: 0 }))

        let result: { subtype?: string; totalCostUsd?: number; numTurns?: number } | undefined
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === Session.Event.Result.type) result = event.properties as typeof result
            }),
          ),
          Effect.forkScoped,
        )

        const response = yield* prompt.loop({ sessionID: chat.id })
        expect(response.info.role).toBe("assistant")
        yield* Effect.promise(() => Bun.sleep(50))
        expect(result).toMatchObject({ subtype: "error_max_budget", totalCostUsd: 1, numTurns: 1 })
      }),
    { git: true },
  ),
)

itBudget.live.serial("maxBudgetUsd checks existing persisted cost before natural success", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        budgetLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const bus = yield* Bus.Service
        const chat = yield* sessions.create({ title: "Persisted budget" })
        yield* runtime.set({ sessionID: chat.id, config: { maxBudgetUsd: 1 } })
        const seeded = yield* seed(chat.id, {
          finish: "stop",
          cost: 1,
          tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })

        let result: { subtype?: string; totalCostUsd?: number; numTurns?: number } | undefined
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === Session.Event.Result.type) result = event.properties as typeof result
            }),
          ),
          Effect.forkScoped,
        )

        const response = yield* prompt.loop({ sessionID: chat.id, parentMessageID: seeded.user.id })
        expect(response.info.id).toBe(seeded.assistant.id)
        yield* Effect.promise(() => Bun.sleep(50))
        expect(result).toMatchObject({ subtype: "error_max_budget", totalCostUsd: 1, numTurns: 1 })
      }),
    { git: true },
  ),
)

itBudget.live.serial("maxBudgetUsd includes subtask child cost before parent continuation", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        budgetLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const bus = yield* Bus.Service
        const chat = yield* sessions.create({ title: "Subtask budget" })
        yield* runtime.set({ sessionID: chat.id, config: { maxBudgetUsd: 1 } })
        const msg = yield* user(chat.id, "delegate")
        yield* addSubtask(chat.id, msg.id)
        budgetLLM.push(llmFinish("stop", { inputTokens: 1, outputTokens: 0 }))
        budgetLLM.push(() => {
          throw new Error("parent continuation should not run after subtask budget cap")
        })

        let result:
          | {
              subtype?: string
              totalCostUsd?: number
              numTurns?: number
              modelUsage?: Record<string, { tokens: MessageV2.Assistant["tokens"]; cost: number }>
            }
          | undefined
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === Session.Event.Result.type) result = event.properties as typeof result
            }),
          ),
          Effect.forkScoped,
        )

        yield* prompt.loop({ sessionID: chat.id, parentMessageID: msg.id })
        yield* Effect.promise(() => Bun.sleep(50))
        expect(result).toMatchObject({
          subtype: "error_max_budget",
          totalCostUsd: 1,
          numTurns: 1,
          modelUsage: {
            [`${ref.providerID}/${ref.modelID}`]: {
              cost: 1,
            },
          },
        })
      }),
    { git: true },
  ),
)

it.live("maxBudgetUsd blocks model-generated task while parent cost is still pending", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({ title: "Model task budget" })
      yield* runtime.set({ sessionID: chat.id, config: { maxBudgetUsd: 1 } })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "delegate" }],
      })
      yield* llm.push(
        reply()
          .tool("task", {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          })
          .usage({ input: 1, output: 0 })
          .item(),
      )
      yield* llm.text("child should not run")

      let result: { subtype?: string; totalCostUsd?: number; numTurns?: number } | undefined
      yield* bus.subscribeAll().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === Session.Event.Result.type) result = event.properties as typeof result
          }),
        ),
        Effect.forkScoped,
      )

      yield* prompt.loop({ sessionID: chat.id })
      yield* Effect.promise(() => Bun.sleep(50))
      expect(yield* llm.calls).toBe(1)
      expect(result).toMatchObject({ subtype: "error_max_budget", totalCostUsd: 1, numTurns: 1 })
    }),
    { git: true, config: budgetProviderCfg },
  ),
)

itBudget.live.serial("maxBudgetUsd checks auto-compaction cost before continuation model calls", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        budgetLLM.reset()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const compaction = yield* SessionCompaction.Service
        const bus = yield* Bus.Service
        const chat = yield* sessions.create({ title: "Compaction budget" })
        yield* runtime.set({ sessionID: chat.id, config: { maxBudgetUsd: 1 } })
        const msg = yield* user(chat.id, "compact then continue")
        yield* compaction.create({
          sessionID: chat.id,
          agent: "build",
          model: { providerID: ref.providerID, modelID: ref.modelID },
          auto: true,
        })
        budgetLLM.push(llmFinish("stop", { inputTokens: 1, outputTokens: 0 }))
        budgetLLM.push(llmText("should not run"))

        let result: { subtype?: string; totalCostUsd?: number } | undefined
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === Session.Event.Result.type) result = event.properties as typeof result
            }),
          ),
          Effect.forkScoped,
        )

        yield* prompt.loop({ sessionID: chat.id, parentMessageID: msg.id })
        yield* Effect.promise(() => Bun.sleep(50))
        expect(result).toMatchObject({ subtype: "error_max_budget", totalCostUsd: 1 })

        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(
          messages.filter((message) => {
            if (message.info.role !== "assistant") return false
            if (message.info.summary === true) return false
            return message.info.id > msg.id
          }),
        ).toHaveLength(0)
      }),
    { git: true },
  ),
)

it.live("static loop returns assistant text through local provider", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })

      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop consumes queued replies across turns", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider turns",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello one" }],
      })

      yield* llm.text("world one")

      const first = yield* prompt.loop({ sessionID: session.id })
      expect(first.info.role).toBe("assistant")
      expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello two" }],
      })

      yield* llm.text("world two")

      const second = yield* prompt.loop({ sessionID: session.id })
      expect(second.info.role).toBe("assistant")
      expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

      expect(yield* llm.hits).toHaveLength(2)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is tool-calls", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.tool("first", { value: "first" })
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("glob tool keeps instance context during prompt runs", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Glob context",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const file = path.join(dir, "probe.txt")
        yield* Effect.promise(() => Bun.write(file, "probe"))

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "find text files" }],
        })
        yield* llm.tool("glob", { pattern: "**/*.txt" })
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")

        const msgs = yield* MessageV2.filterCompactedEffect(session.id)
        const tool = msgs
          .flatMap((msg) => msg.parts)
          .find(
            (part): part is CompletedToolPart =>
              part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
          )
        if (!tool) return

        expect(tool.state.output).toContain(file)
        expect(tool.state.output).not.toContain("No context found for instance")
        expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is stop but assistant has tool parts", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.push(reply().tool("first", { value: "first" }).stop())
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("failed subtask preserves metadata on error tool state", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const registry = yield* ControlRequestRegistry.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* runtime.set({
        sessionID: chat.id,
        config: {
          hooks: {
            PostToolUse: [{ id: "post-task", matcher: "task", timeoutMs: 1_000 }],
            SubagentStop: [{ id: "subagent-stop", matcher: "general", timeoutMs: 1_000 }],
          },
        },
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.text("done")
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(yield* llm.calls).toBe(2)
      yield* Effect.sleep("25 millis")
      expect(
        (yield* registry.list(chat.id)).filter(
          (request) =>
            request.subtype === "hook_callback" &&
            (request.payload.event === "PostToolUse" || request.payload.event === "SubagentStop"),
        ),
      ).toHaveLength(0)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return
      expect(taskMsg.info.parentID).toBe(msg.id)
      expect(taskMsg.info.parentMessageID).toBe(msg.id)

      const tool = errorTool(taskMsg.parts)
      if (!tool) return

      expect(tool.state.error).toContain("Tool execution failed")
      expect(tool.state.metadata).toBeDefined()
      expect(tool.state.metadata?.sessionId).toBeDefined()
      expect(tool.state.metadata?.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("missing-model"),
      })
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          general: {
            model: "test/missing-model",
          },
        },
      }),
    },
  ),
)

it.live("runtime disallowed task marks direct subtask as denied", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* runtime.set({ sessionID: chat.id, config: { disallowedTools: ["task"] } })
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = messages.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return
      const tool = errorTool(taskMsg.parts)
      expect(tool?.state.error).toContain("prevents you from using this specific tool call")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("permission rules gate direct subtasks before child execution", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "task", pattern: "general", action: "deny" }],
      })
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = messages.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return
      const tool = errorTool(taskMsg.parts)
      expect(tool?.state.error).toContain("prevents you from using this specific tool call")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("direct subtask permission rechecks canUseTool updated subagent input", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const sessions = yield* Session.Service
      const registry = yield* ControlRequestRegistry.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [
          { permission: "task", pattern: "general", action: "ask" },
          { permission: "task", pattern: "build", action: "ask" },
        ],
      })
      yield* runtime.set({
        sessionID: chat.id,
        config: {
          canUseTool: true,
          agents: {
            general: {
              prompt: "General runtime agent.",
              spawnMode: "inherit",
            },
            build: {
              prompt: "Build runtime agent.",
            },
          },
        },
      })
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const task = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const first = yield* waitForControl(
        registry,
        chat.id,
        (request) =>
          request.subtype === "can_use_tool" &&
          Array.isArray(request.payload.patterns) &&
          request.payload.patterns.includes("general"),
      )
      expect((first.payload.metadata as { spawnMode?: unknown } | undefined)?.spawnMode).toBe("inherit")
      expect((first.payload.input as { spawnMode?: unknown } | undefined)?.spawnMode).toBe("inherit")
      yield* registry.resolve({
        requestID: first.id,
        response: { behavior: "allow", updatedInput: { subagent_type: "build" } },
      })

      const second = yield* waitForControl(
        registry,
        chat.id,
        (request) =>
          request.subtype === "can_use_tool" &&
          Array.isArray(request.payload.patterns) &&
          request.payload.patterns.includes("build"),
      )
      expect((second.payload.metadata as { spawnMode?: unknown } | undefined)?.spawnMode).toBe("fresh")
      expect((second.payload.input as { spawnMode?: unknown } | undefined)?.spawnMode).toBe("fresh")
      yield* registry.resolve({
        requestID: second.id,
        response: { behavior: "deny", message: "blocked build" },
      })

      const result = yield* Fiber.join(task)
      expect(result.info.role).toBe("assistant")

      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = messages.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return
      const tool = errorTool(taskMsg.parts)
      expect(tool?.state.error).toContain("blocked build")
      expect(yield* registry.list(chat.id)).toHaveLength(0)
    }),
    { git: true, config: providerCfg },
  ),
)

itPermissionDenied.live.serial("runtime visibility denies emit permission.denied events", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      permissionDeniedEvents.length = 0
      const prompt = yield* SessionPrompt.Service
      const runtime = yield* SessionRuntimeConfig.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Runtime deny event" })
      yield* runtime.set({ sessionID: chat.id, config: { disallowedTools: ["task"] } })
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      yield* prompt.loop({ sessionID: chat.id })

      expect(
        permissionDeniedEvents.some((item) => {
          const event = item as {
            reason?: unknown
            request?: { sessionID?: unknown; permission?: unknown; patterns?: unknown }
          }
          return (
            event.reason === "runtime_visibility" &&
            event.request?.sessionID === chat.id &&
            event.request.permission === "task" &&
            Array.isArray(event.request.patterns) &&
            event.request.patterns.includes("*")
          )
        }),
      ).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("command subtask summary user preserves parentMessageID adjacency", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.text("child done")
      yield* llm.text("summary done")
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id, { command: "/inspect bug" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = messages.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const summaryUser = messages.find(
        (item) =>
          item.info.role === "user" &&
          item.parts.some(
            (part) =>
              part.type === "text" &&
              part.synthetic === true &&
              part.text === "Summarize the task tool output above and continue with your task.",
          ),
      )

      expect(taskMsg?.info.role).toBe("assistant")
      expect(summaryUser?.info.role).toBe("user")
      if (!taskMsg || !summaryUser || taskMsg.info.role !== "assistant" || summaryUser.info.role !== "user") return
      expect(taskMsg.info.parentID).toBe(msg.id)
      expect(taskMsg.info.parentMessageID).toBe(msg.id)
      expect(summaryUser.info.parentMessageID).toBe(taskMsg.info.id)
      expect(result.info.parentMessageID).toBe(summaryUser.info.id)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live(
  "running subtask preserves metadata after tool-call transition",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        const msg = yield* user(chat.id, "hello")
        yield* addSubtask(chat.id, msg.id)

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        const tool = yield* Effect.promise(async () => {
          const end = Date.now() + 5_000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(MessageV2.filterCompactedEffect(chat.id))
            const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
            const tool = taskMsg?.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
            if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for running subtask metadata")
        })

        if (tool.state.status !== "running") return
        expect(typeof tool.state.metadata?.sessionId).toBe("string")
        expect(tool.state.title).toBeDefined()
        expect(tool.state.metadata?.model).toBeDefined()

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

it.live(
  "running task tool preserves metadata after tool-call transition",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.tool("task", {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        const tool = yield* Effect.promise(async () => {
          const end = Date.now() + 5_000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(MessageV2.filterCompactedEffect(chat.id))
            const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
            const tool = assistant?.parts.find(
              (part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task",
            )
            if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for running task metadata")
        })

        if (tool.state.status !== "running") return
        expect(typeof tool.state.metadata?.sessionId).toBe("string")
        expect(tool.state.title).toBe("inspect bug")
        expect(tool.state.metadata?.model).toBeDefined()

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "loop sets status to busy then idle",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        expect((yield* status.get(chat.id)).type).toBe("busy")
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Cancel semantics

it.live(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* seed(chat.id)

        yield* llm.hang

        yield* user(chat.id, "more")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const info = exit.value.info
          if (info.role === "assistant") {
            expect(info.error?.name).toBe("MessageAbortedError")
          }
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel finalizes subtask tool state",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const aborted = defer<void>()
          const registry = yield* ToolRegistry.Service
          const { task } = yield* registry.named()
          const original = task.execute
          task.execute = (_args, ctx) =>
            Effect.callback<never>((_resume) => {
              ready.resolve()
              ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
              return Effect.sync(() => aborted.resolve())
            })
          yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

          const { prompt, chat } = yield* boot()
          const msg = yield* user(chat.id, "hello")
          yield* addSubtask(chat.id, msg.id)

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          yield* prompt.cancel(chat.id)
          yield* Effect.promise(() => aborted.promise)

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)

          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          expect(taskMsg?.info.role).toBe("assistant")
          if (!taskMsg || taskMsg.info.role !== "assistant") return

          const tool = toolPart(taskMsg.parts)
          expect(tool?.type).toBe("tool")
          if (!tool) return

          expect(tool.state.status).not.toBe("running")
          expect(taskMsg.info.time.completed).toBeDefined()
          expect(taskMsg.info.finish).toBeDefined()
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "cancel with queued callers resolves all cleanly",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        yield* prompt.cancel(chat.id)
        const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(exitA)).toBe(true)
        expect(Exit.isSuccess(exitB)).toBe(true)
        if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
          expect(exitA.value.info.id).toBe(exitB.value.info.id)
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Queue semantics

it.live("concurrent loop callers get same result", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* seed(chat.id, { finish: "stop" })

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })

        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true },
  ),
)

it.live(
  "concurrent loop callers all receive same error result",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.fail("boom")
        yield* user(chat.id, "hello")

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })
        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("second")

        const a = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)

        const id = MessageID.ascending()
        const b = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "second" }],
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id)) return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for second prompt to save")
        })

        gate.resolve()

        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const assistants = msgs.filter((msg) => msg.info.role === "assistant")
        expect(assistants).toHaveLength(2)
        const last = assistants.at(-1)
        if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
        expect(last.info.parentID).toBe(id)
        expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "assertNotBusy throws BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live("assertNotBusy succeeds when idle", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service

        const chat = yield* sessions.create({})
        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    { git: true },
  ),
)

// Shell semantics

it.live(
  "shell rejects with BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

unix("shell honors settingSources when resolving the agent", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, ".cognitio", "agent", "decoy.md"),
            "---\ndescription: decoy\nmode: subagent\n---\nDecoy prompt\n",
          ),
        )
        const { prompt, sessions } = yield* boot()
        const runtimeSvc = yield* SessionRuntimeConfig.Service

        // Gated session: the project file-agent must be "not found" and must
        // not be enumerated in the error hint.
        const gated = yield* sessions.create({ title: "gated" })
        yield* runtimeSvc.set({ sessionID: gated.id, config: { settingSources: [] } })
        const exit = yield* prompt.shell({ sessionID: gated.id, agent: "decoy", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause)
          expect(NamedError.Unknown.isInstance(err)).toBe(true)
          if (NamedError.Unknown.isInstance(err)) {
            expect(err.data.message).toContain('Agent not found: "decoy"')
            // the "Available agents" hint must not enumerate the gated file-agent
            const hint = err.data.message.split("Available agents:")[1] ?? ""
            expect(hint).not.toContain("decoy")
            expect(hint).toContain("build")
          }
        }

        // Project-visible session: the same agent resolves and runs.
        const open = yield* sessions.create({ title: "open" })
        yield* runtimeSvc.set({ sessionID: open.id, config: { settingSources: ["project"] } })
        const result = yield* prompt.shell({ sessionID: open.id, agent: "decoy", command: "printf ok" })
        expect(result.info.role).toBe("assistant")
      }),
    { git: true, config: cfg },
  ),
)

unix("shell dispatches SessionStateChange hooks with the session runtime", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, sessions } = yield* boot()
        const runtimeSvc = yield* SessionRuntimeConfig.Service
        const registry = yield* ControlRequestRegistry.Service
        const chat = yield* sessions.create({ title: "hooked" })
        // A runtime SessionStateChange hook only reaches HookBridge if shell
        // threads the accepted runtime into the run-state (status.set(runtime)).
        yield* runtimeSvc.set({
          sessionID: chat.id,
          config: { hooks: { SessionStateChange: [{ id: "sc", timeoutMs: 1_000 }] } },
        })

        yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "printf ok" })

        const pending = yield* registry.list(chat.id)
        const dispatched = pending.filter((r) => r.subtype === "hook_callback")
        expect(dispatched.length).toBeGreaterThan(0)
        expect(dispatched.some((r) => (r.payload as { event?: string })?.event === "SessionStateChange")).toBe(true)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell captures stdout and stderr in completed tool output", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "printf out && printf err >&2",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("out")
        expect(tool.state.output).toContain("err")
        expect(tool.state.metadata.output).toContain("out")
        expect(tool.state.metadata.output).toContain("err")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell wrapper messages preserve parentMessageID adjacency", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, sessions, chat } = yield* boot()
        const previous = yield* seed(chat.id, { finish: "stop" })
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "printf ok",
        })
        expect(result.info.role).toBe("assistant")

        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages).toHaveLength(4)
        expect(messages[2]?.info.role).toBe("user")
        if (messages[2]?.info.role === "user") {
          expect(messages[2].info.parentMessageID).toBe(previous.assistant.id)
        }
        expect(messages[3]?.info.role).toBe("assistant")
        if (messages[3]?.info.role === "assistant") {
          expect(messages[3].info.parentID).toBe(messages[2]?.info.id)
          expect(messages[3].info.parentMessageID).toBe(messages[2]?.info.id)
        }
      }),
    { git: true, config: cfg },
  ),
)

unix("shell completes a fast command on the preferred shell", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("pwd")
        expect(tool.state.output).toContain(dir)
        expect(tool.state.metadata.output).toContain(dir)
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell lists files from the project directory", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* Effect.promise(() => Bun.write(path.join(dir, "README.md"), "# e2e\n"))

        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command ls",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("command ls")
        expect(tool.state.output).toContain("README.md")
        expect(tool.state.metadata.output).toContain("README.md")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell captures stderr from a failing command", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("not found")
        expect(tool.state.metadata.output).toContain("not found")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const fiber = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
              .pipe(Effect.forkChild)

            yield* Effect.promise(async () => {
              const start = Date.now()
              while (Date.now() - start < 5000) {
                const msgs = await MessageV2.filterCompacted(MessageV2.stream(chat.id))
                const taskMsg = msgs.find((item) => item.info.role === "assistant")
                const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
                if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return
                await new Promise((done) => setTimeout(done, 20))
              }
              throw new Error("timed out waiting for running shell metadata")
            })

            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

it.live(
  "loop waits while shell runs and starts after shell exits",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("after-shell")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const exit = yield* Fiber.await(loop)

        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "shell completion resumes queued loop callers",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("done")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
          expect(ea.value.info.id).toBe(eb.value.info.id)
          expect(ea.value.info.role).toBe("assistant")
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "runtime model patch after prompt queued behind shell does not affect queued snapshot",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const run = yield* SessionRunState.Service
        const chat = yield* sessions.create({ title: "Shell queued runtime snapshot" })
        yield* runtime.set({ sessionID: chat.id, config: { model: ref } })
        yield* llm.text("after-shell")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const firstID = MessageID.ascending()
        const first = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: firstID,
            agent: "build",
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            if ((await Effect.runPromise(run.get(chat.id)))?._tag === "ShellThenRun") return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for queued run")
        })

        yield* runtime.set({ sessionID: chat.id, config: { model: altRef } })

        const secondID = MessageID.ascending()
        const second = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: secondID,
            agent: "build",
            parts: [{ type: "text", text: "second" }],
          })
          .pipe(Effect.forkChild)

        yield* Fiber.await(sh)
        const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
        expect(Exit.isSuccess(firstExit)).toBe(true)
        expect(Exit.isSuccess(secondExit)).toBe(true)
        expect(yield* llm.calls).toBe(1)

        const inputs = yield* llm.inputs
        expect(inputs.map((input) => (input as { model?: string }).model)).toEqual([ref.modelID])

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const firstUser = messages.find((msg) => msg.info.role === "user" && msg.info.id === firstID)
        const secondUser = messages.find((msg) => msg.info.role === "user" && msg.info.id === secondID)
        if (firstUser?.info.role === "user") expect(firstUser.info.model).toEqual(ref)
        if (secondUser?.info.role === "user") expect(secondUser.info.model).toEqual(ref)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancelled shell queued runtime snapshot does not leak into the next prompt",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* SessionRuntimeConfig.Service
        const run = yield* SessionRunState.Service
        const chat = yield* sessions.create({ title: "Shell queued runtime cleanup" })
        yield* runtime.set({ sessionID: chat.id, config: { model: ref } })

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const queued = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            parts: [{ type: "text", text: "queued" }],
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            if ((await Effect.runPromise(run.get(chat.id)))?._tag === "ShellThenRun") return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for queued run")
        })

        yield* runtime.set({ sessionID: chat.id, config: { model: altRef } })
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(sh)
        yield* Fiber.await(queued)

        yield* llm.text("fresh")
        const fresh = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "fresh" }],
        })

        expect(fresh.info.role).toBe("assistant")
        expect(yield* llm.calls).toBe(1)
        const inputs = yield* llm.inputs
        expect(inputs.map((input) => (input as { model?: string }).model)).toEqual([altRef.modelID])
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

itFake.live.serial(
  "cancelled interrupt queued runtime snapshot does not leak into the next queued prompt",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          fakeLLM.reset()
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const runtime = yield* SessionRuntimeConfig.Service
          const run = yield* SessionRunState.Service
          const chat = yield* sessions.create({ title: "Interrupt queued runtime cleanup" })
          const inputs: LLM.StreamInput[] = []
          const releaseInterrupt = defer<void>()

          yield* runtime.set({ sessionID: chat.id, config: { model: ref } })
          fakeLLM.push((input) => {
            inputs.push(input)
            return Stream.never.pipe(Stream.ensuring(Effect.promise(() => releaseInterrupt.promise)))
          })
          fakeLLM.push((input) => {
            inputs.push(input)
            return llmText("fresh")
          })

          yield* user(chat.id, "first")
          const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(async () => {
            const end = Date.now() + 5000
            while (Date.now() < end) {
              if (inputs.length === 1 && (await Effect.runPromise(run.get(chat.id)))?._tag === "Running") return
              await new Promise((done) => setTimeout(done, 20))
            }
            throw new Error("timed out waiting for running prompt")
          })

          const cancelFirst = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
          yield* Effect.promise(async () => {
            const end = Date.now() + 5000
            while (Date.now() < end) {
              if ((await Effect.runPromise(run.get(chat.id)))?._tag === "Interrupting") return
              await new Promise((done) => setTimeout(done, 20))
            }
            throw new Error("timed out waiting for interrupting prompt")
          })

          const stale = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [{ type: "text", text: "stale queued" }],
            })
            .pipe(Effect.forkChild)
          yield* Effect.promise(async () => {
            const end = Date.now() + 5000
            while (Date.now() < end) {
              if ((await Effect.runPromise(run.get(chat.id)))?._tag === "InterruptingThenRun") return
              await new Promise((done) => setTimeout(done, 20))
            }
            throw new Error("timed out waiting for queued interrupted prompt")
          })

          yield* runtime.set({ sessionID: chat.id, config: { model: altRef } })
          const cancelStale = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
          yield* Effect.promise(async () => {
            const end = Date.now() + 5000
            while (Date.now() < end) {
              if ((await Effect.runPromise(run.get(chat.id)))?._tag === "Interrupting") return
              await new Promise((done) => setTimeout(done, 20))
            }
            throw new Error("timed out waiting for queued prompt cancellation")
          })

          const fresh = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [{ type: "text", text: "fresh queued" }],
            })
            .pipe(Effect.forkChild)
          yield* Effect.promise(async () => {
            const end = Date.now() + 5000
            while (Date.now() < end) {
              if ((await Effect.runPromise(run.get(chat.id)))?._tag === "InterruptingThenRun") return
              await new Promise((done) => setTimeout(done, 20))
            }
            throw new Error("timed out waiting for fresh queued prompt")
          })

          releaseInterrupt.resolve(undefined)
          expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(cancelFirst))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(stale))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(cancelStale))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(fresh))).toBe(true)
          expect(inputs.map((input) => input.model.id)).toEqual([ref.modelID, altRef.modelID])
        }),
      { git: true },
    ),
  10_000,
)

unix(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, run, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const status = yield* SessionStatus.Service
            expect((yield* status.get(chat.id)).type).toBe("idle")
            const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
            expect(Exit.isSuccess(busy)).toBe(true)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "trap '' TERM; sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "Interrupted bash truncation",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "run bash" }],
          })

          yield* llm.tool("bash", {
            command:
              'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; sleep 30',
            description: "Print many lines",
            timeout: 30_000,
            workdir: path.resolve(dir),
          })

          const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* llm.wait(1)
          yield* Effect.sleep(150)
          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(run)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isFailure(exit)) return

          const tool = completedTool(exit.value.parts)
          if (!tool) return

          expect(tool.state.metadata.truncated).toBe(true)
          expect(typeof tool.state.metadata.outputPath).toBe("string")
          expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
          expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
          expect(tool.state.output).not.toContain("Tool execution aborted")
        }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

itFake.live.serial(
  "cancelled tool use does not poison the next prompt",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          fakeLLM.reset()
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "Abort cleanup",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          const started = defer<void>()
          fakeLLM.toolHang("bash", { cmd: "sleep 30" }, () => started.resolve())
          yield* user(chat.id, "run bash")

          const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => started.promise)
          yield* prompt.cancel(chat.id)
          const firstExit = yield* Fiber.await(first)

          expect(Exit.isSuccess(firstExit)).toBe(true)
          if (Exit.isFailure(firstExit)) return

          const tool = errorTool(firstExit.value.parts)
          if (tool) expect(tool.state.error).toBe("Tool execution aborted")

          fakeLLM.text("hello again")
          yield* user(chat.id, "hello again")

          const second = yield* prompt.loop({ sessionID: chat.id })
          expect(second.info.role).toBe("assistant")
          expect(second.parts.some((part) => part.type === "text" && part.text.includes("hello again"))).toBe(true)
        }),
      { git: true },
    ),
  10_000,
)

unix(
  "cancel interrupts loop queued behind shell",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const { prompt, chat } = yield* boot()

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
            .pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(loop)
          expect(Exit.isSuccess(exit)).toBe(true)

          yield* Fiber.await(sh)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const a = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            const exit = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "echo hi" })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
            }

            yield* prompt.cancel(chat.id)
            yield* Fiber.await(a)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

// Abort signal propagation tests for inline tool execution

/** Override a tool's execute to hang until aborted. Returns ready/aborted defers and a finalizer. */
function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  const ready = defer<void>()
  const aborted = defer<void>()
  const original = tool.execute
  tool.execute = (_args: any, ctx: any) => {
    ready.resolve()
    ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
    return Effect.callback<never>(() => {})
  }
  const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
  return { ready, aborted, restore }
}

it.live(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const testFile = path.join(dir, "test.txt")
          yield* Effect.promise(() => Bun.write(testFile, "hello world"))

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

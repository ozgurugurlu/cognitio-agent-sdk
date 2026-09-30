import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { jsonSchema, tool } from "ai"
import type { z } from "zod"
import { Cause, Effect, Exit, Fiber, Layer, Metric, Scope } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Runner } from "../../src/effect"
import { Config } from "../../src/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { type Handle, type Result, SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { SessionMetrics } from "../../src/effect/metrics"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"

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
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfgWithCost(url: string) {
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
            // USD per million tokens
            cost: { input: 3, output: 15 },
          },
        },
      },
    },
  }
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

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
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

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
  agentName = "build",
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: agentName,
    agent: agentName,
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps)),
)

const it = testEffect(env)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

const processorRunner = Effect.fn("test.processorRunner")(function* (sessionID: SessionID) {
  const scope = yield* Scope.Scope
  const status = yield* SessionStatus.Service
  return Runner.make<Result>(scope, {
    onIdle: status.set(sessionID, { type: "idle" }),
    onInterrupt: Effect.interrupt,
  })
})

const runProcess = Effect.fn("test.runProcess")(function* (sessionID: SessionID, handle: Handle, input: LLM.StreamInput) {
  const runner = yield* processorRunner(sessionID)
  return yield* runner.ensureRunning(handle.process(input))
})

const forkProcess = Effect.fn("test.forkProcess")(function* (sessionID: SessionID, handle: Handle, input: LLM.StreamInput) {
  const runner = yield* processorRunner(sessionID)
  return {
    cancel: runner.cancel,
    fiber: yield* runner.ensureRunning(handle.process(input)).pipe(Effect.forkChild),
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* runProcess(chat.id, handle, input)
        const parts = MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* forkProcess(chat.id, handle, {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })

        yield* Effect.promise(async () => {
          const stop = Date.now() + 500
          while (Date.now() < stop) {
            const text = MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")
            if (text?.time?.start) return
            await Bun.sleep(10)
          }
          throw new Error("timed out waiting for text part")
        })
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run.fiber)
        const text = MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* runProcess(chat.id, handle, {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* runProcess(chat.id, handle, {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is MessageV2.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is MessageV2.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* runProcess(chat.id, handle, {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is MessageV2.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* runProcess(chat.id, handle, {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* runProcess(chat.id, handle, {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") states.push(evt.properties.status.attempt)
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* runProcess(chat.id, handle, {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        off()

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* runProcess(chat.id, handle, {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* forkProcess(chat.id, handle, {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool abort" }],
          tools: {},
        })

        yield* llm.wait(1)
        yield* Effect.promise(async () => {
          const end = Date.now() + 500
          while (Date.now() < end) {
            const parts = await MessageV2.parts(msg.id)
            if (parts.some((part) => part.type === "tool")) return
            await Bun.sleep(10)
          }
        })
        yield* run.cancel

        const exit = yield* Fiber.await(run.fiber)
        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests resolve doom-loop permissions with accepted runtime agents", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const input = { cmd: "pwd" }

        yield* llm.tool("bash", input)

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool loop")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir), "runtime-helper")
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

        yield* Effect.forEach(
          ["previous-1", "previous-2"],
          (callID) =>
            session.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: chat.id,
              type: "tool",
              tool: "bash",
              callID,
              state: {
                status: "completed",
                input,
                output: "",
                title: "bash",
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
            } satisfies MessageV2.ToolPart),
          { discard: true },
        )

        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          runtime: {
            agents: {
              "runtime-helper": {
                prompt: "Help with runtime-scoped work.",
                description: "Runtime helper",
              },
            },
          },
        })

        const value = yield* runProcess(chat.id, handle, {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool loop" }],
          tools: {},
        })

        expect(value).toBe("continue")
        expect(MessageV2.parts(msg.id).filter((part) => part.type === "tool" && part.tool === "bash")).toHaveLength(3)
      }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        permission: { doom_loop: "allow" },
      }),
    },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* bus.subscribeCallback(Session.Event.Error, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (!evt.properties.error) return
          errs.push(evt.properties.error.name)
          seen.resolve()
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* forkProcess(chat.id, handle, {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "abort" }],
          tools: {},
        })

        yield* llm.wait(1)
        yield* run.cancel

        const exit = yield* Fiber.await(run.fiber)
        yield* Effect.promise(() => seen.promise)
        const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        off()

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* forkProcess(chat.id, handle, {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "interrupt" }],
          tools: {},
        })

        yield* llm.wait(1)
        yield* run.cancel

        const exit = yield* Fiber.await(run.fiber)
        const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

// ---------------------------------------------------------------------------
// Phase 10 — observability events (rate limit + task lifecycle)
// ---------------------------------------------------------------------------

const streamInput = (
  chat: { id: SessionID },
  parent: MessageV2.User,
  mdl: Provider.Model,
  tools: LLM.StreamInput["tools"] = {},
): LLM.StreamInput => ({
  user: {
    id: parent.id,
    sessionID: chat.id,
    role: "user",
    time: parent.time,
    agent: parent.agent,
    model: { providerID: ref.providerID, modelID: ref.modelID },
  } satisfies MessageV2.User,
  sessionID: chat.id,
  model: mdl,
  agent: agent(),
  system: [],
  messages: [{ role: "user", content: "observability" }],
  tools,
})

const echoTool = (gate?: Promise<unknown>) =>
  tool({
    inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
    execute: async () => {
      if (gate) await gate
      return { title: "echo done", metadata: {}, output: "ok" }
    },
  })

const waitForRunningTool = (messageID: MessageID) =>
  Effect.promise(async () => {
    const end = Date.now() + 2000
    while (Date.now() < end) {
      const parts = MessageV2.parts(messageID)
      const part = parts.find((item): item is MessageV2.ToolPart => item.type === "tool")
      if (part && part.state.status === "running") return part
      await Bun.sleep(10)
    }
    throw new Error("tool never reached running state")
  })

it.live("session.processor effect tests publish rate limit events on retried 429", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.error(429, { error: { message: "too many requests" } }, { "retry-after-ms": "5" })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "rate limit")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const events: z.output<(typeof Session.Event.RateLimitHit)["properties"]>[] = []
        const off = yield* bus.subscribeCallback(Session.Event.RateLimitHit, (evt) => {
          events.push(evt.properties)
        })
        const counterBefore = Number(
          (yield* Metric.value(
            Metric.withAttributes(SessionMetrics.counters.rateLimitCount, { provider: ref.providerID as string }),
          )).count,
        )
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* runProcess(chat.id, handle, streamInput(chat, parent, mdl))
        off()
        const counterAfter = Number(
          (yield* Metric.value(
            Metric.withAttributes(SessionMetrics.counters.rateLimitCount, { provider: ref.providerID as string }),
          )).count,
        )

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(counterAfter - counterBefore).toBe(1)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          sessionID: chat.id,
          activeSessionID: chat.id,
          provider: "test",
          model: "test-model",
          attempt: 1,
        })
        expect(events[0].retryAfterSeconds).toBeCloseTo(0.005)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish rate limit events for non-retryable errors via halt", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.error(400, { error: { message: "Rate limit exceeded for this key" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hard rate limit")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const events: z.output<(typeof Session.Event.RateLimitHit)["properties"]>[] = []
        const off = yield* bus.subscribeCallback(Session.Event.RateLimitHit, (evt) => {
          events.push(evt.properties)
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* runProcess(chat.id, handle, streamInput(chat, parent, mdl))
        off()

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          sessionID: chat.id,
          activeSessionID: chat.id,
          provider: "test",
        })
        expect(events[0].attempt).toBeUndefined()
        expect(events[0].retryAfterSeconds).toBeUndefined()
        expect(handle.message.error).toBeDefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish task lifecycle events for completed tools", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const gate = defer<void>()

        yield* llm.tool("echo", {})

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "task lifecycle")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const started: z.output<(typeof Session.Event.TaskStarted)["properties"]>[] = []
        const progress: z.output<(typeof Session.Event.TaskProgress)["properties"]>[] = []
        const stopped: z.output<(typeof Session.Event.TaskStopped)["properties"]>[] = []
        const offs = [
          yield* bus.subscribeCallback(Session.Event.TaskStarted, (evt) => {
            started.push(evt.properties)
          }),
          yield* bus.subscribeCallback(Session.Event.TaskProgress, (evt) => {
            progress.push(evt.properties)
          }),
          yield* bus.subscribeCallback(Session.Event.TaskStopped, (evt) => {
            stopped.push(evt.properties)
          }),
        ]
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* forkProcess(
          chat.id,
          handle,
          streamInput(chat, parent, mdl, { echo: echoTool(gate.promise) }),
        )

        yield* waitForRunningTool(msg.id)
        const longTitle = "halfway there ".repeat(30) // > 256 chars
        yield* handle.updateToolCall("call_1", (part) =>
          part.state.status === "running" ? { ...part, state: { ...part.state, title: longTitle } } : part,
        )
        // Second update lands inside the 500ms throttle window -> suppressed.
        yield* handle.updateToolCall("call_1", (part) =>
          part.state.status === "running" ? { ...part, state: { ...part.state, title: "second" } } : part,
        )
        gate.resolve()

        const exit = yield* Fiber.await(run.fiber)
        for (const off of offs) off()

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(started).toHaveLength(1)
        expect(started[0]).toMatchObject({
          sessionID: chat.id,
          activeSessionID: chat.id,
          taskID: "call_1",
          messageID: msg.id,
          tool: "echo",
          agent: "build",
        })
        // First metadata update always emits; the immediate second one is
        // throttled. Titles are truncated to 256 chars.
        expect(progress).toHaveLength(1)
        expect(progress[0].taskID).toBe("call_1")
        expect(progress[0].title).toHaveLength(256)
        expect(progress[0].title!.startsWith("halfway there ")).toBe(true)
        expect(progress[0].elapsedMs).toBeGreaterThanOrEqual(0)
        expect(stopped).toHaveLength(1)
        expect(stopped[0]).toMatchObject({ taskID: "call_1", status: "completed", title: "echo done" })
        expect(stopped[0].durationMs).toBeGreaterThan(0)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish task stopped with error status for failing tools", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.tool("boom", {})

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "task failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const stopped: z.output<(typeof Session.Event.TaskStopped)["properties"]>[] = []
        const off = yield* bus.subscribeCallback(Session.Event.TaskStopped, (evt) => {
          stopped.push(evt.properties)
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const boom = tool({
          inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
          execute: async (): Promise<{ title: string; metadata: Record<string, never>; output: string }> => {
            throw new Error("kaput")
          },
        })
        yield* runProcess(chat.id, handle, streamInput(chat, parent, mdl, { boom }))
        off()

        expect(stopped).toHaveLength(1)
        expect(stopped[0]).toMatchObject({ taskID: "call_1", status: "error", tool: "boom" })
        expect(stopped[0].error).toContain("kaput")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish task stopped with interrupted status on abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const gate = defer<void>()

        yield* llm.tool("echo", {})

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "task abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const stopped: z.output<(typeof Session.Event.TaskStopped)["properties"]>[] = []
        const off = yield* bus.subscribeCallback(Session.Event.TaskStopped, (evt) => {
          stopped.push(evt.properties)
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* forkProcess(
          chat.id,
          handle,
          streamInput(chat, parent, mdl, { echo: echoTool(gate.promise) }),
        )

        yield* waitForRunningTool(msg.id)
        yield* run.cancel

        const exit = yield* Fiber.await(run.fiber)
        // Event delivery to the subscription runs on its own fiber; the
        // publish happens at the very end of cleanup, so give it a beat.
        yield* Effect.promise(async () => {
          const end = Date.now() + 1000
          while (stopped.length === 0 && Date.now() < end) await Bun.sleep(10)
        })
        off()
        gate.resolve()

        expect(Exit.isFailure(exit)).toBe(true)
        expect(stopped).toHaveLength(1)
        expect(stopped[0]).toMatchObject({ taskID: "call_1", status: "interrupted", tool: "echo" })
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests route task events from child sessions to the root session", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.tool("echo", {})

        const root = yield* session.create({})
        const chat = yield* session.create({ parentID: root.id })
        const parent = yield* user(chat.id, "child task")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const started: z.output<(typeof Session.Event.TaskStarted)["properties"]>[] = []
        const off = yield* bus.subscribeCallback(Session.Event.TaskStarted, (evt) => {
          started.push(evt.properties)
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        yield* runProcess(chat.id, handle, streamInput(chat, parent, mdl, { echo: echoTool() }))
        off()

        expect(started).toHaveLength(1)
        expect(started[0]).toMatchObject({ sessionID: root.id, activeSessionID: chat.id, tool: "echo" })
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish still_running notifications for silent long tools", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        process.env.COGNITIO_TASK_HEARTBEAT_MS = "50"
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const gate = defer<void>()

        yield* llm.tool("echo", {})

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "silent task")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const notifications: z.output<(typeof Session.Event.TaskNotification)["properties"]>[] = []
        const off = yield* bus.subscribeCallback(Session.Event.TaskNotification, (evt) => {
          notifications.push(evt.properties)
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* forkProcess(
          chat.id,
          handle,
          streamInput(chat, parent, mdl, { echo: echoTool(gate.promise) }),
        )

        yield* waitForRunningTool(msg.id)
        yield* Effect.promise(async () => {
          const end = Date.now() + 2000
          while (notifications.length === 0 && Date.now() < end) await Bun.sleep(10)
        })
        gate.resolve()
        const exit = yield* Fiber.await(run.fiber)
        off()

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(notifications.length).toBeGreaterThanOrEqual(1)
        expect(notifications[0]).toMatchObject({
          sessionID: chat.id,
          activeSessionID: chat.id,
          taskID: "call_1",
          tool: "echo",
          kind: "still_running",
        })
        expect(notifications[0].elapsedMs).toBeGreaterThanOrEqual(50)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            delete process.env.COGNITIO_TASK_HEARTBEAT_MS
          }),
        ),
      ),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests feed token metrics consistent with message usage", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const attrs = { provider: ref.providerID as string, model: ref.modelID as string }
        const readToken = (type: string) =>
          Effect.map(
            Metric.value(Metric.withAttributes(SessionMetrics.counters.tokenUsage, { ...attrs, type })),
            (state) => Number(state.count),
          )

        const before = { input: yield* readToken("input"), output: yield* readToken("output") }

        yield* llm.text("hello", { usage: { input: 120, output: 30 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "usage metrics")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* runProcess(chat.id, handle, streamInput(chat, parent, mdl))
        const after = { input: yield* readToken("input"), output: yield* readToken("output") }

        expect(value).toBe("continue")
        // Metric deltas must equal the usage recorded on the assistant message
        // (the same numbers session.result aggregates from), with the metric
        // `output` type covering output + reasoning.
        expect(after.input - before.input).toBe(handle.message.tokens.input)
        expect(after.output - before.output).toBe(handle.message.tokens.output + handle.message.tokens.reasoning)
        expect(handle.message.tokens.input).toBe(120)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests feed cost metrics consistent with message cost", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const attrs = { provider: ref.providerID as string, model: ref.modelID as string }
        const readCost = Effect.map(
          Metric.value(Metric.withAttributes(SessionMetrics.counters.costUsage, attrs)),
          (state) => Number(state.count),
        )

        const before = yield* readCost

        yield* llm.text("hello", { usage: { input: 20_000, output: 5_000 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "cost metrics")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* runProcess(chat.id, handle, streamInput(chat, parent, mdl))
        const after = yield* readCost

        expect(value).toBe("continue")
        // Guard against a vacuous 0 == 0 pass if cost computation regresses.
        expect(handle.message.cost).toBeGreaterThan(0)
        // Cost counter delta must equal the cost recorded on the assistant
        // message (the same number session.result aggregates).
        expect(after - before).toBeCloseTo(handle.message.cost, 10)
      }),
    { git: true, config: (url) => providerCfgWithCost(url) },
  ),
)

it.live("session.processor effect tests omit arbitrary error objects from task.stopped", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.tool("leaky", {})

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "leaky error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const stopped: z.output<(typeof Session.Event.TaskStopped)["properties"]>[] = []
        const off = yield* bus.subscribeCallback(Session.Event.TaskStopped, (evt) => {
          stopped.push(evt.properties)
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const leaky = tool({
          inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
          execute: async (): Promise<{ title: string; metadata: Record<string, never>; output: string }> => {
            // Arbitrary error object carrying sensitive-looking fields — must
            // never be JSON-serialized into the task event.
            throw { secretCommand: "rm -rf /", stdout: "super secret output" }
          },
        })
        yield* runProcess(chat.id, handle, streamInput(chat, parent, mdl, { leaky }))
        off()

        expect(stopped).toHaveLength(1)
        expect(stopped[0].status).toBe("error")
        const text = stopped[0].error ?? ""
        expect(text).not.toContain("secretCommand")
        expect(text).not.toContain("rm -rf")
        expect(text).not.toContain("super secret output")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests route fork events to the fork, not the original session", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.tool("echo", {})
        yield* llm.tool("echo", {})

        const original = yield* session.create({})
        const forked = yield* session.fork({ sessionID: original.id })
        expect(forked.parentID).toBe(original.id)
        expect(forked.forkedFrom).toBe(original.id)

        const started: z.output<(typeof Session.Event.TaskStarted)["properties"]>[] = []
        const off = yield* bus.subscribeCallback(Session.Event.TaskStarted, (evt) => {
          started.push(evt.properties)
        })
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

        // A tool run on the fork itself must reach the fork's own stream.
        const parent = yield* user(forked.id, "fork task")
        const msg = yield* assistant(forked.id, parent.id, path.resolve(dir))
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: forked.id,
          model: mdl,
        })
        yield* runProcess(forked.id, handle, streamInput(forked, parent, mdl, { echo: echoTool() }))

        // A subagent child OF the fork routes to the fork as its root — the
        // lineage walk stops at the fork boundary instead of reaching the
        // original session.
        const child = yield* session.create({ parentID: forked.id })
        const childParent = yield* user(child.id, "fork child task")
        const childMsg = yield* assistant(child.id, childParent.id, path.resolve(dir))
        const childHandle = yield* processors.create({
          assistantMessage: childMsg,
          sessionID: child.id,
          model: mdl,
        })
        yield* runProcess(child.id, childHandle, streamInput(child, childParent, mdl, { echo: echoTool() }))
        off()

        expect(started).toHaveLength(2)
        expect(started[0]).toMatchObject({ sessionID: forked.id, activeSessionID: forked.id })
        expect(started[1]).toMatchObject({ sessionID: forked.id, activeSessionID: child.id })
        expect(started.every((evt) => (evt.sessionID as string) !== (original.id as string))).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

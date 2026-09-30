import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { SessionRuntimeConfig } from "../../src/session/runtime-config"
import { SubagentInherit } from "../../src/session/subagent-inherit"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { RuntimePlugin } from "../../src/plugin/runtime"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "../../src/tool"
import { ToolRegistry } from "../../src/tool"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRuntimeConfig.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, user, assistant }
})

const seedInheritableTranscript = Effect.fn("TaskToolTest.seedInheritableTranscript")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Inherited context" })
  const firstUser = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: firstUser.id,
    sessionID: chat.id,
    type: "text",
    text: "remember alpha",
  })
  const firstAssistant = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    parentID: firstUser.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 12,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 3 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    finish: "stop" as const,
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: firstAssistant.id,
    sessionID: chat.id,
    type: "text",
    text: "alpha saved",
  })
  const secondUser = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    parentMessageID: firstAssistant.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: secondUser.id,
    sessionID: chat.id,
    type: "text",
    text: "delegate now",
  })
  const currentAssistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: secondUser.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(currentAssistant)
  return { chat, currentAssistant }
})

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
  onResolve?: (
    template: string,
    runtime?: SessionRuntimeConfig.RuntimeConfig,
  ) => SessionPrompt.PromptInput["parts"]
}): TaskPromptOps {
  return {
    cancel() {},
    resolvePromptParts: (template, runtime) =>
      Effect.succeed(opts?.onResolve?.(template, runtime) ?? [{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.live("description sorts subagents by name and is stable across calls", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const get = Effect.fnUntraced(function* () {
            const tools = yield* registry.tools({ ...ref, agent: build })
            return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
          })
          const first = yield* get()
          const second = yield* get()

          expect(first).toBe(second)

          const alpha = first.indexOf("- alpha: Alpha agent")
          const explore = first.indexOf("- explore:")
          const general = first.indexOf("- general:")
          const zebra = first.indexOf("- zebra: Zebra agent")

          expect(alpha).toBeGreaterThan(-1)
          expect(explore).toBeGreaterThan(alpha)
          expect(general).toBeGreaterThan(explore)
          expect(zebra).toBeGreaterThan(general)
        }),
      {
        config: {
          agent: {
            zebra: {
              description: "Zebra agent",
              mode: "subagent",
            },
            alpha: {
              description: "Alpha agent",
              mode: "subagent",
            },
          },
        },
      },
    ),
  )

  it.live("description hides denied subagents for the caller", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const description =
            (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

          expect(description).toContain("- alpha: Alpha agent")
          expect(description).not.toContain("- zebra: Zebra agent")
        }),
      {
        config: {
          permission: {
            task: {
              "*": "allow",
              zebra: "deny",
            },
          },
          agent: {
            zebra: {
              description: "Zebra agent",
              mode: "subagent",
            },
            alpha: {
              description: "Alpha agent",
              mode: "subagent",
            },
          },
        },
      },
    ),
  )

  it.live("description includes runtime-only subagents", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({
            ...ref,
            agent: build,
            runtime: {
              agents: {
                reviewer: {
                  prompt: "Review only.",
                  description: "Runtime reviewer",
                },
              },
            },
          })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- reviewer: Runtime reviewer")
      }),
    ),
  )

  it.live("execute resumes an existing task session from task_id", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const kids = yield* sessions.children(chat.id)
        expect(kids).toHaveLength(1)
        expect(kids[0]?.id).toBe(child.id)
        expect(result.metadata.sessionId).toBe(child.id)
        expect(result.output).toContain(`task_id: ${child.id}`)
        expect(seen?.sessionID).toBe(child.id)
      }),
    ),
  )

  it.live("execute rejects task_id from another session tree", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const otherRoot = yield* sessions.create({ title: "Other root" })
        const otherChild = yield* sessions.create({ parentID: otherRoot.id, title: "Other child" })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              task_id: otherChild.id,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Cannot resume task_id outside the current session tree")
      }),
    ),
  )

  it.live("execute rejects task_id that points at an ancestor session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "Child" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: child.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant" as const,
          parentID: user.id,
          sessionID: child.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let prompted = false

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              task_id: chat.id,
            },
            {
              sessionID: child.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: stubOps({
                  onPrompt: () => {
                    prompted = true
                  },
                }),
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(prompted).toBe(false)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Cannot resume task_id outside the current session tree")
      }),
    ),
  )

  it.live("execute asks by default and skips checks when bypassed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const calls: unknown[] = []
        const promptOps = stubOps()

        const exec = (extra?: Record<string, any>) =>
          def.execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps, ...extra },
              messages: [],
              metadata: () => Effect.void,
              ask: (input) =>
                Effect.sync(() => {
                  calls.push(input)
                }),
            },
          )

        yield* exec()
        yield* exec({ bypassAgentCheck: true })

        expect(calls).toHaveLength(1)
        expect(calls[0]).toEqual({
          permission: "task",
          patterns: ["general"],
          always: ["*"],
          toolInput: {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            spawnMode: "fresh",
          },
          metadata: {
            description: "inspect bug",
            subagent_type: "general",
            spawnMode: "fresh",
          },
        })
      }),
    ),
  )

  it.live("same-millisecond message inserts keep creation order", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Ordering" })
        const now = Date.now()
        const first = yield* sessions.updateMessage({
          id: MessageID.make("msg_z"),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: now },
        })
        const second = yield* sessions.updateMessage({
          id: MessageID.make("msg_a"),
          role: "assistant" as const,
          parentID: first.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: now },
        })

        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages.map((message) => message.info.id)).toEqual([first.id, second.id])
        expect(messages[1]?.info.time.created).toBeGreaterThan(messages[0]?.info.time.created ?? 0)
        expect(yield* MessageV2.lookupLastMessageID(chat.id)).toBe(second.id)
      }),
    ),
  )

  it.live("execute creates a child when task_id does not exist", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: "ses_missing",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const kids = yield* sessions.children(chat.id)
        expect(kids).toHaveLength(1)
        expect(kids[0]?.id).toBe(result.metadata.sessionId)
        expect(result.metadata.sessionId).not.toBe("ses_missing")
        expect(result.output).toContain(`task_id: ${result.metadata.sessionId}`)
        expect(seen?.sessionID).toBe(result.metadata.sessionId)
      }),
    ),
  )

  it.live("execute passes agent-preferred model and child message metadata", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()
          const runtime: SessionRuntimeConfig.RuntimeConfig = { model: ref }
          let seen: (SessionPrompt.PromptInput & { runtime?: SessionRuntimeConfig.RuntimeConfig }) | undefined
          let running: { title?: string; metadata?: Record<string, unknown> } | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          const result = yield* def.execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps, runtime },
              messages: [],
              metadata: (input) =>
                Effect.sync(() => {
                  running = input
                }),
              ask: () => Effect.void,
            },
          )

          expect(seen?.model).toEqual({ providerID: ProviderID.make("missing"), modelID: ModelID.make("missing-model") })
          expect(seen?.runtime).toEqual({
            ...runtime,
            model: { providerID: ProviderID.make("missing"), modelID: ModelID.make("missing-model") },
          })
          if (!seen?.messageID) throw new Error("missing child message id")
          expect(result.metadata.model).toEqual({ providerID: ProviderID.make("missing"), modelID: ModelID.make("missing-model") })
          expect(typeof result.metadata.messageId).toBe("string")
          expect(result.metadata.messageId).toBe(seen.messageID)
          expect(running?.metadata?.messageId).toBe(seen.messageID)
        }),
      {
        config: {
          agent: {
            general: {
              model: "missing/missing-model",
            },
          },
        },
      },
    ),
  )

  it.live("execute shapes child permissions for task, todowrite, and primary tools", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          const result = yield* def.execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "reviewer",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const child = yield* sessions.get(result.metadata.sessionId)
          expect(child.parentID).toBe(chat.id)
          expect(child.permission).toEqual([
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "bash",
              pattern: "*",
              action: "allow",
            },
            {
              permission: "read",
              pattern: "*",
              action: "allow",
            },
          ])
          expect(seen?.tools).toEqual({
            todowrite: false,
            bash: false,
            read: false,
          })
        }),
      {
        config: {
          agent: {
            reviewer: {
              mode: "subagent",
              permission: {
                task: "allow",
              },
            },
          },
          experimental: {
            primary_tools: ["bash", "read"],
          },
        },
      },
    ),
  )

  it.live("execute derives runtime-only agent policy for a fresh child", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: (SessionPrompt.PromptInput & { runtime?: SessionRuntimeConfig.RuntimeConfig }) | undefined
        const runtime: SessionRuntimeConfig.RuntimeConfig = {
          allowedTools: ["read", "bash"],
          disallowedTools: ["write"],
          permissionMode: "default",
          agents: {
            reviewer: {
              prompt: "Review only.",
              model: { providerID: "test", modelID: "review-model" },
              tools: ["read"],
              disallowedTools: ["bash"],
              permissionMode: "dontAsk",
              steps: 2,
              spawnMode: "inherit",
              mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
            },
          },
        }

        const result = yield* def.execute(
          {
            description: "review code",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }), runtime },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.metadata.spawnMode).toBe("inherit")
        expect(seen?.agent).toBe("reviewer")
        expect(seen?.model).toEqual({ providerID: ProviderID.make("test"), modelID: ModelID.make("review-model") })
        expect(seen?.runtime).toMatchObject({
          model: { providerID: "test", modelID: "review-model" },
          allowedTools: ["read"],
          disallowedTools: ["write", "bash"],
          permissionMode: "dontAsk",
          maxTurns: 2,
          sdkMcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
        })
      }),
    ),
  )

  it.live("execute resumes task_id with stored child runtime and restores agent MCP servers", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const runtimeSvc = yield* SessionRuntimeConfig.Service
        const { chat, currentAssistant } = yield* seedInheritableTranscript()
        const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
        yield* runtimeSvc.set({
          sessionID: child.id,
          config: {
            allowedTools: ["read"],
            model: { providerID: "test", modelID: "stored-child" },
          },
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: (SessionPrompt.PromptInput & { runtime?: SessionRuntimeConfig.RuntimeConfig }) | undefined

        const result = yield* def.execute(
          {
            description: "resume context",
            prompt: "continue stored child",
            subagent_type: "reviewer",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: currentAssistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({ onPrompt: (input) => (seen = input) }),
              runtime: {
                allowedTools: ["bash"],
                agents: {
                  reviewer: {
                    prompt: "Review only.",
                    model: { providerID: "test", modelID: "reviewer" },
                    spawnMode: "inherit",
                    tools: ["bash"],
                    mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
                  },
                },
              },
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.metadata.sessionId).toBe(child.id)
        expect(result.metadata.spawnMode).toBe("inherit")
        expect(seen?.runtime).toEqual({
          allowedTools: ["read"],
          agents: {
            reviewer: {
              prompt: "Review only.",
              model: { providerID: "test", modelID: "reviewer" },
              spawnMode: "inherit",
              tools: ["bash"],
              mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
            },
          },
          model: { providerID: "test", modelID: "stored-child" },
          sdkMcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
        })
        expect(yield* MessageV2.filterCompactedEffect(child.id)).toEqual([])
      }),
    ),
  )

  it.live("execute caps resumed stored child runtime with accepted parent runtime", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const runtimeSvc = yield* SessionRuntimeConfig.Service
        const { chat, currentAssistant } = yield* seedInheritableTranscript()
        const child = yield* sessions.create({ parentID: chat.id, title: "Existing capped child" })
        yield* runtimeSvc.set({
          sessionID: child.id,
          config: {
            allowedTools: ["read"],
            maxTurns: 50,
            maxBudgetUsd: 100,
          },
        })
        const parentRuntime: SessionRuntimeConfig.RuntimeConfig = {
          allowedTools: ["bash"],
          agents: {
            reviewer: {
              prompt: "Review with cap.",
              model: { providerID: "test", modelID: "reviewer" },
              spawnMode: "inherit",
            },
          },
        }
        const preparedRuntime = {
          ...parentRuntime,
          maxTurns: 3,
          maxBudgetUsd: 4,
        } satisfies SessionRuntimeConfig.RuntimeConfig
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: (SessionPrompt.PromptInput & { runtime?: SessionRuntimeConfig.RuntimeConfig }) | undefined

        yield* def.execute(
          {
            description: "resume capped",
            prompt: "continue with accepted caps",
            subagent_type: "reviewer",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: currentAssistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({ onPrompt: (input) => (seen = input) }),
              runtime: parentRuntime,
              prepareChildRun: () => Effect.succeed({ type: "continue" as const, runtime: preparedRuntime }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.runtime).toMatchObject({
          allowedTools: ["read"],
          maxTurns: 3,
          maxBudgetUsd: 4,
          agents: {
            reviewer: parentRuntime.agents!.reviewer,
          },
        })
      }),
    ),
  )

  it.live("execute re-expands stored plugin runtime before resolving resumed task prompt parts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const runtimeSvc = yield* SessionRuntimeConfig.Service
        const { chat, currentAssistant } = yield* seedInheritableTranscript()
        const child = yield* sessions.create({ parentID: chat.id, title: "Existing plugin child" })
        const parentRuntime = yield* RuntimePlugin.expand(
          {
            plugins: [
              {
                type: "inline",
                name: "team",
                agents: {
                  helper: {
                    prompt: "Help from plugin.",
                    description: "Plugin helper",
                    spawnMode: "inherit",
                  },
                },
              },
            ],
          },
          chat.id,
        )
        yield* runtimeSvc.set({
          sessionID: child.id,
          config: RuntimePlugin.collapse(parentRuntime),
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let resolvedRuntime: SessionRuntimeConfig.RuntimeConfig | undefined
        let seen: SessionPrompt.PromptInput | undefined

        const result = yield* def.execute(
          {
            description: "resume plugin child",
            prompt: "continue with @team:helper",
            subagent_type: "team:helper",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: currentAssistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                onResolve: (template, runtime) => {
                  resolvedRuntime = runtime
                  if (runtime?.agents?.["team:helper"]) return [{ type: "agent", name: "team:helper" }]
                  return [{ type: "text", text: template }]
                },
                onPrompt: (input) => (seen = input),
              }),
              runtime: parentRuntime,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.metadata.sessionId).toBe(child.id)
        expect(resolvedRuntime?.agents?.["team:helper"]?.prompt).toBe("Help from plugin.")
        expect(seen?.parts).toEqual([{ type: "agent", name: "team:helper" }])
      }),
    ),
  )

  it.live("execute resolves resumed task subagent from stored plugin runtime", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const runtimeSvc = yield* SessionRuntimeConfig.Service
        const { chat, currentAssistant } = yield* seedInheritableTranscript()
        const child = yield* sessions.create({ parentID: chat.id, title: "Existing stored plugin child" })
        const stored = yield* RuntimePlugin.expand(
          {
            plugins: [
              {
                type: "inline",
                name: "team",
                agents: {
                  helper: {
                    prompt: "Help from stored plugin.",
                    description: "Stored plugin helper",
                    spawnMode: "inherit",
                    mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
                  },
                },
              },
            ],
          },
          child.id,
        )
        yield* runtimeSvc.set({
          sessionID: child.id,
          config: RuntimePlugin.collapse(stored),
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: (SessionPrompt.PromptInput & { runtime?: SessionRuntimeConfig.RuntimeConfig }) | undefined

        const result = yield* def.execute(
          {
            description: "resume stored plugin",
            prompt: "continue stored plugin child",
            subagent_type: "team:helper",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: currentAssistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({ onPrompt: (input) => (seen = input) }),
              runtime: {},
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.metadata.sessionId).toBe(child.id)
        expect(result.metadata.spawnMode).toBe("inherit")
        expect(seen?.agent).toBe("team:helper")
        expect(seen?.runtime?.agents?.["team:helper"]?.prompt).toBe("Help from stored plugin.")
        expect(seen?.runtime?.sdkMcpServers).toEqual([
          { name: "plugin:team:remote", type: "remote", url: "https://example.com/mcp" },
        ])
      }),
    ),
  )

  it.live("execute restores parent plugin MCP when resumed fallback agent comes from accepted runtime", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const runtimeSvc = yield* SessionRuntimeConfig.Service
        const { chat, currentAssistant } = yield* seedInheritableTranscript()
        const child = yield* sessions.create({ parentID: chat.id, title: "Existing parent plugin child" })
        yield* runtimeSvc.set({
          sessionID: child.id,
          config: {
            allowedTools: ["read"],
          },
        })
        const parentRuntime = yield* RuntimePlugin.expand(
          {
            plugins: [
              {
                type: "inline",
                name: "team",
                agents: {
                  helper: {
                    prompt: "Help from accepted parent plugin.",
                    description: "Accepted parent plugin helper",
                    spawnMode: "inherit",
                  },
                },
                mcpServers: [{ name: "shared", type: "remote", url: "https://example.com/shared" }],
              },
            ],
          },
          chat.id,
        )
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: (SessionPrompt.PromptInput & { runtime?: SessionRuntimeConfig.RuntimeConfig }) | undefined

        yield* def.execute(
          {
            description: "resume parent plugin",
            prompt: "continue accepted parent plugin child",
            subagent_type: "team:helper",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: currentAssistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({ onPrompt: (input) => (seen = input) }),
              runtime: parentRuntime,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.runtime?.allowedTools).toEqual(["read"])
        expect(seen?.runtime?.agents?.["team:helper"]?.prompt).toBe("Help from accepted parent plugin.")
        expect(seen?.runtime?.sdkMcpServers).toEqual([
          { name: "plugin:team:shared", type: "remote", url: "https://example.com/shared" },
        ])
      }),
    ),
  )

  it.live("execute denies all child tools when runtime allow lists do not intersect", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: (SessionPrompt.PromptInput & { runtime?: SessionRuntimeConfig.RuntimeConfig }) | undefined

        yield* def.execute(
          {
            description: "review code",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({ onPrompt: (input) => (seen = input) }),
              runtime: {
                allowedTools: ["read"],
                agents: {
                  reviewer: {
                    prompt: "Review only.",
                    tools: ["bash"],
                  },
                },
              },
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.runtime?.allowedTools).toEqual([])
        expect(seen?.runtime?.disallowedTools).toEqual(["*"])
      }),
    ),
  )

  it.live("inherit mode copies safe parent history without charging child results", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, currentAssistant } = yield* seedInheritableTranscript()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inherit context",
            prompt: "use inherited facts",
            subagent_type: "general",
            spawnMode: "inherit",
          },
          {
            sessionID: chat.id,
            messageID: currentAssistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const childMessages = yield* MessageV2.filterCompactedEffect(result.metadata.sessionId)
        expect(childMessages.map((message) => message.info.role)).toEqual(["user", "assistant", "user"])
        expect(childMessages.flatMap((message) => message.parts).map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
          "remember alpha",
          "alpha saved",
          "delegate now",
        ])
        const inheritedAssistant = childMessages.find((message) => message.info.role === "assistant")
        if (!inheritedAssistant || inheritedAssistant.info.role !== "assistant") throw new Error("missing inherited assistant")
        expect(inheritedAssistant.info.cost).toBe(0)
        expect(inheritedAssistant.info.tokens).toEqual({
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        })
      }),
    ),
  )

  it.live("inherit compaction keeps the generated summary when it lands after the task boundary", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Oversized inherited context" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
        const oldUser = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: parent.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: oldUser.id,
          sessionID: parent.id,
          type: "text",
          text: "old bulk ".repeat(2_000),
        })
        const oldAssistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant" as const,
          parentID: oldUser.id,
          sessionID: parent.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "stop" as const,
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: oldAssistant.id,
          sessionID: parent.id,
          type: "text",
          text: "old answer",
        })
        const currentUser = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: parent.id,
          parentMessageID: oldAssistant.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: currentUser.id,
          sessionID: parent.id,
          type: "text",
          text: "delegate now",
        })
        const boundary = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant" as const,
          parentID: currentUser.id,
          sessionID: parent.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        })
        const provider = ProviderTest.fake({
          model: ProviderTest.model({
            id: ref.modelID,
            providerID: ref.providerID,
            limit: { context: 1_000, output: 1 },
          }),
        })
        const compactionLayer = Layer.succeed(
          SessionCompaction.Service,
          SessionCompaction.Service.of({
            isOverflow: () => Effect.succeed(false),
            prune: () => Effect.void,
            create: () => Effect.void,
            process: (input) =>
              Effect.gen(function* () {
                const summary = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "assistant" as const,
                  parentID: input.parentID,
                  parentMessageID: input.parentID,
                  sessionID: input.sessionID,
                  mode: "compaction",
                  agent: "compaction",
                  summary: true,
                  cost: 0,
                  path: { cwd: "/tmp", root: "/tmp" },
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ref.modelID,
                  providerID: ref.providerID,
                  time: { created: Date.now() },
                  finish: "stop" as const,
                })
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: summary.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: "COMPACTED SUMMARY",
                })
                return "continue" as const
              }),
          }),
        )

        yield* SubagentInherit.copy({
          parentSessionID: parent.id,
          childSessionID: child.id,
          boundaryMessageID: boundary.id,
          model: ref,
        }).pipe(Effect.provide(provider.layer), Effect.provide(compactionLayer))

        const text = (yield* MessageV2.filterCompactedEffect(child.id))
          .flatMap((message) => message.parts)
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
        expect(text).toContain("COMPACTED SUMMARY")
        expect(text).not.toContain("old bulk")
      }),
    ),
  )

  it.live("fresh mode keeps the child transcript isolated", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, currentAssistant } = yield* seedInheritableTranscript()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "fresh context",
            prompt: "start clean",
            subagent_type: "general",
            spawnMode: "fresh",
          },
          {
            sessionID: chat.id,
            messageID: currentAssistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(yield* MessageV2.filterCompactedEffect(result.metadata.sessionId)).toEqual([])
      }),
    ),
  )
})

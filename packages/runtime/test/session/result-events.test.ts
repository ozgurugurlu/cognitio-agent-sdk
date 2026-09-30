import { afterEach, describe, expect, test } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Bus } from "../../src/bus"
import { Shell } from "../../src/shell/shell"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID as SessionIDSchema, type SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { tmpdir } from "../fixture/fixture"

const providerID = ProviderID.make("test")
const modelID = ModelID.make("test")
const altProviderID = ProviderID.make("alt")
const altModelID = ModelID.make("alt-model")

async function seed(sessionID: SessionID, opts?: { finish?: string; error?: MessageV2.Assistant["error"] }) {
  const user = await AppRuntime.runPromise(
    Session.Service.use((session) =>
      session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID, modelID },
        time: { created: Date.now() },
      } satisfies MessageV2.User),
    ),
  )
  await AppRuntime.runPromise(
    Session.Service.use((session) =>
      session.updatePart({
        id: PartID.ascending(),
        messageID: user.id,
        sessionID,
        type: "text",
        text: "hello",
      }),
    ),
  )
  const assistant = await AppRuntime.runPromise(
    Session.Service.use((session) =>
      session.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        parentMessageID: user.id,
        sessionID,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/", root: "/" },
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID,
        providerID,
        time: { created: Date.now() },
        ...(opts?.finish ? { finish: opts.finish } : {}),
        ...(opts?.error ? { error: opts.error } : {}),
      } satisfies MessageV2.Assistant),
    ),
  )
  await AppRuntime.runPromise(
    Session.Service.use((session) =>
      session.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID,
        type: "text",
        text: "world",
      }),
    ),
  )
  return { user, assistant }
}

async function addAssistant(input: {
  sessionID: SessionID
  parentID: MessageID
  parentMessageID: MessageID
  text: string
  finish?: string
  cost?: number
  tokens?: MessageV2.Assistant["tokens"]
  providerID?: ProviderID
  modelID?: ModelID
}) {
  const assistant = await AppRuntime.runPromise(
    Session.Service.use((session) =>
      session.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        parentMessageID: input.parentMessageID,
        sessionID: input.sessionID,
        mode: "build",
        agent: "build",
        cost: input.cost ?? 0,
        path: { cwd: "/", root: "/" },
        tokens:
          input.tokens ?? {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        modelID: input.modelID ?? modelID,
        providerID: input.providerID ?? providerID,
        time: { created: Date.now() },
        ...(input.finish ? { finish: input.finish } : {}),
      } satisfies MessageV2.Assistant),
    ),
  )
  await AppRuntime.runPromise(
    Session.Service.use((session) =>
      session.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "text",
        text: input.text,
      }),
    ),
  )
  return assistant
}

async function addCompactionUser(input: { sessionID: SessionID; parentMessageID: MessageID }) {
  const user = await AppRuntime.runPromise(
    Session.Service.use((session) =>
      session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        agent: "build",
        model: { providerID, modelID },
        parentMessageID: input.parentMessageID,
        time: { created: Date.now() },
      } satisfies MessageV2.User),
    ),
  )
  await AppRuntime.runPromise(
    Session.Service.use((session) =>
      session.updatePart({
        id: PartID.ascending(),
        messageID: user.id,
        sessionID: input.sessionID,
        type: "compaction",
        auto: true,
      } satisfies MessageV2.CompactionPart),
    ),
  )
  return user
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("session result events", () => {
  test("result event schema accepts structured output retry exhaustion subtype", () => {
    expect(
      Session.Event.Result.properties.safeParse({
        sessionID: SessionIDSchema.descending(),
        subtype: "error_max_structured_output_retries",
        numTurns: 3,
        error: { name: "StructuredOutputError", message: "Model did not produce structured output" },
      }).success,
    ).toBe(true)
    expect(
      Session.Event.Result.properties.safeParse({
        sessionID: SessionIDSchema.descending(),
        subtype: "error_not_real",
      }).success,
    ).toBe(false)
  })

  test("loop publishes session.result before session.idle on success", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        const events: string[] = []
        let result: { subtype: string; parentMessageID?: string } | undefined
        const off = Bus.subscribeAll((event) => {
          if (event.type === Session.Event.Result.type) {
            events.push(event.type)
            result = event.properties as typeof result
          }
          if (event.type === SessionStatus.Event.Idle.type) events.push(event.type)
        })

        try {
          await Bun.sleep(10)
          const seeded = await seed(session.id, { finish: "stop" })
          const response = await AppRuntime.runPromise(
            SessionPrompt.Service.use((prompt) => prompt.loop({ sessionID: session.id })),
          )
          expect(response.info.role).toBe("assistant")
          await Bun.sleep(50)
          expect(events).toEqual([Session.Event.Result.type, SessionStatus.Event.Idle.type])
          expect(result?.subtype).toBe("success")
          expect(result?.parentMessageID).toBe(seeded.user.id)
        } finally {
          off()
        }
      },
    })
  })

  test("loop publishes session.result error_during_execution before session.idle", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        const events: string[] = []
        let result: { subtype: string } | undefined
        const off = Bus.subscribeAll((event) => {
          if (event.type === Session.Event.Result.type) {
            events.push(event.type)
            result = event.properties as typeof result
          }
          if (event.type === SessionStatus.Event.Idle.type) events.push(event.type)
        })

        try {
          await Bun.sleep(10)
          await seed(session.id, {
            finish: "stop",
            error: new MessageV2.APIError({ message: "boom", isRetryable: false }).toObject() as MessageV2.APIError,
          })
          const response = await AppRuntime.runPromise(
            SessionPrompt.Service.use((prompt) => prompt.loop({ sessionID: session.id })),
          )
          expect(response.info.role).toBe("assistant")
          if (response.info.role === "assistant") expect(response.info.error).toBeDefined()
          await Bun.sleep(50)
          expect(events).toEqual([Session.Event.Result.type, SessionStatus.Event.Idle.type])
          expect(result?.subtype).toBe("error_during_execution")
        } finally {
          off()
        }
      },
    })
  })

  test("loop failure before any new assistant does not inherit the previous run result", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        const previous = await seed(session.id, { finish: "stop" })
        const currentUser = await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: {
                providerID: ProviderID.make("missing-provider"),
                modelID: ModelID.make("missing-model"),
              },
              parentMessageID: previous.assistant.id,
              time: { created: Date.now() },
            } satisfies MessageV2.User),
          ),
        )
        await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updatePart({
              id: PartID.ascending(),
              messageID: currentUser.id,
              sessionID: session.id,
              type: "text",
              text: "broken model",
            }),
          ),
        )

        const events: string[] = []
        let result:
          | {
              subtype: string
              parentMessageID?: string
              messageID?: string
              stopReason?: string
              totalCostUsd?: number
              numTurns?: number
              error?: { name: string; message: string }
            }
          | undefined
        const off = Bus.subscribeAll((event) => {
          if (event.type === Session.Event.Result.type) {
            events.push(event.type)
            result = event.properties as typeof result
          }
          if (event.type === SessionStatus.Event.Idle.type) events.push(event.type)
        })

        try {
          const exit = await AppRuntime.runPromiseExit(
            SessionPrompt.Service.use((prompt) =>
              prompt.loop({
                sessionID: session.id,
                parentMessageID: currentUser.id,
              }),
            ),
          )
          expect(exit._tag).toBe("Failure")
          await Bun.sleep(50)
          expect(events).toEqual([Session.Event.Result.type, SessionStatus.Event.Idle.type])
          expect(result).toMatchObject({
            subtype: "error_during_execution",
            parentMessageID: currentUser.id,
            messageID: undefined,
            stopReason: undefined,
            totalCostUsd: 0,
            numTurns: 0,
          })
          expect(result?.error?.name).toBe("ProviderModelNotFoundError")
        } finally {
          off()
        }
      },
    })
  })

  test("late result publish stops at the next external user boundary", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        const previous = await seed(session.id, { finish: "stop" })
        const nextUser = await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: { providerID, modelID },
              parentMessageID: previous.assistant.id,
              time: { created: Date.now() },
            } satisfies MessageV2.User),
          ),
        )
        await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updatePart({
              id: PartID.ascending(),
              messageID: nextUser.id,
              sessionID: session.id,
              type: "text",
              text: "replacement",
            }),
          ),
        )
        const nextAssistant = await addAssistant({
          sessionID: session.id,
          parentID: nextUser.id,
          parentMessageID: nextUser.id,
          text: "replacement result",
          finish: "stop",
          cost: 9,
          tokens: {
            input: 90,
            output: 9,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        })

        let result: { messageID?: string; numTurns?: number; totalCostUsd?: number } | undefined
        const off = Bus.subscribeAll((event) => {
          if (event.type === Session.Event.Result.type) {
            result = event.properties as typeof result
          }
        })

        try {
          const response = await AppRuntime.runPromise(
            SessionPrompt.Service.use((prompt) =>
              prompt.loop({
                sessionID: session.id,
                parentMessageID: previous.user.id,
              }),
            ),
          )
          expect(response.info.id).toBe(nextAssistant.id)
          await Bun.sleep(50)
          expect(result?.messageID).toBe(previous.assistant.id)
          expect(result?.messageID).not.toBe(nextAssistant.id)
          expect(result?.numTurns).toBe(1)
          expect(result?.totalCostUsd).toBe(0)
        } finally {
          off()
        }
      },
    })
  })

  test("loop result aggregation includes assistants after internal compaction user", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        const seeded = await seed(session.id)
        const compactionUser = await addCompactionUser({
          sessionID: session.id,
          parentMessageID: seeded.assistant.id,
        })
        const final = await addAssistant({
          sessionID: session.id,
          parentID: compactionUser.id,
          parentMessageID: compactionUser.id,
          text: "after compaction",
          finish: "stop",
          cost: 4,
          tokens: {
            input: 4,
            output: 5,
            reasoning: 1,
            cache: { read: 2, write: 3 },
          },
        })

        let result:
          | {
              messageID?: string
              numTurns?: number
              totalCostUsd?: number
              usage?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
              modelUsage?: Record<
                string,
                {
                  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
                  cost: number
                }
              >
            }
          | undefined
        const off = Bus.subscribeAll((event) => {
          if (event.type === Session.Event.Result.type) {
            result = event.properties as typeof result
          }
        })

        try {
          const response = await AppRuntime.runPromise(
            SessionPrompt.Service.use((prompt) =>
              prompt.loop({
                sessionID: session.id,
                parentMessageID: seeded.user.id,
              }),
            ),
          )
          expect(response.info.id).toBe(final.id)
          await Bun.sleep(50)
          expect(result?.messageID).toBe(final.id)
          expect(result?.numTurns).toBe(2)
          expect(result?.totalCostUsd).toBe(4)
          expect(result?.usage).toMatchObject({
            input: 4,
            output: 5,
            reasoning: 1,
            cache: { read: 2, write: 3 },
          })
          expect(result?.modelUsage?.[`${providerID}/${modelID}`]).toMatchObject({
            cost: 4,
            tokens: {
              input: 4,
              output: 5,
              reasoning: 1,
              cache: { read: 2, write: 3 },
            },
          })
        } finally {
          off()
        }
      },
    })
  })

  test("loop accumulates multi-assistant cost and usage in session.result", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        let result:
          | {
              subtype: string
              numTurns?: number
              totalCostUsd?: number
              usage?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
              modelUsage?: Record<
                string,
                {
                  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
                  cost: number
                }
              >
            }
          | undefined
        const off = Bus.subscribeAll((event) => {
          if (event.type === Session.Event.Result.type) {
            result = event.properties as typeof result
          }
        })

        try {
          await Bun.sleep(10)
          const seeded = await seed(session.id)
          await addAssistant({
            sessionID: session.id,
            parentID: seeded.user.id,
            parentMessageID: seeded.user.id,
            text: "first",
            cost: 1.25,
            providerID: altProviderID,
            modelID: altModelID,
            tokens: {
              input: 10,
              output: 20,
              reasoning: 2,
              cache: { read: 3, write: 4 },
            },
          })
          const final = await addAssistant({
            sessionID: session.id,
            parentID: seeded.user.id,
            parentMessageID: seeded.user.id,
            text: "second",
            finish: "stop",
            cost: 2.5,
            tokens: {
              input: 30,
              output: 40,
              reasoning: 5,
              cache: { read: 6, write: 7 },
            },
          })

          const response = await AppRuntime.runPromise(
            SessionPrompt.Service.use((prompt) => prompt.loop({ sessionID: session.id })),
          )
          expect(response.info.id).toBe(final.id)
          await Bun.sleep(50)
          expect(result?.subtype).toBe("success")
          expect(result?.numTurns).toBe(3)
          expect(result?.totalCostUsd).toBe(3.75)
          expect(result?.usage).toMatchObject({
            input: 40,
            output: 60,
            reasoning: 7,
            cache: { read: 9, write: 11 },
          })
          expect(result?.modelUsage?.[`${altProviderID}/${altModelID}`]).toMatchObject({
            cost: 1.25,
            tokens: {
              input: 10,
              output: 20,
              reasoning: 2,
              cache: { read: 3, write: 4 },
            },
          })
          expect(result?.modelUsage?.[`${providerID}/${modelID}`]).toMatchObject({
            cost: 2.5,
            tokens: {
              input: 30,
              output: 40,
              reasoning: 5,
              cache: { read: 6, write: 7 },
            },
          })
        } finally {
          off()
        }
      },
    })
  })

  test("noReply persists the user message without emitting session.result or session.idle", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        const events: string[] = []
        const off = Bus.subscribeAll((event) => {
          if (event.type === Session.Event.Result.type || event.type === SessionStatus.Event.Idle.type) {
            events.push(event.type)
          }
        })

        try {
          await Bun.sleep(10)
          const response = await AppRuntime.runPromise(
            SessionPrompt.Service.use((prompt) =>
              prompt.prompt({
                sessionID: session.id,
                agent: "build",
                noReply: true,
                parts: [{ type: "text", text: "hello" }],
              }),
            ),
          )
          expect(response.info.role).toBe("user")
          await Bun.sleep(50)
          expect(events).toEqual([])

          const messages = await AppRuntime.runPromise(Session.Service.use((svc) => svc.messages({ sessionID: session.id })))
          expect(messages).toHaveLength(1)
          expect(messages[0]?.info.role).toBe("user")
          expect(messages[0]?.parts).toHaveLength(1)
        } finally {
          off()
        }
      },
    })
  })

  test("cancelled shell publishes session.result error_aborted before session.idle", async () => {
    const prev = process.env.SHELL
    process.env.SHELL = "/bin/sh"
    Shell.preferred.reset()

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
          const events: string[] = []
          let result: { subtype: string } | undefined
          const off = Bus.subscribeAll((event) => {
            if (event.type === Session.Event.Result.type) {
              events.push(event.type)
              result = event.properties as typeof result
            }
            if (event.type === SessionStatus.Event.Idle.type) events.push(event.type)
          })

          try {
            await Bun.sleep(10)
            await seed(session.id, { finish: "stop" })
            const shell = AppRuntime.runPromise(
              SessionPrompt.Service.use((prompt) =>
                prompt.shell({ sessionID: session.id, agent: "build", command: "sleep 30" }),
              ),
            )
            await Bun.sleep(50)
            await AppRuntime.runPromise(SessionPrompt.Service.use((prompt) => prompt.cancel(session.id)))
            const exit = await shell
            expect(exit.info.role).toBe("assistant")
            await Bun.sleep(50)
            expect(events).toEqual([Session.Event.Result.type, SessionStatus.Event.Idle.type])
            expect(result?.subtype).toBe("error_aborted")
          } finally {
            off()
          }
        },
      })
    } finally {
      if (prev === undefined) delete process.env.SHELL
      else process.env.SHELL = prev
      Shell.preferred.reset()
    }
  }, 30_000)

  test("shell setup failure result does not inherit a previous assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        const previous = await seed(session.id, { finish: "stop" })
        const events: string[] = []
        let result:
          | {
              subtype: string
              parentMessageID?: string
              messageID?: string
              stopReason?: string
              totalCostUsd?: number
              numTurns?: number
              usage?: unknown
              modelUsage?: unknown
              error?: { message: string }
            }
          | undefined
        const off = Bus.subscribeAll((event) => {
          if (event.type === Session.Event.Result.type) {
            events.push(event.type)
            result = event.properties as typeof result
          }
          if (event.type === SessionStatus.Event.Idle.type) events.push(event.type)
        })

        try {
          const exit = await AppRuntime.runPromiseExit(
            SessionPrompt.Service.use((prompt) =>
              prompt.shell({
                sessionID: session.id,
                agent: "missing-agent",
                command: "echo hi",
              }),
            ),
          )
          expect(exit._tag).toBe("Failure")
          await Bun.sleep(50)
          expect(events).toEqual([Session.Event.Result.type, SessionStatus.Event.Idle.type])
          expect(result).toMatchObject({
            subtype: "error_during_execution",
            parentMessageID: previous.assistant.id,
            messageID: undefined,
            stopReason: undefined,
            totalCostUsd: 0,
            numTurns: 0,
            usage: undefined,
            modelUsage: undefined,
          })
          expect(result?.error).toBeDefined()
        } finally {
          off()
        }
      },
    })
  })
})

describe("session.result subagent aggregation (phase 10 regressions)", () => {
  async function addUser(sessionID: SessionID, text = "child prompt") {
    const user = await AppRuntime.runPromise(
      Session.Service.use((session) =>
        session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID,
          agent: "build",
          model: { providerID, modelID },
          time: { created: Date.now() },
        } satisfies MessageV2.User),
      ),
    )
    await AppRuntime.runPromise(
      Session.Service.use((session) =>
        session.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID,
          type: "text",
          text,
        }),
      ),
    )
    return user
  }

  async function attachTaskPart(input: { sessionID: SessionID; messageID: MessageID; childSessionID: SessionID; childMessageID: MessageID }) {
    await AppRuntime.runPromise(
      Session.Service.use((session) =>
        session.updatePart({
          id: PartID.ascending(),
          messageID: input.messageID,
          sessionID: input.sessionID,
          type: "tool",
          tool: "task",
          callID: "call_subagent",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "subagent",
            metadata: { sessionId: input.childSessionID, messageId: input.childMessageID },
            time: { start: Date.now(), end: Date.now() },
          },
        } satisfies MessageV2.ToolPart),
      ),
    )
  }

  function captureResult() {
    let result:
      | {
          subtype: string
          numTurns?: number
          totalCostUsd?: number
          modelUsage?: Record<
            string,
            {
              tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
              cost: number
            }
          >
        }
      | undefined
    const off = Bus.subscribeAll((event) => {
      if (event.type === Session.Event.Result.type) {
        result = event.properties as typeof result
      }
    })
    return { off, get: () => result }
  }

  test("subagent with a different model produces a two-model breakdown", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        const child = await AppRuntime.runPromise(
          Session.Service.use((svc) => svc.create({ parentID: session.id })),
        )
        const captured = captureResult()

        try {
          await Bun.sleep(10)
          const seeded = await seed(session.id)
          const final = await addAssistant({
            sessionID: session.id,
            parentID: seeded.user.id,
            parentMessageID: seeded.user.id,
            text: "parent answer",
            finish: "stop",
            cost: 2.5,
            tokens: { input: 30, output: 40, reasoning: 5, cache: { read: 6, write: 7 } },
          })

          const childUser = await addUser(child.id)
          await addAssistant({
            sessionID: child.id,
            parentID: childUser.id,
            parentMessageID: childUser.id,
            text: "child answer",
            finish: "stop",
            cost: 1.25,
            providerID: altProviderID,
            modelID: altModelID,
            tokens: { input: 10, output: 20, reasoning: 2, cache: { read: 3, write: 4 } },
          })
          // Attach the child link to the non-final assistant: a tool part on
          // the last assistant would make the loop re-enter (hasToolCalls)
          // and call the model. aggregateResult scans every message's parts.
          await attachTaskPart({
            sessionID: session.id,
            messageID: seeded.assistant.id,
            childSessionID: child.id,
            childMessageID: childUser.id,
          })

          await AppRuntime.runPromise(SessionPrompt.Service.use((prompt) => prompt.loop({ sessionID: session.id })))
          await Bun.sleep(50)

          const result = captured.get()
          expect(result?.subtype).toBe("success")
          expect(result?.totalCostUsd).toBe(3.75)
          expect(result?.numTurns).toBe(3)
          expect(Object.keys(result?.modelUsage ?? {}).sort()).toEqual([
            `${altProviderID}/${altModelID}`,
            `${providerID}/${modelID}`,
          ])
          expect(result?.modelUsage?.[`${altProviderID}/${altModelID}`]).toMatchObject({
            cost: 1.25,
            tokens: { input: 10, output: 20, reasoning: 2, cache: { read: 3, write: 4 } },
          })
          expect(result?.modelUsage?.[`${providerID}/${modelID}`]).toMatchObject({ cost: 2.5 })
        } finally {
          captured.off()
        }
      },
    })
  })

  test("inherited messages before the child boundary are not re-billed", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        const child = await AppRuntime.runPromise(
          Session.Service.use((svc) => svc.create({ parentID: session.id })),
        )
        const captured = captureResult()

        try {
          await Bun.sleep(10)
          const seeded = await seed(session.id)
          const final = await addAssistant({
            sessionID: session.id,
            parentID: seeded.user.id,
            parentMessageID: seeded.user.id,
            text: "parent answer",
            finish: "stop",
            cost: 2.5,
            tokens: { input: 30, output: 40, reasoning: 5, cache: { read: 6, write: 7 } },
          })

          // Inherited history lives BEFORE the child's boundary message and
          // must stay unbilled in the parent's aggregate.
          const inheritedUser = await addUser(child.id, "inherited prompt")
          await addAssistant({
            sessionID: child.id,
            parentID: inheritedUser.id,
            parentMessageID: inheritedUser.id,
            text: "inherited answer",
            finish: "stop",
            cost: 99,
            tokens: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          const childUser = await addUser(child.id)
          await addAssistant({
            sessionID: child.id,
            parentID: childUser.id,
            parentMessageID: childUser.id,
            text: "child answer",
            finish: "stop",
            cost: 1.25,
            providerID: altProviderID,
            modelID: altModelID,
            tokens: { input: 10, output: 20, reasoning: 2, cache: { read: 3, write: 4 } },
          })
          // Attach the child link to the non-final assistant: a tool part on
          // the last assistant would make the loop re-enter (hasToolCalls)
          // and call the model. aggregateResult scans every message's parts.
          await attachTaskPart({
            sessionID: session.id,
            messageID: seeded.assistant.id,
            childSessionID: child.id,
            childMessageID: childUser.id,
          })

          await AppRuntime.runPromise(SessionPrompt.Service.use((prompt) => prompt.loop({ sessionID: session.id })))
          await Bun.sleep(50)

          const result = captured.get()
          expect(result?.subtype).toBe("success")
          expect(result?.totalCostUsd).toBe(3.75)
          expect(result?.modelUsage?.[`${providerID}/${modelID}`]).toMatchObject({ cost: 2.5 })
        } finally {
          captured.off()
        }
      },
    })
  })
})

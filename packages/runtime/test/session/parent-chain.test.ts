import { describe, expect, test } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionRuntimeConfig } from "../../src/session/runtime-config"
import { tmpdir } from "../fixture/fixture"

const providerID = ProviderID.make("test")
const modelID = ModelID.make("test")

describe("parent message chain", () => {
  test("fork remaps parentMessageID references and session removal clears runtime config", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        const user1 = await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model: { providerID, modelID },
            } satisfies MessageV2.User),
          ),
        )
        await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updatePart({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: user1.id,
              type: "text",
              text: "first",
            }),
          ),
        )
        const assistant1 = await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "assistant",
              time: { created: Date.now() },
              parentID: user1.id,
              parentMessageID: user1.id,
              modelID,
              providerID,
              mode: "build",
              agent: "build",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            } satisfies MessageV2.Assistant),
          ),
        )
        const user2 = await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              parentMessageID: assistant1.id,
              agent: "build",
              model: { providerID, modelID },
            } satisfies MessageV2.User),
          ),
        )
        const assistant2 = await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "assistant",
              time: { created: Date.now() },
              parentID: user2.id,
              parentMessageID: user2.id,
              modelID,
              providerID,
              mode: "build",
              agent: "build",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            } satisfies MessageV2.Assistant),
          ),
        )

        await AppRuntime.runPromise(
          SessionRuntimeConfig.Service.use((svc) =>
            svc.set({
              sessionID: session.id,
              config: { maxTurns: 4 },
            }),
          ),
        )

        const forked = await AppRuntime.runPromise(
          Session.Service.use((svc) => svc.fork({ sessionID: session.id })),
        )
        const messages = await AppRuntime.runPromise(
          Session.Service.use((svc) => svc.messages({ sessionID: forked.id })),
        )

        expect(messages).toHaveLength(4)
        expect(messages[1]?.info.role).toBe("assistant")
        expect(messages[1]?.info.parentMessageID).toBe(messages[0]?.info.id)
        expect(messages[2]?.info.role).toBe("user")
        expect(messages[2]?.info.parentMessageID).toBe(messages[1]?.info.id)
        expect(messages[3]?.info.role).toBe("assistant")
        expect(messages[3]?.info.parentMessageID).toBe(messages[2]?.info.id)
        if (messages[3]?.info.role === "assistant") {
          expect(messages[3].info.parentID).toBe(messages[2]?.info.id)
        }

        await AppRuntime.runPromise(Session.Service.use((svc) => svc.remove(session.id)))
        expect(
          await AppRuntime.runPromise(SessionRuntimeConfig.Service.use((svc) => svc.get(session.id))),
        ).toEqual({})
      },
    })
  })

  test("fork strips orphan parent links instead of leaking source ids", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        const user = await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model: { providerID, modelID },
            } satisfies MessageV2.User),
          ),
        )
        const orphanUser = await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              parentMessageID: MessageID.make("msg_missing_parent"),
              agent: "build",
              model: { providerID, modelID },
            } satisfies MessageV2.User),
          ),
        )
        await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "assistant",
              time: { created: Date.now() },
              parentID: MessageID.make("msg_missing_parent"),
              parentMessageID: orphanUser.id,
              modelID,
              providerID,
              mode: "build",
              agent: "build",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            } satisfies MessageV2.Assistant),
          ),
        )

        const forked = await AppRuntime.runPromise(
          Session.Service.use((svc) => svc.fork({ sessionID: session.id })),
        )
        const messages = await AppRuntime.runPromise(
          Session.Service.use((svc) => svc.messages({ sessionID: forked.id })),
        )

        expect(messages).toHaveLength(2)
        expect(messages[0]?.info.id).not.toBe(user.id)
        expect(messages[1]?.info.role).toBe("user")
        if (messages[1]?.info.role === "user") {
          expect(messages[1].info.parentMessageID).toBeUndefined()
        }
      },
    })
  })
})

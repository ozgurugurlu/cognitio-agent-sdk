import { afterEach, describe, expect, test } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRevert } from "../../src/session/revert"
import { MessageID, PartID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const providerID = ProviderID.make("test")
const modelID = ModelID.make("test")

afterEach(async () => {
  await Instance.disposeAll()
})

describe("session revert checkpoint alias", () => {
  test("revert exposes checkpointId as an alias of snapshot", async () => {
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
        await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.updatePart({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: user.id,
              type: "text",
              text: "hello",
            }),
          ),
        )

        const reverted = await AppRuntime.runPromise(
          SessionRevert.Service.use((revert) =>
            revert.revert({
              sessionID: session.id,
              messageID: user.id,
            }),
          ),
        )

        expect(reverted.revert?.snapshot).toBeDefined()
        expect(reverted.revert?.checkpointId).toBe(reverted.revert?.snapshot)
      },
    })
  })

  test("persisted revert rows without checkpointId are normalized from snapshot", async () => {
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

        await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.setRevert({
              sessionID: session.id,
              summary: { additions: 0, deletions: 0, files: 0 },
              revert: {
                messageID: user.id,
                snapshot: "legacy-snapshot",
              },
            }),
          ),
        )

        const stored = await AppRuntime.runPromise(Session.Service.use((svc) => svc.get(session.id)))
        expect(stored.revert?.snapshot).toBe("legacy-snapshot")
        expect(stored.revert?.checkpointId).toBe("legacy-snapshot")
      },
    })
  })
})

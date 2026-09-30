import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { HookBridge, type HookInput } from "../../src/session/hook-bridge"
import { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tui notification hooks", () => {
  test("show-toast fires Notification hook when a sessionID is provided", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const calls: HookInput[] = []
        const notify = spyOn(HookBridge, "notify").mockImplementation((input) =>
          Effect.sync(() => {
            calls.push(input)
          }),
        )
        try {
          const sessionID = SessionID.descending()
          const response = await Server.Default().app.request("/tui/show-toast", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionID,
              message: "Saved",
              variant: "success",
            }),
          })

          expect(response.status).toBe(200)
          expect(await response.json()).toBe(true)
          expect(calls).toMatchObject([
            {
              sessionID,
              event: "Notification",
              target: "notification",
              data: {
                sessionID,
                message: "Saved",
                variant: "success",
              },
            },
          ])
        } finally {
          notify.mockRestore()
        }
      },
    })
  })
})

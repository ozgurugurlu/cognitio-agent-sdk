import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { type SessionCheckpoint } from "../../src/session/checkpoint"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

function createSession(input?: Session.CreateInput) {
  return AppRuntime.runPromise(Session.Service.use((svc) => svc.create(input)))
}

describe("session checkpoint routes", () => {
  test("checkpoint and rewind use the session directory, not the request directory", async () => {
    await using sessionDir = await tmpdir({ git: true })
    await using requestDir = await tmpdir({ git: true })

    const session = await Instance.provide({
      directory: sessionDir.path,
      fn: () => createSession({ title: "route checkpoint" }),
    })
    const app = Server.Default().app
    const tracked = path.join(sessionDir.path, "tracked.txt")
    const unrelated = path.join(requestDir.path, "tracked.txt")

    await Bun.write(tracked, "before")
    await Bun.write(unrelated, "request-dir")

    const checkpointResponse = await app.request(
      `/session/${session.id}/checkpoint?directory=${encodeURIComponent(requestDir.path)}`,
      {
        method: "POST",
        body: JSON.stringify({ label: "before edit" }),
        headers: { "content-type": "application/json" },
      },
    )
    expect(checkpointResponse.status).toBe(200)
    const checkpoint = (await checkpointResponse.json()) as SessionCheckpoint.Info

    await Bun.write(tracked, "after")
    const rewindResponse = await app.request(`/session/${session.id}/rewind?directory=${encodeURIComponent(requestDir.path)}`, {
      method: "POST",
      body: JSON.stringify({ checkpointID: checkpoint.id }),
      headers: { "content-type": "application/json" },
    })
    expect(rewindResponse.status).toBe(200)
    expect(await Bun.file(tracked).text()).toBe("before")
    expect(await Bun.file(unrelated).text()).toBe("request-dir")

    const listResponse = await app.request(
      `/session/${session.id}/checkpoints?directory=${encodeURIComponent(requestDir.path)}`,
    )
    expect(listResponse.status).toBe(200)
    expect(((await listResponse.json()) as SessionCheckpoint.Info[]).map((item) => item.id)).toEqual([checkpoint.id])
  })
})

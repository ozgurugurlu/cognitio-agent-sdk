import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createAgentClient } from "../src/index.js"
import { startMockServer, waitFor, type MockCognitioServer } from "./mock-server.js"

function sessionPayload(id: string, directory: string, parentID?: string) {
  return {
    id,
    slug: id,
    projectID: "proj-mock",
    directory,
    parentID,
    title: "mock",
    tags: [],
    version: "0.0.0-mock",
    time: { created: 0, updated: 0 },
  }
}

describe("AgentClient lifecycle races", () => {
  let mock: MockCognitioServer

  beforeEach(async () => {
    mock = await startMockServer()
  })

  afterEach(async () => {
    if (!mock) return
    await mock.stop()
    mock = undefined as never
  })

  test("close waits for an in-flight session create and reclaims the resulting handle", async () => {
    const gate = Promise.withResolvers<void>()
    mock.setCreateHandler(async (request) => {
      await gate.promise
      const id = "sess-delayed-create"
      const directory = request.directory ?? "/mock/delayed"
      mock.sessions.set(id, {
        id,
        directory,
        title: typeof request.body.title === "string" ? request.body.title : "mock",
        tags: [],
      })
      if (request.body.runtimeConfig && typeof request.body.runtimeConfig === "object") {
        mock.runtimeConfigs.set(id, request.body.runtimeConfig as Record<string, unknown>)
      }
      return Response.json(sessionPayload(id, directory))
    })

    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    const creating = client.sessions.create({ title: "delayed" })
    await waitFor(() => mock.capturedSessionCreates[0])

    const closing = client.close()
    expect(client.close()).toBe(closing)
    gate.resolve()

    const session = await creating
    await closing
    await expect(session.send("too late")).rejects.toThrow(/is closed/)
    await expect(client.sessions.create()).rejects.toThrow(/client is closed/)
    await waitFor(() => (mock.sseConnections() === 0 ? true : undefined))
  })

  test("failed configured-fork rollback forgets the fork route and never deletes the source", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const source = await client.sessions.create({ cwd: "/mock/source" })
      mock.setForkHandler((request) => {
        const id = "sess-reused-fork"
        const directory = request.directory ?? source.directory
        mock.sessions.set(id, {
          id,
          directory,
          title: "fork",
          tags: [],
          parentID: request.sessionID,
        })
        return Response.json(sessionPayload(id, directory, request.sessionID))
      })
      mock.setRuntimeConfigPatchHandler(() => Response.json({ message: "patch failed" }, { status: 500 }))

      await expect(
        client.sessions.fork(source.id, {
          runtimeConfig: { systemPrompt: "neutral fork" },
        }),
      ).rejects.toThrow(/Failed to apply runtime config/)
      expect(mock.capturedSessionDeletes.map((request) => request.sessionID)).toEqual(["sess-reused-fork"])
      expect(mock.sessions.has(source.id)).toBe(true)

      mock.sessions.set("sess-reused-fork", {
        id: "sess-reused-fork",
        directory: "/mock/reused",
        title: "reused",
        tags: [],
      })
      const reused = await client.sessions.get("sess-reused-fork")
      expect(reused.directory).toBe("/mock/reused")
    } finally {
      await client.close()
    }
  })

  test("delete waits for pending resume and prevents a stale handle from being attached", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    const gate = Promise.withResolvers<void>()
    try {
      const source = await client.sessions.create()
      await source.close()
      mock.setRuntimeConfigPatchHandler(async (request) => {
        await gate.promise
        mock.runtimeConfigs.set(request.sessionID, request.body)
        return Response.json(request.body)
      })
      const attaching = client.sessions.resume(source.id, { runtimeConfig: { maxTurns: 3 } })
      await waitFor(() => mock.capturedRuntimeConfigPatches[0])
      const deleting = client.sessions.delete(source.id)
      await expect(client.sessions.get(source.id)).rejects.toMatchObject({ kind: "session_conflict" })
      const deletingAgain = client.sessions.delete(source.id)
      expect(mock.capturedSessionDeletes).toHaveLength(0)
      gate.resolve()
      const attached = await attaching
      await Promise.all([deleting, deletingAgain])
      await expect(attached.send("too late")).rejects.toMatchObject({ kind: "closed" })
      expect(mock.capturedSessionDeletes).toHaveLength(1)
      expect(mock.sessions.has(source.id)).toBe(false)
      await expect(client.sessions.get(source.id)).rejects.toThrow()
    } finally {
      gate.resolve()
      await client.close()
    }
  })
})

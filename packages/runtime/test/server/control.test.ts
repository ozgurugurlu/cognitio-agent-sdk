import { afterEach, describe, expect, test } from "bun:test"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { ControlRequestRegistry } from "../../src/session/control-registry"
import { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("control channel routes", () => {
  test("validates missing sessions, invalid bodies, and unknown responses", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const session = await createSession()
        const unknownRequestID = crypto.randomUUID()
        const headers = { "x-cognitio-directory": tmp.path }

        expect((await app.request("/session/not-a-session/control-requests", { headers })).status).toBe(400)
        expect(
          (
            await app.request(`/session/${session.id}/control-response`, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({
                requestID: "not-a-uuid",
                subtype: "hook_callback",
                response: {},
              }),
            })
          ).status,
        ).toBe(400)

        const missingSession = SessionID.descending()
        expect(
          (
            await app.request(`/session/${missingSession}/control-response`, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({
                requestID: unknownRequestID,
                subtype: "hook_callback",
                response: {},
              }),
            })
          ).status,
        ).toBe(404)
        expect(
          (
            await app.request(`/session/${missingSession}/control-cancel`, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({
                requestID: unknownRequestID,
                subtype: "hook_callback",
              }),
            })
          ).status,
        ).toBe(404)
        expect(
          (
            await app.request(`/session/${missingSession}/control-requests`, {
              headers,
            })
          ).status,
        ).toBe(404)
        expect(
          (
            await app.request(`/session/${session.id}/control-cancel`, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({
                requestID: "not-a-uuid",
                subtype: "hook_callback",
              }),
            })
          ).status,
        ).toBe(400)

        const unknown = await app.request(`/session/${session.id}/control-response`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            requestID: unknownRequestID,
            subtype: "hook_callback",
            response: { ok: false },
          }),
        })
        expect(unknown.status).toBe(200)
        expect(await unknown.json()).toEqual({ resolved: false })
      },
    })
  })

  test("lists pending requests with payload and timeout", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sessionA = await createSession()
        const sessionB = await createSession()
        const requestA = await createPendingRequest({
          sessionID: sessionA.id,
          subtype: "hook_callback",
          payload: { hook: "a" },
          timeoutMs: 1_000,
        })
        const requestB = await createPendingRequest({
          sessionID: sessionB.id,
          subtype: "can_use_tool",
          payload: { tool: "bash" },
          timeoutMs: 2_000,
        })

        const listA = await app.request(`/session/${sessionA.id}/control-requests`, {
          headers: { "x-cognitio-directory": tmp.path },
        })
        expect(listA.status).toBe(200)
        expect(await listA.json()).toEqual([
          {
            id: requestA.request.id,
            sessionID: sessionA.id,
            subtype: "hook_callback",
            payload: {
              hook: "a",
              rootSessionID: sessionA.id,
              activeSessionID: sessionA.id,
            },
            createdAt: requestA.request.createdAt,
            timeoutMs: 1_000,
          },
        ])

        await resolveRequest(app, tmp.path, sessionA.id, requestA.request.id, "hook_callback", { ok: true })
        await resolveRequest(app, tmp.path, sessionB.id, requestB.request.id, "can_use_tool", { ok: true })
        await requestA.promise
        await requestB.promise
      },
    })
  })

  test("resolves, deduplicates, and guards wrong session or subtype", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sessionA = await createSession()
        const sessionB = await createSession()
        const pending = await createPendingRequest({
          sessionID: sessionA.id,
          subtype: "hook_callback",
          payload: { hook: "guard" },
          timeoutMs: 1_000,
        })

        expect(
          await resolveRequest(app, tmp.path, sessionB.id, pending.request.id, "hook_callback", {
            ok: "wrong-session",
          }),
        ).toEqual({ resolved: false })
        expect(
          await resolveRequest(app, tmp.path, sessionA.id, pending.request.id, "can_use_tool", {
            ok: "wrong-subtype",
          }),
        ).toEqual({ resolved: false })
        expect(await listRequests(sessionA.id)).toHaveLength(1)

        expect(
          await resolveRequest(app, tmp.path, sessionA.id, pending.request.id, "hook_callback", {
            ok: true,
          }),
        ).toEqual({ resolved: true })
        expect(
          await resolveRequest(app, tmp.path, sessionA.id, pending.request.id, "hook_callback", {
            ok: false,
          }),
        ).toEqual({ resolved: false })
        await expect(pending.promise).resolves.toEqual({ ok: true })
      },
    })
  })

  test("cancels pending requests and emits control.cancelled", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const session = await createSession()
        const otherSession = await createSession()
        const pending = await createPendingRequest({
          sessionID: session.id,
          subtype: "mcp_message",
          payload: { message: "ping" },
          timeoutMs: 1_000,
        })
        const cancelled = waitForCancelled(tmp.path, session.id, pending.request.id)

        expect(
          await cancelRequest(app, tmp.path, session.id, crypto.randomUUID(), "mcp_message"),
        ).toEqual({ cancelled: false })
        expect(
          await cancelRequest(app, tmp.path, session.id, pending.request.id, "hook_callback"),
        ).toEqual({ cancelled: false })
        expect(
          await cancelRequest(app, tmp.path, otherSession.id, pending.request.id, "mcp_message"),
        ).toEqual({ cancelled: false })
        expect(await listRequests(session.id)).toHaveLength(1)

        expect(await cancelRequest(app, tmp.path, session.id, pending.request.id, "mcp_message")).toEqual({
          cancelled: true,
        })
        expect(await cancelled).toMatchObject({
          id: pending.request.id,
          sessionID: session.id,
          reason: "cancelled",
        })
        await expect(pending.promise).rejects.toThrow(/cancelled/)
        expect(await cancelRequest(app, tmp.path, session.id, pending.request.id, "mcp_message")).toEqual({
          cancelled: false,
        })
      },
    })
  })

  test("returns false for late response and cancel after timeout", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const session = await createSession()
        const pending = await createPendingRequest({
          sessionID: session.id,
          subtype: "hook_callback",
          payload: { hook: "timeout" },
          timeoutMs: 10,
        })

        await expect(pending.promise).rejects.toThrow(/timed out/)
        expect(
          await resolveRequest(app, tmp.path, session.id, pending.request.id, "hook_callback", {
            ok: "late",
          }),
        ).toEqual({ resolved: false })
        expect(await cancelRequest(app, tmp.path, session.id, pending.request.id, "hook_callback")).toEqual({
          cancelled: false,
        })
      },
    })
  })
})

function createSession() {
  return AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
}

async function createPendingRequest(input: {
  sessionID: SessionID
  subtype: ControlRequestRegistry.ControlSubtype
  payload: ControlRequestRegistry.ControlPayload
  timeoutMs: number
}) {
  const promise = AppRuntime.runPromise(ControlRequestRegistry.Service.use((svc) => svc.create(input)))
  const request = await waitForRequest(input.sessionID)
  return { promise, request }
}

async function waitForRequest(sessionID: SessionID, attempts = 50): Promise<ControlRequestRegistry.Request> {
  const pending = await listRequests(sessionID)
  if (pending[0]) return pending[0]
  if (attempts === 0) throw new Error("timed out waiting for pending control request")
  await Bun.sleep(10)
  return waitForRequest(sessionID, attempts - 1)
}

function listRequests(sessionID: SessionID) {
  return AppRuntime.runPromise(ControlRequestRegistry.Service.use((svc) => svc.list(sessionID)))
}

async function resolveRequest(
  app: ReturnType<typeof Server.Default>["app"],
  directory: string,
  sessionID: SessionID,
  requestID: string,
  subtype: ControlRequestRegistry.ControlSubtype,
  response: ControlRequestRegistry.ControlPayload,
) {
  const result = await app.request(`/session/${sessionID}/control-response`, {
    method: "POST",
    headers: { "x-cognitio-directory": directory, "content-type": "application/json" },
    body: JSON.stringify({ requestID, subtype, response }),
  })
  return result.json()
}

async function cancelRequest(
  app: ReturnType<typeof Server.Default>["app"],
  directory: string,
  sessionID: SessionID,
  requestID: string,
  subtype: ControlRequestRegistry.ControlSubtype,
) {
  const result = await app.request(`/session/${sessionID}/control-cancel`, {
    method: "POST",
    headers: { "x-cognitio-directory": directory, "content-type": "application/json" },
    body: JSON.stringify({ requestID, subtype }),
  })
  return result.json()
}

function waitForCancelled(directory: string, sessionID: SessionID, requestID: string) {
  return new Promise<typeof ControlRequestRegistry.Event.Cancelled.properties._zod.output>((resolve) => {
    const onEvent = (event: GlobalEvent) => {
      if (event.directory !== directory) return
      if (event.payload.type !== ControlRequestRegistry.Event.Cancelled.type) return
      if (event.payload.properties.sessionID !== sessionID) return
      if (event.payload.properties.id !== requestID) return
      GlobalBus.off("event", onEvent)
      resolve(event.payload.properties)
    }
    GlobalBus.on("event", onEvent)
  })
}

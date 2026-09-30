import { expect, test } from "bun:test"
import { createCognitioClient, CognitioClient } from "../src/v2/client.js"
import type {
  ControlRequest,
  SessionControlChannelCancelData,
  SessionControlChannelCancelResponse,
  SessionControlChannelListResponse,
  SessionControlChannelResponseData,
  SessionControlChannelResponseResponse,
} from "../src/v2/client.js"

test("generated client exposes session control channel surface", () => {
  const controlChannel = new CognitioClient().session.controlChannel

  expect(controlChannel).toBeDefined()
  expect(typeof controlChannel.response).toBe("function")
  expect(typeof controlChannel.cancel).toBe("function")
  expect(typeof controlChannel.list).toBe("function")
})

test("generated control channel types accept request and response payloads", () => {
  const pending: ControlRequest = {
    id: crypto.randomUUID(),
    sessionID: "ses_test",
    subtype: "hook_callback",
    payload: { hook: "pre_tool" },
    createdAt: 1,
    timeoutMs: 30_000,
  }
  const responseRequest: SessionControlChannelResponseData = {
    url: "/session/{sessionID}/control-response",
    path: { sessionID: pending.sessionID },
    body: {
      requestID: pending.id,
      subtype: pending.subtype,
      response: { continue: true },
    },
  }
  const cancelRequest: SessionControlChannelCancelData = {
    url: "/session/{sessionID}/control-cancel",
    path: { sessionID: pending.sessionID },
    body: {
      requestID: pending.id,
      subtype: pending.subtype,
    },
  }
  const responseResult: SessionControlChannelResponseResponse = { resolved: true }
  const cancelResult: SessionControlChannelCancelResponse = { cancelled: false }
  const listResult: SessionControlChannelListResponse = [pending]

  if (false) {
    const controlChannel = new CognitioClient().session.controlChannel
    // @ts-expect-error controlResponseBody is required.
    controlChannel.response({ sessionID: pending.sessionID })
    controlChannel.response({
      sessionID: pending.sessionID,
      // @ts-expect-error requestID is required inside the generated body wrapper.
      controlResponseBody: { subtype: pending.subtype, response: {} },
    })
    // @ts-expect-error controlCancelBody is required.
    controlChannel.cancel({ sessionID: pending.sessionID })
    controlChannel.cancel({
      sessionID: pending.sessionID,
      // @ts-expect-error subtype is required inside the generated body wrapper.
      controlCancelBody: { requestID: pending.id },
    })
    // @ts-expect-error generated data bodies are required.
    const missingBody: SessionControlChannelResponseData = {
      url: "/session/{sessionID}/control-response",
      path: { sessionID: pending.sessionID },
    }
    expect(missingBody).toBeUndefined()
  }

  expect(responseRequest.body.requestID).toBe(pending.id)
  expect(cancelRequest.body.subtype).toBe("hook_callback")
  expect(responseResult.resolved).toBe(true)
  expect(cancelResult.cancelled).toBe(false)
  expect(listResult[0]?.payload).toEqual({ hook: "pre_tool" })
})

test("generated control channel methods send required body wrappers at runtime", async () => {
  const captured: Array<{ method: string; pathname: string; body?: unknown }> = []
  const requestID = crypto.randomUUID()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "GET" ? undefined : await req.json()
      captured.push({ method: req.method, pathname: url.pathname, body })
      if (url.pathname.endsWith("/control-response")) return Response.json({ resolved: true })
      if (url.pathname.endsWith("/control-cancel")) return Response.json({ cancelled: false })
      return Response.json([
        {
          id: requestID,
          sessionID: "ses_sdk",
          subtype: "hook_callback",
          payload: { hook: "pre_tool" },
          createdAt: 1,
          timeoutMs: 30_000,
        },
      ])
    },
  })

  try {
    const controlChannel = createCognitioClient({ baseUrl: `http://${server.hostname}:${server.port}` }).session
      .controlChannel
    const response = await controlChannel.response({
      sessionID: "ses_sdk",
      controlResponseBody: {
        requestID,
        subtype: "hook_callback",
        response: { continue: true },
      },
    })
    const cancel = await controlChannel.cancel({
      sessionID: "ses_sdk",
      controlCancelBody: {
        requestID,
        subtype: "hook_callback",
      },
    })
    const list = await controlChannel.list({ sessionID: "ses_sdk" })

    expect(response.data).toEqual({ resolved: true })
    expect(cancel.data).toEqual({ cancelled: false })
    expect(list.data?.[0]?.id).toBe(requestID)
    expect(captured.map((item) => item.pathname)).toEqual([
      "/session/ses_sdk/control-response",
      "/session/ses_sdk/control-cancel",
      "/session/ses_sdk/control-requests",
    ])
    expect(captured[0]?.body).toEqual({
      requestID,
      subtype: "hook_callback",
      response: { continue: true },
    })
    expect(captured[1]?.body).toEqual({ requestID, subtype: "hook_callback" })
  } finally {
    await server.stop(true)
  }
})

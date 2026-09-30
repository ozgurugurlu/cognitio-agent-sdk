import { expect, test } from "bun:test"
import { createCognitioClient, CognitioClient } from "../src/v2/client.js"
import type {
  Event,
  RuntimeConfig,
  SessionCheckpointData,
  SessionCheckpointsData,
  SessionListData,
  SessionMessagesData,
  SessionRewindData,
  SessionUpdateData,
} from "../src/v2/client.js"

test("generated client exposes Phase 7 session checkpoint surface", () => {
  const session = new CognitioClient().session

  expect(typeof session.checkpoint).toBe("function")
  expect(typeof session.checkpoints).toBe("function")
  expect(typeof session.rewind).toBe("function")
})

test("generated Phase 7 types require rewind body and accept tags, checkpointing, and events", () => {
  const list: SessionListData = {
    url: "/session",
    query: { tag: "phase7", roots: true, limit: 1 },
  }
  const update: SessionUpdateData = {
    url: "/session/{sessionID}",
    path: { sessionID: "ses_test" },
    body: { tags: ["phase7", "review"] },
  }
  const messages: SessionMessagesData = {
    url: "/session/{sessionID}/message",
    path: { sessionID: "ses_test" },
    query: { view: "active" },
  }
  const checkpoint: SessionCheckpointData = {
    url: "/session/{sessionID}/checkpoint",
    path: { sessionID: "ses_test" },
    body: { label: "before edit", messageID: "msg_test" },
  }
  const checkpoints: SessionCheckpointsData = {
    url: "/session/{sessionID}/checkpoints",
    path: { sessionID: "ses_test" },
  }
  const rewind: SessionRewindData = {
    url: "/session/{sessionID}/rewind",
    path: { sessionID: "ses_test" },
    body: { checkpointID: "chk_test" },
  }
  const runtime: RuntimeConfig = { enableFileCheckpointing: true }
  const checkpointEvent: Event = {
    type: "session.checkpoint.created",
    properties: {
      sessionID: "ses_test",
      checkpoint: {
        id: "chk_test",
        sessionID: "ses_test",
        source: "manual",
        time: { created: 1, updated: 1 },
      },
    },
  }
  const rewindEvent: Event = {
    type: "session.rewound",
    properties: {
      sessionID: "ses_test",
      checkpointID: "chk_test",
      affectedFiles: ["/tmp/a.txt"],
    },
  }
  const todoEvent: Event = {
    type: "todo.updated",
    properties: {
      sessionID: "ses_test",
      todos: [{ content: "ship phase7", status: "pending", priority: "high" }],
    },
  }

  if (false) {
    const client = new CognitioClient().session
    // @ts-expect-error rewind requires a body wrapper.
    client.rewind({ sessionID: "ses_test" })
    // @ts-expect-error checkpointID is required inside the generated rewind body.
    client.rewind({ sessionID: "ses_test", sessionRewindInput: {} })
    // @ts-expect-error generated rewind data body is required.
    const missingBody: SessionRewindData = {
      url: "/session/{sessionID}/rewind",
      path: { sessionID: "ses_test" },
    }
    expect(missingBody).toBeUndefined()
  }

  expect(list.query?.tag).toBe("phase7")
  expect(update.body?.tags).toEqual(["phase7", "review"])
  expect(messages.query?.view).toBe("active")
  expect(checkpoint.body?.label).toBe("before edit")
  expect(checkpoints.path.sessionID).toBe("ses_test")
  expect(rewind.body.checkpointID).toBe("chk_test")
  expect(runtime.enableFileCheckpointing).toBe(true)
  expect(checkpointEvent.properties.checkpoint.id).toBe("chk_test")
  expect(rewindEvent.properties.affectedFiles).toEqual(["/tmp/a.txt"])
  expect(todoEvent.properties.todos[0]?.content).toBe("ship phase7")
})

test("generated Phase 7 methods serialize checkpoint and rewind bodies", async () => {
  const captured: Array<{ pathname: string; body?: unknown }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      captured.push({
        pathname: url.pathname,
        body: req.method === "GET" ? undefined : await req.json(),
      })
      if (url.pathname.endsWith("/checkpoint")) {
        return Response.json({
          id: "chk_test",
          sessionID: "ses_test",
          label: "before",
          source: "manual",
          time: { created: 1, updated: 1 },
        })
      }
      if (url.pathname.endsWith("/checkpoints")) return Response.json([])
      return Response.json({ checkpointID: "chk_test", affectedFiles: ["/tmp/a.txt"] })
    },
  })

  try {
    const session = createCognitioClient({ baseUrl: `http://${server.hostname}:${server.port}` }).session
    const checkpoint = await session.checkpoint({
      sessionID: "ses_test",
      label: "before",
    })
    const checkpoints = await session.checkpoints({ sessionID: "ses_test" })
    const rewind = await session.rewind({
      sessionID: "ses_test",
      sessionRewindInput: { checkpointID: "chk_test" },
    })

    expect(checkpoint.data?.id).toBe("chk_test")
    expect(checkpoints.data).toEqual([])
    expect(rewind.data?.affectedFiles).toEqual(["/tmp/a.txt"])
    expect(captured).toEqual([
      { pathname: "/session/ses_test/checkpoint", body: { label: "before" } },
      { pathname: "/session/ses_test/checkpoints" },
      { pathname: "/session/ses_test/rewind", body: { checkpointID: "chk_test" } },
    ])
  } finally {
    await server.stop(true)
  }
})

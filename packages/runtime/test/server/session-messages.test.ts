import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
  messages(input: { sessionID: SessionID; limit?: number }) {
    return run(SessionNs.Service.use((svc) => svc.messages(input)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(part)))
  },
}

afterEach(async () => {
  await Instance.disposeAll()
})

async function withoutWatcher<T>(fn: () => Promise<T>) {
  if (process.platform !== "win32") return fn()
  const prev = process.env.COGNITIO_EXPERIMENTAL_DISABLE_FILEWATCHER
  process.env.COGNITIO_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.COGNITIO_EXPERIMENTAL_DISABLE_FILEWATCHER
    else process.env.COGNITIO_EXPERIMENTAL_DISABLE_FILEWATCHER = prev
  }
}

async function fill(sessionID: SessionID, count: number, time = (i: number) => Date.now() + i) {
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    await svc.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as MessageV2.Info)
    await svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: `m${i}`,
    })
  }
  return ids
}

async function addUser(sessionID: SessionID, text?: string) {
  const id = MessageID.ascending()
  await svc.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  if (text) {
    await svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text,
    })
  }
  return id
}

async function addAssistant(sessionID: SessionID, parentID: MessageID, opts?: { summary?: boolean; finish?: string }) {
  const id = MessageID.ascending()
  await svc.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: opts?.summary,
    finish: opts?.finish,
  } as unknown as MessageV2.Info)
  return id
}

async function addCompactionPart(sessionID: SessionID, messageID: MessageID, tailStartID?: MessageID) {
  await svc.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "compaction",
    auto: true,
    tail_start_id: tailStartID,
  } as unknown as MessageV2.Part)
}

describe("session messages endpoint", () => {
  test("todo route returns 404 for missing sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.Default().app
          const res = await app.request("/session/ses_missing/todo")

          expect(res.status).toBe(404)
        },
      }),
    )
  })

  test("prompt_async returns only after the user message entry is persisted", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const id = MessageID.ascending()
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/prompt_async`, {
            method: "POST",
            body: JSON.stringify({
              messageID: id,
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              noReply: true,
              parts: [{ type: "text", text: "accepted" }],
            }),
            headers: { "content-type": "application/json" },
          })
          expect(res.status).toBe(204)

          const messages = await svc.messages({ sessionID: session.id })
          expect(messages.map((item) => item.info.id)).toContain(id)
        },
      }),
    )
  })

  test("returns cursor headers for older pages", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const ids = await fill(session.id, 5)
          const app = Server.Default().app

          const a = await app.request(`/session/${session.id}/message?limit=2`)
          expect(a.status).toBe(200)
          const aBody = (await a.json()) as MessageV2.WithParts[]
          expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
          const cursor = a.headers.get("x-next-cursor")
          expect(cursor).toBeTruthy()
          expect(a.headers.get("link")).toContain('rel="next"')

          const b = await app.request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
          expect(b.status).toBe(200)
          const bBody = (await b.json()) as MessageV2.WithParts[]
          expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("keeps full-history responses when limit is omitted", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const ids = await fill(session.id, 3)
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/message`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as MessageV2.WithParts[]
          expect(body.map((item) => item.info.id)).toEqual(ids)

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("returns compacted active transcript when requested", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const u1 = await addUser(session.id, "first")
          const a1 = await addAssistant(session.id, u1, { finish: "end_turn" })
          await svc.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: a1,
            type: "text",
            text: "first reply",
          })
          const u2 = await addUser(session.id, "second")
          const a2 = await addAssistant(session.id, u2, { finish: "end_turn" })
          await svc.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: a2,
            type: "text",
            text: "second reply",
          })
          const compaction = await addUser(session.id)
          await addCompactionPart(session.id, compaction, u2)
          const summary = await addAssistant(session.id, compaction, { summary: true, finish: "end_turn" })
          await svc.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: summary,
            type: "text",
            text: "summary",
          })
          const u3 = await addUser(session.id, "third")
          const a3 = await addAssistant(session.id, u3, { finish: "end_turn" })

          const app = Server.Default().app
          const raw = await app.request(`/session/${session.id}/message`)
          const active = await app.request(`/session/${session.id}/message?view=active`)

          expect(raw.status).toBe(200)
          expect(active.status).toBe(200)
          expect(((await raw.json()) as MessageV2.WithParts[]).map((item) => item.info.id)).toEqual([
            u1,
            a1,
            u2,
            a2,
            compaction,
            summary,
            u3,
            a3,
          ])
          expect(((await active.json()) as MessageV2.WithParts[]).map((item) => item.info.id)).toEqual([
            u2,
            a2,
            compaction,
            summary,
            u3,
            a3,
          ])

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("rejects invalid cursors and missing sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const app = Server.Default().app

          const bad = await app.request(`/session/${session.id}/message?limit=2&before=bad`)
          expect(bad.status).toBe(400)

          const miss = await app.request(`/session/ses_missing/message?limit=2`)
          expect(miss.status).toBe(404)

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("does not truncate large legacy limit requests", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          await fill(session.id, 520)
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/message?limit=510`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as MessageV2.WithParts[]
          expect(body).toHaveLength(510)

          await svc.remove(session.id)
        },
      }),
    )
  })
})

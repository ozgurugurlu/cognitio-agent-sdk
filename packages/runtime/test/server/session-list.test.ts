import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
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
  setTags(input: { sessionID: SessionNs.Info["id"]; tags: string[] }) {
    return run(SessionNs.Service.use((svc) => svc.setTags(input)))
  },
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("session.list", () => {
  test.skipIf(process.platform === "win32")(
    "resolves directory aliases on the server without widening filters",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const directory = path.join(tmp.path, "workspace")
      const other = path.join(tmp.path, "other")
      const alias = path.join(tmp.path, "workspace-link")
      await Promise.all([mkdir(directory), mkdir(other)])
      await symlink(directory, alias, "dir")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.Default().app
          const create = async (cwd: string) => {
            const response = await app.request(`/session?directory=${encodeURIComponent(cwd)}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: "directory alias regression" }),
            })
            expect(response.status).toBe(200)
            return (await response.json()) as SessionNs.Info
          }
          const first = await create(alias)
          const second = await create(other)
          expect(first.directory).toBe(await realpath(directory))
          expect(first.projectID).toBe(second.projectID)
          expect(Instance.directory).toBe(tmp.path)

          // The filter is independent of the current instance directory. Both
          // explicit service APIs must resolve paths on the runtime host.
          expect([...svc.list({ directory: alias })].map((session) => session.id)).toEqual([first.id])
          expect([...svc.listGlobal({ directory: alias })].map((session) => session.id)).toEqual([first.id])
          expect([...svc.list({ directory: other })].map((session) => session.id)).toEqual([second.id])
          expect([...svc.listGlobal({ directory: other })].map((session) => session.id)).toEqual([second.id])

          for (const route of ["/session", "/experimental/session"]) {
            for (const filter of [alias, directory]) {
              const response = await app.request(`${route}?directory=${encodeURIComponent(filter)}`)
              expect(response.status).toBe(200)
              expect(((await response.json()) as SessionNs.Info[]).map((session) => session.id)).toEqual([first.id])
            }
            const response = await app.request(`${route}?directory=${encodeURIComponent(other)}`)
            expect(response.status).toBe(200)
            expect(((await response.json()) as SessionNs.Info[]).map((session) => session.id)).toEqual([second.id])
          }

          // A context header selects the project; omitting the query filter must
          // continue to list sessions from both physical directories.
          const unfiltered = await app.request("/session", { headers: { "x-cognitio-directory": tmp.path } })
          expect(unfiltered.status).toBe(200)
          expect(((await unfiltered.json()) as SessionNs.Info[]).map((session) => session.id)).toEqual(
            expect.arrayContaining([first.id, second.id]),
          )
        },
      })
    },
  )

  test("filters by directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await svc.create({})

        await using other = await tmpdir({ git: true })
        const second = await Instance.provide({
          directory: other.path,
          fn: async () => svc.create({}),
        })

        const sessions = [...svc.list({ directory: tmp.path })]
        const ids = sessions.map((s) => s.id)

        expect(ids).toContain(first.id)
        expect(ids).not.toContain(second.id)
      },
    })
  })

  test("filters root sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await svc.create({ title: "root-session" })
        const child = await svc.create({ title: "child-session", parentID: root.id })

        const sessions = [...svc.list({ roots: true })]
        const ids = sessions.map((s) => s.id)

        expect(ids).toContain(root.id)
        expect(ids).not.toContain(child.id)
      },
    })
  })

  test("filters by start time", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await svc.create({ title: "new-session" })
        const futureStart = Date.now() + 86400000

        const sessions = [...svc.list({ start: futureStart })]
        expect(sessions.length).toBe(0)
      },
    })
  })

  test("filters by search term", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await svc.create({ title: "unique-search-term-abc" })
        await svc.create({ title: "other-session-xyz" })

        const sessions = [...svc.list({ search: "unique-search" })]
        const titles = sessions.map((s) => s.title)

        expect(titles).toContain("unique-search-term-abc")
        expect(titles).not.toContain("other-session-xyz")
      },
    })
  })

  test("respects limit parameter", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await svc.create({ title: "session-1" })
        await svc.create({ title: "session-2" })
        await svc.create({ title: "session-3" })

        const sessions = [...svc.list({ limit: 2 })]
        expect(sessions.length).toBe(2)
      },
    })
  })

  test("filters by exact normalized tag in project and global lists", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tagged = await svc.create({ title: "tagged-session" })
        const other = await svc.create({ title: "untagged-session" })

        await svc.setTags({ sessionID: tagged.id, tags: [" phase7 ", "phase7", "", "review"] })

        expect((await svc.create({ title: "default-tags" })).tags).toEqual([])
        expect((await run(SessionNs.Service.use((svc) => svc.get(tagged.id)))).tags).toEqual(["phase7", "review"])

        const project = [...svc.list({ tag: "phase7" })]
        expect(project.map((item) => item.id)).toContain(tagged.id)
        expect(project.map((item) => item.id)).not.toContain(other.id)

        const global = [...svc.listGlobal({ tag: "phase7" })]
        expect(global.map((item) => item.id)).toContain(tagged.id)
        expect(global.map((item) => item.id)).not.toContain(other.id)
      },
    })
  })

  test("patches tags and filters by exact tag through HTTP", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const tagged = await svc.create({ title: "http-tagged-session" })
        const other = await svc.create({ title: "http-other-session" })
        const directory = encodeURIComponent(tmp.path)

        const patched = await app.request(`/session/${tagged.id}?directory=${directory}`, {
          method: "PATCH",
          body: JSON.stringify({ tags: [" phase7 ", "phase7", "", "review"] }),
          headers: { "content-type": "application/json" },
        })
        expect(patched.status).toBe(200)
        expect(((await patched.json()) as SessionNs.Info).tags).toEqual(["phase7", "review"])

        const phase7 = await app.request(`/session?directory=${directory}&tag=phase7`)
        expect(phase7.status).toBe(200)
        expect(((await phase7.json()) as SessionNs.Info[]).map((item) => item.id)).toContain(tagged.id)
        expect(
          (
            (await (await app.request(`/session?directory=${directory}&tag=phase7-extra`)).json()) as SessionNs.Info[]
          ).map((item) => item.id),
        ).not.toContain(tagged.id)

        const replacement = await app.request(`/session/${tagged.id}?directory=${directory}`, {
          method: "PATCH",
          body: JSON.stringify({ tags: ["done"] }),
          headers: { "content-type": "application/json" },
        })
        expect(replacement.status).toBe(200)
        expect(((await replacement.json()) as SessionNs.Info).tags).toEqual(["done"])
        const phase7AfterReplacement = (
          (await (await app.request(`/session?directory=${directory}&tag=phase7`)).json()) as SessionNs.Info[]
        ).map((item) => item.id)
        const doneAfterReplacement = (
          (await (await app.request(`/session?directory=${directory}&tag=done`)).json()) as SessionNs.Info[]
        ).map((item) => item.id)
        expect(phase7AfterReplacement).not.toContain(tagged.id)
        expect(doneAfterReplacement).toContain(tagged.id)
        expect(doneAfterReplacement).not.toContain(other.id)

        const invalid = await app.request(`/session/${tagged.id}?directory=${directory}`, {
          method: "PATCH",
          body: JSON.stringify({ tags: "phase7" }),
          headers: { "content-type": "application/json" },
        })
        expect(invalid.status).toBe(400)
        expect((await run(SessionNs.Service.use((svc) => svc.get(tagged.id)))).tags).toEqual(["done"])
      },
    })
  })
})

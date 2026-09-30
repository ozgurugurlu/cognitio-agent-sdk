import { afterEach, describe, expect, test } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Todo } from "../../src/session/todo"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("SessionTodo", () => {
  test("persists active todos and clears the list when all tasks complete", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: "todos" })))

        await AppRuntime.runPromise(
          Todo.Service.use((svc) =>
            svc.update({
              sessionID: session.id,
              todos: [
                { content: "implement", status: "in_progress", priority: "high" },
                { content: "verify", status: "pending", priority: "medium" },
              ],
            }),
          ),
        )
        await expect(AppRuntime.runPromise(Todo.Service.use((svc) => svc.get(session.id)))).resolves.toEqual([
          { content: "implement", status: "in_progress", priority: "high" },
          { content: "verify", status: "pending", priority: "medium" },
        ])

        await AppRuntime.runPromise(
          Todo.Service.use((svc) =>
            svc.update({
              sessionID: session.id,
              todos: [
                { content: "implement", status: "completed", priority: "high" },
                { content: "verify", status: "completed", priority: "medium" },
              ],
            }),
          ),
        )
        await expect(AppRuntime.runPromise(Todo.Service.use((svc) => svc.get(session.id)))).resolves.toEqual([])
      },
    })
  })

  test("todo schema rejects unknown status and priority values", () => {
    expect(() => Todo.Info.parse({ content: "x", status: "blocked", priority: "high" })).toThrow()
    expect(() => Todo.Info.parse({ content: "x", status: "pending", priority: "urgent" })).toThrow()
  })
})

import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ControlRequestRegistry } from "../../src/session/control-registry"
import { Permission } from "../../src/permission"
import { PermissionClassifier } from "../../src/permission/classifier"
import { PermissionPipeline } from "../../src/permission/pipeline"
import { RuntimeToolRules } from "../../src/permission/runtime-rules"
import { Plugin } from "../../src/plugin"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const bus = Bus.layer
const plugin = Layer.mock(Plugin.Service)({
  trigger: <Name extends string, Input, Output>(_name: Name, _input: Input, output: Output) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
})
const classifier = Layer.succeed(
  PermissionClassifier.Service,
  PermissionClassifier.Service.of({
    classify: (input) =>
      Effect.succeed(
        input.toolName === "read"
          ? { decision: "allow" as const, confidence: 0.9, reason: "read-only-tool" }
          : input.toolName === "bash" && JSON.stringify(input.toolInput).includes("rm -rf /")
            ? { decision: "deny" as const, confidence: 0.9, reason: "dangerous-shell-command" }
            : { decision: "ask" as const, confidence: 0, reason: "classifier-fallback" },
      ),
  }),
)
const env = Layer.mergeAll(
  bus,
  plugin,
  Permission.layer.pipe(Layer.provide(bus)),
  classifier,
  ControlRequestRegistry.layer.pipe(Layer.provide(bus)),
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(env)
const itPluginAllow = testEffect(
  Layer.mergeAll(
    bus,
    Layer.mock(Plugin.Service)({
      trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) =>
        Effect.succeed(name === "permission.ask" ? ({ status: "allow" } as Output) : output),
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    }),
    Permission.layer.pipe(Layer.provide(bus)),
    classifier,
    ControlRequestRegistry.layer.pipe(Layer.provide(bus)),
    CrossSpawnSpawner.defaultLayer,
  ),
)
const itPluginDeny = testEffect(
  Layer.mergeAll(
    bus,
    Layer.mock(Plugin.Service)({
      trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) =>
        Effect.succeed(name === "permission.ask" ? ({ status: "deny" } as Output) : output),
      list: () => Effect.succeed([{ "permission.ask": async () => {} } as never]),
      init: () => Effect.void,
    }),
    Permission.layer.pipe(Layer.provide(bus)),
    classifier,
    ControlRequestRegistry.layer.pipe(Layer.provide(bus)),
    CrossSpawnSpawner.defaultLayer,
  ),
)
const itPluginAsk = testEffect(
  Layer.mergeAll(
    bus,
    Layer.mock(Plugin.Service)({
      trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) =>
        Effect.succeed(name === "permission.ask" ? ({ status: "ask" } as Output) : output),
      list: () => Effect.succeed([{ "permission.ask": async () => {} } as never]),
      init: () => Effect.void,
    }),
    Permission.layer.pipe(Layer.provide(bus)),
    classifier,
    ControlRequestRegistry.layer.pipe(Layer.provide(bus)),
    CrossSpawnSpawner.defaultLayer,
  ),
)

afterEach(async () => {
  await Instance.disposeAll()
})

describe("PermissionPipeline", () => {
  it.live("does not call canUseTool when server rules already allow", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const registry = yield* ControlRequestRegistry.Service

        expect(
          yield* PermissionPipeline.ask({
            toolName: "bash",
            toolInput: { command: "ls" },
            cwd: process.cwd(),
            runtime: { canUseTool: true },
            request: request({
              ruleset: [{ permission: "bash", pattern: "ls", action: "allow" }],
            }),
          }),
        ).toEqual({})

        expect(yield* registry.list(SessionID.make("session_test"))).toHaveLength(0)
      }),
    ),
  )

  it.live("does not call canUseTool when server rules deny", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const registry = yield* ControlRequestRegistry.Service
        const exit = yield* PermissionPipeline.ask({
          toolName: "bash",
          toolInput: { command: "rm -rf /" },
          cwd: process.cwd(),
          runtime: { canUseTool: true },
          request: request({
            ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
          }),
        }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(yield* registry.list(SessionID.make("session_test"))).toHaveLength(0)
      }),
    ),
  )

  it.live("keeps explicit server deny above runtime allow rules", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const registry = yield* ControlRequestRegistry.Service
        const runtimePolicy = RuntimeToolRules.fromConfig({ allowedTools: ["Bash(ls)"] })
        const exit = yield* PermissionPipeline.ask({
          toolName: "bash",
          toolInput: { command: "ls" },
          cwd: process.cwd(),
          runtime: { canUseTool: true, allowedTools: ["Bash(ls)"] },
          request: request({
            ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
            runtimePermission: runtimePolicy.permissionForAsk("bash", "bash"),
            runtimeRuleset: runtimePolicy.ruleset,
          }),
        }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(yield* registry.list(SessionID.make("session_test"))).toHaveLength(0)
      }),
    ),
  )

  it.live("lets canUseTool allow win the ask channel and clears the user prompt", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const permission = yield* Permission.Service
        const registry = yield* ControlRequestRegistry.Service
        const seen = yield* Deferred.make<typeof ControlRequestRegistry.Event.Request.properties._zod.output>()

        yield* Stream.runForEach(bus.subscribe(ControlRequestRegistry.Event.Request), (event) =>
          Effect.sync(() => {
            if (event.properties.subtype === "can_use_tool") {
              Deferred.doneUnsafe(seen, Effect.succeed(event.properties))
            }
          }),
        ).pipe(Effect.forkScoped)

        const task = yield* PermissionPipeline.ask({
          toolName: "bash",
          toolInput: { command: "ls" },
          cwd: process.cwd(),
          runtime: { canUseTool: true },
          request: request(),
        }).pipe(Effect.forkChild)
        const control = yield* Deferred.await(seen)

        yield* registry.resolve({
          requestID: control.id,
          response: { behavior: "allow", updatedInput: { command: "pwd" } },
        })

        expect(yield* Fiber.join(task)).toEqual({ updatedInput: { command: "pwd" } })
        expect(yield* permission.list()).toHaveLength(0)
      }),
    ),
  )

  it.live("lets canUseTool deny win the ask channel and publishes replied cleanup", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const permission = yield* Permission.Service
        const registry = yield* ControlRequestRegistry.Service
        const seen = yield* Deferred.make<typeof ControlRequestRegistry.Event.Request.properties._zod.output>()
        const replied = yield* Deferred.make<string>()

        yield* Stream.runForEach(bus.subscribe(ControlRequestRegistry.Event.Request), (event) =>
          Effect.sync(() => {
            if (event.properties.subtype === "can_use_tool") {
              Deferred.doneUnsafe(seen, Effect.succeed(event.properties))
            }
          }),
        ).pipe(Effect.forkScoped)
        yield* Stream.runForEach(bus.subscribe(Permission.Event.Replied), (event) =>
          Effect.sync(() => {
            Deferred.doneUnsafe(replied, Effect.succeed(String(event.properties.requestID)))
          }),
        ).pipe(Effect.forkScoped)

        const task = yield* PermissionPipeline.ask({
          toolName: "bash",
          toolInput: { command: "ls" },
          cwd: process.cwd(),
          runtime: { canUseTool: true },
          request: request(),
        }).pipe(Effect.exit, Effect.forkChild)
        const control = yield* Deferred.await(seen)

        yield* registry.resolve({
          requestID: control.id,
          response: { behavior: "deny", message: "blocked" },
        })

        expect((yield* Fiber.join(task))._tag).toBe("Failure")
        expect(yield* Deferred.await(replied)).toBe(String(control.payload.permissionID))
        expect(yield* permission.list()).toHaveLength(0)
      }),
    ),
  )

  it.live("keeps the user prompt active when the canUseTool control request is cancelled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const permission = yield* Permission.Service
        const registry = yield* ControlRequestRegistry.Service
        const seen = yield* Deferred.make<typeof ControlRequestRegistry.Event.Request.properties._zod.output>()

        yield* Stream.runForEach(bus.subscribe(ControlRequestRegistry.Event.Request), (event) =>
          Effect.sync(() => {
            if (event.properties.subtype === "can_use_tool") {
              Deferred.doneUnsafe(seen, Effect.succeed(event.properties))
            }
          }),
        ).pipe(Effect.forkScoped)

        const task = yield* PermissionPipeline.ask({
          toolName: "bash",
          toolInput: { command: "ls" },
          cwd: process.cwd(),
          runtime: { canUseTool: true },
          request: request(),
        }).pipe(Effect.exit, Effect.forkChild)
        const control = yield* Deferred.await(seen)

        yield* registry.cancel(control.id)
        const pending = yield* waitForPending(permission, 1)
        yield* permission.reply({ requestID: pending[0]!.id, reply: "once" })

        const exit = yield* Fiber.join(task)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) expect(exit.value).toEqual({})
        expect(yield* permission.list()).toHaveLength(0)
      }),
    ),
  )

  it.live("keeps the user prompt active when canUseTool asks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const permission = yield* Permission.Service
        const registry = yield* ControlRequestRegistry.Service
        const seen = yield* Deferred.make<typeof ControlRequestRegistry.Event.Request.properties._zod.output>()

        yield* Stream.runForEach(bus.subscribe(ControlRequestRegistry.Event.Request), (event) =>
          Effect.sync(() => {
            if (event.properties.subtype === "can_use_tool") {
              Deferred.doneUnsafe(seen, Effect.succeed(event.properties))
            }
          }),
        ).pipe(Effect.forkScoped)

        const task = yield* PermissionPipeline.ask({
          toolName: "bash",
          toolInput: { command: "ls" },
          cwd: process.cwd(),
          runtime: { canUseTool: true },
          request: request(),
        }).pipe(Effect.forkChild)
        const control = yield* Deferred.await(seen)

        yield* registry.resolve({ requestID: control.id, response: { behavior: "ask" } })
        const pending = yield* waitForPending(permission, 1)
        yield* permission.reply({ requestID: pending[0]!.id, reply: "once" })

        expect(yield* Fiber.join(task)).toEqual({})
      }),
    ),
  )

  itPluginAllow.live("lets plugin permission.ask allow resolve otherwise askable requests", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service

        expect(
          yield* PermissionPipeline.ask({
            toolName: "bash",
            toolInput: { command: "ls" },
            cwd: process.cwd(),
            runtime: {},
            request: request(),
          }),
        ).toEqual({})
        expect(yield* permission.list()).toHaveLength(0)
      }),
    ),
  )

  itPluginAllow.live("lets plugin permission.ask allow override dontAsk for askable requests", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        expect(
          yield* PermissionPipeline.ask({
            toolName: "bash",
            toolInput: { command: "ls" },
            cwd: process.cwd(),
            runtime: { permissionMode: "dontAsk" },
            request: request(),
          }),
        ).toEqual({})
      }),
    ),
  )

  itPluginAllow.live("keeps explicit server deny above plugin permission.ask allow", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const exit = yield* PermissionPipeline.ask({
          toolName: "bash",
          toolInput: { command: "ls" },
          cwd: process.cwd(),
          runtime: { permissionMode: "bypassPermissions" },
          request: request({ ruleset: [{ permission: "bash", pattern: "*", action: "deny" }] }),
        }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  itPluginDeny.live("keeps plugin permission.ask deny above automatic permission modes", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const bypass = yield* PermissionPipeline.ask({
            toolName: "bash",
            toolInput: { command: "ls" },
            cwd: process.cwd(),
            runtime: { permissionMode: "bypassPermissions" },
            request: request(),
          }).pipe(Effect.exit)
          const acceptEdits = yield* PermissionPipeline.ask({
            toolName: "write",
            toolInput: { filePath: "file.ts" },
            cwd: process.cwd(),
            runtime: { permissionMode: "acceptEdits" },
            request: request({ permission: "edit", patterns: ["file.ts"] }),
          }).pipe(Effect.exit)
          const auto = yield* PermissionPipeline.ask({
            toolName: "read",
            toolInput: { filePath: "README.md" },
            cwd: process.cwd(),
            runtime: { permissionMode: "auto" },
            request: request({ permission: "read", patterns: ["README.md"] }),
          }).pipe(Effect.exit)

          expect(bypass._tag).toBe("Failure")
          expect(acceptEdits._tag).toBe("Failure")
          expect(auto._tag).toBe("Failure")
        }),
      { git: true },
    ),
  )

  itPluginAsk.live("registered plugin permission.ask ask forces the ask channel above bypassPermissions", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const task = yield* PermissionPipeline.ask({
          toolName: "bash",
          toolInput: { command: "ls" },
          cwd: process.cwd(),
          runtime: { permissionMode: "bypassPermissions" },
          request: request(),
        }).pipe(Effect.forkChild)
        const pending = yield* waitForPending(permission, 1)
        yield* permission.reply({ requestID: pending[0]!.id, reply: "once" })

        expect(yield* Fiber.join(task)).toEqual({})
      }),
    ),
  )

  it.live("dontAsk denies unresolved asks without prompting", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const exit = yield* PermissionPipeline.ask({
          toolName: "bash",
          toolInput: { command: "ls" },
          cwd: process.cwd(),
          runtime: { permissionMode: "dontAsk" },
          request: request(),
        }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(yield* permission.list()).toHaveLength(0)
      }),
    ),
  )

  it.live("bypassPermissions allows unresolved asks without prompting", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service

        expect(
          yield* PermissionPipeline.ask({
            toolName: "bash",
            toolInput: { command: "ls" },
            cwd: process.cwd(),
            runtime: { permissionMode: "bypassPermissions" },
            request: request(),
          }),
        ).toEqual({})
        expect(yield* permission.list()).toHaveLength(0)
      }),
    ),
  )

  it.live("acceptEdits resolves relative edit paths against the worktree", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service

          expect(
            yield* PermissionPipeline.ask({
              toolName: "write",
              toolInput: { filePath: "file.ts" },
              cwd: process.cwd(),
              runtime: { permissionMode: "acceptEdits" },
              request: request({ permission: "edit", patterns: ["file.ts"] }),
            }),
          ).toEqual({})
          expect(yield* permission.list()).toHaveLength(0)
        }),
      { git: true },
    ),
  )

  it.live("acceptEdits still asks for external read paths", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const task = yield* PermissionPipeline.ask({
          toolName: "read",
          toolInput: { filePath: "/tmp/outside-secret.txt" },
          cwd: process.cwd(),
          runtime: { permissionMode: "acceptEdits" },
          request: request({
            permission: "external_directory",
            patterns: ["/tmp/*"],
            always: ["/tmp/*"],
          }),
        }).pipe(Effect.forkChild)
        const pending = yield* waitForPending(permission, 1)
        yield* permission.reply({ requestID: pending[0]!.id, reply: "once" })

        expect(yield* Fiber.join(task)).toEqual({})
      }),
    ),
  )

  it.live("plan mode denies non-plan edits and allows plan file edits plus plan_exit", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const denied = yield* PermissionPipeline.ask({
          toolName: "write",
          toolInput: { filePath: "src/file.ts" },
          cwd: process.cwd(),
          runtime: { permissionMode: "plan" },
          request: request({ permission: "edit", patterns: ["src/file.ts"] }),
        }).pipe(Effect.exit)

        expect(denied._tag).toBe("Failure")
        expect(
          yield* PermissionPipeline.ask({
            toolName: "write",
            toolInput: { filePath: ".cognitio/plans/test.md" },
            cwd: process.cwd(),
            runtime: { permissionMode: "plan" },
            request: request({ permission: "edit", patterns: [".cognitio/plans/test.md"] }),
          }),
        ).toEqual({})
        expect(
          yield* PermissionPipeline.ask({
            toolName: "plan_exit",
            toolInput: {},
            cwd: process.cwd(),
            runtime: { permissionMode: "plan" },
            request: request({ permission: "plan_exit", patterns: ["*"] }),
          }),
        ).toEqual({})
      }),
    ),
  )

  it.live("plan mode does not override explicit denies", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const runtimePolicy = RuntimeToolRules.fromConfig({ disallowedTools: ["plan_exit", "write"] })
        const planExit = yield* PermissionPipeline.ask({
          toolName: "plan_exit",
          toolInput: {},
          cwd: process.cwd(),
          runtime: { permissionMode: "plan" },
          request: request({
            permission: "plan_exit",
            patterns: ["*"],
            ruleset: [{ permission: "plan_exit", pattern: "*", action: "deny" }],
          }),
        }).pipe(Effect.exit)
        const planFile = yield* PermissionPipeline.ask({
          toolName: "write",
          toolInput: { filePath: ".cognitio/plans/test.md" },
          cwd: process.cwd(),
          runtime: { permissionMode: "plan" },
          request: request({
            permission: "edit",
            patterns: [".cognitio/plans/test.md"],
            ruleset: [{ permission: "edit", pattern: "*", action: "deny" }],
          }),
        }).pipe(Effect.exit)
        const runtimePlanExit = yield* PermissionPipeline.ask({
          toolName: "plan_exit",
          toolInput: {},
          cwd: process.cwd(),
          runtime: { permissionMode: "plan", disallowedTools: ["plan_exit", "write"] },
          request: request({
            permission: "plan_exit",
            patterns: ["*"],
            runtimePermission: runtimePolicy.permissionForAsk("plan_exit", "plan_exit"),
            runtimeRuleset: runtimePolicy.ruleset,
          }),
        }).pipe(Effect.exit)
        const runtimePlanFile = yield* PermissionPipeline.ask({
          toolName: "write",
          toolInput: { filePath: ".cognitio/plans/test.md" },
          cwd: process.cwd(),
          runtime: { permissionMode: "plan", disallowedTools: ["plan_exit", "write"] },
          request: request({
            permission: "edit",
            patterns: [".cognitio/plans/test.md"],
            runtimePermission: runtimePolicy.permissionForAsk("write", "edit"),
            runtimeRuleset: runtimePolicy.ruleset,
          }),
        }).pipe(Effect.exit)

        expect(planExit._tag).toBe("Failure")
        expect(planFile._tag).toBe("Failure")
        expect(runtimePlanExit._tag).toBe("Failure")
        expect(runtimePlanFile._tag).toBe("Failure")
      }),
    ),
  )

  it.live("auto mode allows high-confidence read-only classifier results without prompting", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service

        expect(
          yield* PermissionPipeline.ask({
            toolName: "read",
            toolInput: { filePath: "README.md" },
            cwd: process.cwd(),
            runtime: { permissionMode: "auto" },
            request: request({
              permission: "read",
              patterns: ["README.md"],
            }),
          }),
        ).toEqual({})
        expect(yield* permission.list()).toHaveLength(0)
      }),
    ),
  )

  it.live("auto mode denies high-confidence dangerous shell classifier results", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const exit = yield* PermissionPipeline.ask({
          toolName: "bash",
          toolInput: { command: "rm -rf /" },
          cwd: process.cwd(),
          runtime: { permissionMode: "auto" },
          request: request({
            patterns: ["rm -rf /"],
          }),
        }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(yield* permission.list()).toHaveLength(0)
      }),
    ),
  )
})

function request(input: Partial<Permission.AskInput> = {}): Permission.AskInput {
  return {
    sessionID: SessionID.make("session_test"),
    permission: "bash",
    patterns: ["ls"],
    metadata: {},
    always: [],
    tool: {
      messageID: MessageID.make("msg_test"),
      callID: "call_test",
    },
    ruleset: [],
    ...input,
  }
}

function waitForPending(permission: Permission.Interface, count: number) {
  return Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const pending = yield* permission.list()
      if (pending.length === count) return pending
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`))
  })
}

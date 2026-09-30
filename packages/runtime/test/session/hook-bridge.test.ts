import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { ControlRequestRegistry } from "../../src/session/control-registry"
import { HookBridge } from "../../src/session/hook-bridge"
import { SessionRuntimeConfig } from "../../src/session/runtime-config"
import { SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const bus = Bus.layer
const env = Layer.mergeAll(
  bus,
  SessionRuntimeConfig.defaultLayer,
  ControlRequestRegistry.layer.pipe(Layer.provide(bus)),
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(env)

afterEach(async () => {
  await Instance.disposeAll()
})

describe("HookBridge", () => {
  it.live("skips control roundtrip when no descriptors are registered", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const registry = yield* ControlRequestRegistry.Service

        expect(
          yield* HookBridge.run({
            sessionID: SessionID.make("session_test"),
            event: "PreToolUse",
            data: { toolName: "bash" },
            target: "bash",
          }),
        ).toEqual(HookBridge.empty())
        expect(yield* registry.list(SessionID.make("session_test"))).toHaveLength(0)
      }),
    ),
  )

  it.live("dispatches notify hooks without waiting for a response", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const runtime = yield* SessionRuntimeConfig.Service
        const registry = yield* ControlRequestRegistry.Service
        const sessionID = SessionID.make("session_test")

        yield* runtime.set({
          sessionID,
          config: { hooks: { SessionStart: [{ id: "start", timeoutMs: 1_000 }] } },
        })
        yield* HookBridge.notify({ sessionID, event: "SessionStart", data: {} })

        const pending = yield* waitForControl(registry, sessionID, 1)
        expect(pending[0]?.subtype).toBe("hook_callback")
        expect(pending[0]?.timeoutMs).toBe(1_000)
        expect(pending[0]?.payload).toMatchObject({
          event: "SessionStart",
          descriptors: [{ id: "start", timeoutMs: 1_000 }],
        })
      }),
    ),
  )

  it.live("filters descriptors by matcher before dispatch", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const runtime = yield* SessionRuntimeConfig.Service
        const registry = yield* ControlRequestRegistry.Service
        const sessionID = SessionID.make("session_test")

        yield* runtime.set({
          sessionID,
          config: {
            hooks: {
              PreToolUse: [
                { id: "pre-bash", matcher: "bash", timeoutMs: 1_000 },
                { id: "pre-write", matcher: "write", timeoutMs: 1_000 },
              ],
            },
          },
        })

        expect(
          yield* HookBridge.run({
            sessionID,
            event: "PreToolUse",
            data: { toolName: "read" },
            target: "read",
          }),
        ).toEqual(HookBridge.empty())
        expect(yield* registry.list(sessionID)).toHaveLength(0)

        const task = yield* HookBridge.run({
          sessionID,
          event: "PreToolUse",
          data: { toolName: "bash" },
          target: "bash",
        }).pipe(Effect.forkChild)
        const pending = yield* waitForControl(registry, sessionID, 1)

        expect(pending[0]?.payload).toMatchObject({
          event: "PreToolUse",
          descriptors: [{ id: "pre-bash", matcher: "bash", timeoutMs: 1_000 }],
        })
        yield* registry.resolve({ requestID: pending[0]!.id, response: { continue: true } })
        expect(yield* Fiber.join(task)).toEqual(HookBridge.empty())
      }),
    ),
  )

  it.live("uses explicit runtime snapshot instead of live session hooks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const runtime = yield* SessionRuntimeConfig.Service
        const registry = yield* ControlRequestRegistry.Service
        const sessionID = SessionID.make("session_test")

        yield* runtime.set({
          sessionID,
          config: {
            hooks: {
              PreToolUse: [{ id: "live-write", matcher: "write", timeoutMs: 1_000 }],
            },
          },
        })

        const task = yield* HookBridge.run({
          sessionID,
          runtime: {
            hooks: {
              PreToolUse: [{ id: "snapshot-bash", matcher: "bash", timeoutMs: 1_000 }],
            },
          },
          event: "PreToolUse",
          data: { toolName: "bash" },
          target: "bash",
        }).pipe(Effect.forkChild)
        const pending = yield* waitForControl(registry, sessionID, 1)

        expect(pending[0]?.payload).toMatchObject({
          event: "PreToolUse",
          descriptors: [{ id: "snapshot-bash", matcher: "bash", timeoutMs: 1_000 }],
        })
        yield* registry.resolve({ requestID: pending[0]!.id, response: { continue: true } })
        expect(yield* Fiber.join(task)).toEqual(HookBridge.empty())
      }),
    ),
  )

  it.live("runs blocking hooks and normalizes aggregate responses", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const runtime = yield* SessionRuntimeConfig.Service
        const registry = yield* ControlRequestRegistry.Service
        const sessionID = SessionID.make("session_test")

        yield* runtime.set({
          sessionID,
          config: { hooks: { PreToolUse: [{ id: "pre-bash", matcher: "bash", timeoutMs: 1_000 }] } },
        })

        const task = yield* HookBridge.run({
          sessionID,
          event: "PreToolUse",
          data: { toolName: "bash", input: { command: "ls" }, callID: "call-1" },
          target: "bash",
        }).pipe(Effect.forkChild)
        const pending = yield* waitForControl(registry, sessionID, 1)
        expect(pending[0]?.payload).toMatchObject({
          callID: "call-1",
          toolCallId: "call-1",
        })

        yield* registry.resolve({
          requestID: pending[0]!.id,
          response: {
            continue: false,
            stopReason: "blocked",
            permissionDecision: { behavior: "deny", message: "No" },
            additionalContext: "context",
          },
        })

        expect(yield* Fiber.join(task)).toEqual({
          continue: false,
          permissionDecision: { behavior: "deny", message: "No" },
          additionalContext: ["context"],
          systemMessage: [],
          stopReason: "blocked",
        })
      }),
    ),
  )

  test("normalizes permission-decision updated input into aggregate updated input", () => {
    expect(
      HookBridge.normalizeAggregate({
        permissionDecision: { behavior: "allow", updatedInput: { command: "npm test" } },
        updatedInput: { timeout: 1_000 },
      }).updatedInput,
    ).toEqual({ command: "npm test", timeout: 1_000 })
  })

  test("normalizes and merges custom instructions", () => {
    expect(
      HookBridge.normalizeAggregate([{ customInstructions: "first" }, { customInstructions: ["second", "third"] }])
        .customInstructions,
    ).toBe("first\n\nsecond\n\nthird")
  })
})

function waitForControl(
  registry: { list: (sessionID?: SessionID) => Effect.Effect<ReadonlyArray<ControlRequestRegistry.Request>> },
  sessionID: SessionID,
  count: number,
) {
  return Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const pending = yield* registry.list(sessionID)
      if (pending.length === count) return pending
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} pending control request(s)`))
  })
}

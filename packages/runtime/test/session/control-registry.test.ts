import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Fiber, Stream } from "effect"
import { Bus } from "../../src/bus"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { ControlRequestRegistry } from "../../src/session/control-registry"
import { SessionID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Instance } from "../../src/project/instance"

const it = testEffect(Layer.mergeAll(ControlRequestRegistry.defaultLayer, CrossSpawnSpawner.defaultLayer))
const layers = Layer.mergeAll(Bus.defaultLayer, ControlRequestRegistry.defaultLayer, CrossSpawnSpawner.defaultLayer)
const test = testEffect(layers)

describe("control request registry", () => {
  test.live("creates, lists, resolves, and deduplicates requests", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const registry = yield* ControlRequestRegistry.Service
        const requestSeen = yield* Deferred.make<typeof ControlRequestRegistry.Event.Request.properties._zod.output>()
        const sessionID = SessionID.descending()

        yield* Stream.runForEach(bus.subscribe(ControlRequestRegistry.Event.Request), (event) =>
          Effect.sync(() => {
            Deferred.doneUnsafe(requestSeen, Effect.succeed(event.properties))
          }),
        ).pipe(Effect.forkScoped)

        const task = yield* registry
          .create({
            sessionID,
            subtype: "hook_callback",
            payload: { hook: "pre_tool" },
          })
          .pipe(Effect.forkChild)

        const request = yield* Deferred.await(requestSeen)
        expect(request.sessionID).toBe(sessionID)
        expect(request.subtype).toBe("hook_callback")

        const pending = yield* registry.list(sessionID)
        expect(pending).toHaveLength(1)
        expect(pending[0]?.id).toBe(request.id)
        expect(pending[0]?.payload).toEqual({
          hook: "pre_tool",
          rootSessionID: sessionID,
          activeSessionID: sessionID,
        })
        expect(pending[0]?.timeoutMs).toBe(ControlRequestRegistry.DEFAULT_TIMEOUT_MS)

        expect(
          yield* registry.resolve({
            requestID: request.id,
            response: { ok: true },
          }),
        ).toBe(true)
        expect(
          yield* registry.resolve({
            requestID: request.id,
            response: { ok: false },
          }),
        ).toBe(false)

        const exit = yield* Fiber.await(task)
        expect(exit._tag).toBe("Success")
        if (exit._tag === "Success") expect(exit.value).toEqual({ ok: true })
        expect(yield* registry.list(sessionID)).toHaveLength(0)
      }),
    ),
  )

  test.live("emits timeout and cancellation terminal states", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const registry = yield* ControlRequestRegistry.Service
        const cancelled: string[] = []
        const sessionID = SessionID.descending()

        yield* Stream.runForEach(bus.subscribe(ControlRequestRegistry.Event.Cancelled), (event) =>
          Effect.sync(() => {
            cancelled.push(event.properties.reason)
          }),
        ).pipe(Effect.forkScoped)

        const timeoutExit = yield* registry
          .create({
            sessionID,
            subtype: "elicitation",
            payload: { question: "Continue?" },
            timeoutMs: 10,
          })
          .pipe(Effect.exit)
        expect(timeoutExit._tag).toBe("Failure")

        const pendingTask = yield* registry
          .create({
            sessionID,
            subtype: "mcp_message",
            payload: { message: "ping" },
            timeoutMs: 1_000,
          })
          .pipe(Effect.forkChild)
        yield* Effect.sleep("10 millis")
        const pending = yield* registry.list(sessionID)
        expect(pending).toHaveLength(1)
        const requestID = pending[0]!.id
        expect(yield* registry.cancel(requestID)).toBe(true)
        expect(yield* registry.cancel(requestID)).toBe(false)

        const pendingExit = yield* Fiber.await(pendingTask)
        expect(pendingExit._tag).toBe("Failure")
        expect(cancelled).toContain("timeout")
        expect(cancelled).toContain("cancelled")
      }),
    ),
  )

  test.live("cleans up pending request when create caller is interrupted", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const registry = yield* ControlRequestRegistry.Service
        const sessionID = SessionID.descending()
        const requestSeen = yield* Deferred.make<typeof ControlRequestRegistry.Event.Request.properties._zod.output>()
        const cancelledSeen = yield* Deferred.make<typeof ControlRequestRegistry.Event.Cancelled.properties._zod.output>()

        yield* Stream.runForEach(bus.subscribe(ControlRequestRegistry.Event.Request), (event) =>
          Effect.sync(() => {
            if (event.properties.sessionID !== sessionID) return
            Deferred.doneUnsafe(requestSeen, Effect.succeed(event.properties))
          }),
        ).pipe(Effect.forkScoped)
        yield* Stream.runForEach(bus.subscribe(ControlRequestRegistry.Event.Cancelled), (event) =>
          Effect.sync(() => {
            if (event.properties.sessionID !== sessionID) return
            if (event.properties.reason !== "cancelled") return
            Deferred.doneUnsafe(cancelledSeen, Effect.succeed(event.properties))
          }),
        ).pipe(Effect.forkScoped)

        const task = yield* registry
          .create({
            sessionID,
            subtype: "hook_callback",
            payload: { hook: "interrupt" },
            timeoutMs: 1_000,
          })
          .pipe(Effect.forkChild)
        const request = yield* Deferred.await(requestSeen)

        expect(yield* registry.list(sessionID)).toHaveLength(1)

        yield* Fiber.interrupt(task)
        const exit = yield* Fiber.await(task)
        const event = yield* Deferred.await(cancelledSeen).pipe(
          Effect.raceFirst(
            Effect.sleep("1 second").pipe(
              Effect.flatMap(() => Effect.die(new Error("timed out waiting for interrupt cancellation event"))),
            ),
          ),
        )

        expect(exit._tag).toBe("Failure")
        expect(event.id).toBe(request.id)
        expect(event.reason).toBe("cancelled")
        expect(yield* registry.list(sessionID)).toHaveLength(0)
      }),
    ),
  )

  test.live("returns false for unknown ids and filters list by session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const registry = yield* ControlRequestRegistry.Service
        const seen = yield* Deferred.make<
          ReadonlyArray<typeof ControlRequestRegistry.Event.Request.properties._zod.output>
        >()
        const captured: Array<typeof ControlRequestRegistry.Event.Request.properties._zod.output> = []
        const sessionA = SessionID.descending()
        const sessionB = SessionID.descending()

        yield* Stream.runForEach(bus.subscribe(ControlRequestRegistry.Event.Request), (event) =>
          Effect.sync(() => {
            captured.push(event.properties)
            if (captured.length === 2) {
              Deferred.doneUnsafe(seen, Effect.succeed([...captured]))
            }
          }),
        ).pipe(Effect.forkScoped)

        const a = yield* registry
          .create({
            sessionID: sessionA,
            subtype: "hook_callback",
            payload: { hook: "a" },
            timeoutMs: 1_000,
          })
          .pipe(Effect.forkChild)
        const b = yield* registry
          .create({
            sessionID: sessionB,
            subtype: "hook_callback",
            payload: { hook: "b" },
            timeoutMs: 1_000,
          })
          .pipe(Effect.forkChild)

        const [requestA, requestB] = yield* Deferred.await(seen)
        expect((yield* registry.list(sessionA)).map((item) => item.id)).toEqual([requestA.id])
        expect((yield* registry.list(sessionB)).map((item) => item.id)).toEqual([requestB.id])
        expect(
          yield* registry.resolve({
            requestID: crypto.randomUUID() as ControlRequestRegistry.ControlRequestID,
            response: { ok: false },
          }),
        ).toBe(false)

        yield* registry.resolve({ requestID: requestA.id, response: { ok: true } })
        yield* registry.resolve({ requestID: requestB.id, response: { ok: true } })
        yield* Fiber.await(a)
        yield* Fiber.await(b)
      }),
    ),
  )

  test.live("returns immutable list snapshots with copied payloads", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const registry = yield* ControlRequestRegistry.Service
        const seen = yield* Deferred.make<typeof ControlRequestRegistry.Event.Request.properties._zod.output>()
        const sessionID = SessionID.descending()

        yield* Stream.runForEach(bus.subscribe(ControlRequestRegistry.Event.Request), (event) =>
          Effect.sync(() => {
            if (event.properties.sessionID !== sessionID) return
            Deferred.doneUnsafe(seen, Effect.succeed(event.properties))
          }),
        ).pipe(Effect.forkScoped)

        const task = yield* registry
          .create({
            sessionID,
            subtype: "hook_callback",
            payload: { hook: "original" },
            timeoutMs: 1_000,
          })
          .pipe(Effect.forkChild)
        const request = yield* Deferred.await(seen)
        const first = yield* registry.list(sessionID)
        first[0]!.payload.hook = "mutated"

        const second = yield* registry.list(sessionID)
        expect(second[0]?.payload).toEqual({
          hook: "original",
          rootSessionID: sessionID,
          activeSessionID: sessionID,
        })

        yield* registry.resolve({ requestID: request.id, response: { ok: true } })
        yield* Fiber.await(task)
      }),
    ),
  )

  test.live("guards session-scoped resolve and cancel without consuming mismatches", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const registry = yield* ControlRequestRegistry.Service
        const seen = yield* Deferred.make<typeof ControlRequestRegistry.Event.Request.properties._zod.output>()
        const sessionA = SessionID.descending()
        const sessionB = SessionID.descending()

        yield* Stream.runForEach(bus.subscribe(ControlRequestRegistry.Event.Request), (event) =>
          Effect.sync(() => {
            if (event.properties.sessionID !== sessionA) return
            Deferred.doneUnsafe(seen, Effect.succeed(event.properties))
          }),
        ).pipe(Effect.forkScoped)

        const task = yield* registry
          .create({
            sessionID: sessionA,
            subtype: "hook_callback",
            payload: { hook: "guarded" },
            timeoutMs: 1_000,
          })
          .pipe(Effect.forkChild)
        const request = yield* Deferred.await(seen)

        expect(
          yield* registry.resolveForSession({
            sessionID: sessionB,
            requestID: request.id,
            subtype: "hook_callback",
            response: { ok: "wrong-session" },
          }),
        ).toBe(false)
        expect(
          yield* registry.resolveForSession({
            sessionID: sessionA,
            requestID: request.id,
            subtype: "can_use_tool",
            response: { ok: "wrong-subtype" },
          }),
        ).toBe(false)
        expect(yield* registry.list(sessionA)).toHaveLength(1)
        expect(
          yield* registry.cancelForSession({
            sessionID: sessionB,
            requestID: request.id,
            subtype: "hook_callback",
          }),
        ).toBe(false)
        expect(
          yield* registry.cancelForSession({
            sessionID: sessionA,
            requestID: request.id,
            subtype: "can_use_tool",
          }),
        ).toBe(false)
        expect(yield* registry.list(sessionA)).toHaveLength(1)

        expect(
          yield* registry.resolveForSession({
            sessionID: sessionA,
            requestID: request.id,
            subtype: "hook_callback",
            response: { ok: true },
          }),
        ).toBe(true)

        const exit = yield* Fiber.await(task)
        expect(exit._tag).toBe("Success")
        if (exit._tag === "Success") expect(exit.value).toEqual({ ok: true })
      }),
    ),
  )

  test.live("fails pending requests on shutdown", () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const registry = yield* ControlRequestRegistry.Service
        const sessionID = SessionID.descending()
        const cancelled = yield* Deferred.make<typeof ControlRequestRegistry.Event.Cancelled.properties._zod.output>()
        const onEvent = (event: GlobalEvent) => {
          if (event.directory !== directory) return
          if (event.payload.type !== ControlRequestRegistry.Event.Cancelled.type) return
          if (event.payload.properties.sessionID !== sessionID) return
          if (event.payload.properties.reason !== "shutdown") return
          Deferred.doneUnsafe(cancelled, Effect.succeed(event.payload.properties))
        }

        yield* Effect.sync(() => GlobalBus.on("event", onEvent))
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onEvent)))

        const task = yield* registry
          .create({
            sessionID,
            subtype: "mcp_message",
            payload: { message: "ping" },
            timeoutMs: 1_000,
          })
          .pipe(Effect.forkChild)

        yield* Effect.sleep("10 millis")
        yield* Effect.promise(() => Instance.dispose())

        const exit = yield* Fiber.await(task)
        const event = yield* Effect.race(
          Deferred.await(cancelled),
          Effect.sleep("1 second").pipe(
            Effect.flatMap(() => Effect.die(new Error("timed out waiting for shutdown cancellation event"))),
          ),
        )

        expect(exit._tag).toBe("Failure")
        expect(event.sessionID).toBe(sessionID)
        expect(event.reason).toBe("shutdown")
        expect(yield* registry.list(sessionID)).toHaveLength(0)
      }),
    ),
  )
})

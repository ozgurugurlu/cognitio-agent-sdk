import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"
import { Database, eq } from "@/storage"
import { SessionTable } from "./session.sql"
import { Effect, Layer, Deferred, Context } from "effect"
import z from "zod"
import { SessionID } from "./schema"

export const DEFAULT_TIMEOUT_MS = 30_000

export const ControlSubtype = z
  .enum(["can_use_tool", "hook_callback", "elicitation", "mcp_message"])
  .meta({ ref: "ControlSubtype" })
export type ControlSubtype = z.infer<typeof ControlSubtype>

export const ControlRequestID = z.string().uuid().brand<"ControlRequestID">().meta({ ref: "ControlRequestID" })
export type ControlRequestID = z.infer<typeof ControlRequestID>

export const ControlPayload = z.record(z.string(), z.unknown()).meta({ ref: "ControlPayload" })
export type ControlPayload = z.infer<typeof ControlPayload>

export const Request = z
  .object({
    id: ControlRequestID,
    sessionID: SessionID.zod,
    subtype: ControlSubtype,
    payload: ControlPayload,
    createdAt: z.number(),
    timeoutMs: z.number(),
  })
  .meta({ ref: "ControlRequest" })
export type Request = z.infer<typeof Request>

export const CancelReason = z.enum(["timeout", "cancelled", "shutdown"]).meta({ ref: "ControlCancelReason" })
export type CancelReason = z.infer<typeof CancelReason>

export const Event = {
  Request: BusEvent.define("control.request", Request),
  Cancelled: BusEvent.define(
    "control.cancelled",
    z.object({
      id: ControlRequestID,
      sessionID: SessionID.zod,
      reason: CancelReason,
    }),
  ),
}

export class TimeoutError extends Error {
  constructor(public readonly requestID: ControlRequestID) {
    super(`Control request timed out: ${requestID}`)
  }
}

export class CancelledError extends Error {
  constructor(public readonly requestID: ControlRequestID) {
    super(`Control request cancelled: ${requestID}`)
  }
}

export class ShutdownError extends Error {
  constructor(public readonly requestID: ControlRequestID) {
    super(`Control request cancelled during shutdown: ${requestID}`)
  }
}

interface CreateInput {
  sessionID: SessionID
  subtype: ControlSubtype
  payload: ControlPayload
  timeoutMs?: number
}

interface ResolveInput {
  requestID: ControlRequestID
  response: ControlPayload
}

interface ResolveForSessionInput extends ResolveInput {
  sessionID: SessionID
  subtype: ControlSubtype
}

interface CancelForSessionInput {
  sessionID: SessionID
  requestID: ControlRequestID
  subtype: ControlSubtype
}

export interface Interface {
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<ControlPayload, TimeoutError | CancelledError | ShutdownError>
  readonly resolve: (input: ResolveInput) => Effect.Effect<boolean>
  readonly cancel: (requestID: ControlRequestID) => Effect.Effect<boolean>
  readonly resolveForSession: (input: ResolveForSessionInput) => Effect.Effect<boolean>
  readonly cancelForSession: (input: CancelForSessionInput) => Effect.Effect<boolean>
  readonly list: (sessionID?: SessionID) => Effect.Effect<ReadonlyArray<Request>>
}

interface Entry {
  info: Request
  deferred: Deferred.Deferred<ControlPayload, TimeoutError | CancelledError | ShutdownError>
}

export function lineage(sessionID: SessionID): {
  rootSessionID: SessionID
  activeSessionID: SessionID
  parentSessionID?: SessionID
} {
  let active = sessionID
  let parent = parentID(active)
  const seen = new Set<string>([active])
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    active = SessionID.make(parent)
    parent = parentID(active)
  }
  return {
    rootSessionID: active,
    activeSessionID: sessionID,
    ...(sessionID !== active ? { parentSessionID: parentID(sessionID) } : {}),
  }
}

function parentID(sessionID: SessionID) {
  const row = Database.use((db) =>
    db
      .select({ parent_id: SessionTable.parent_id, fork_of: SessionTable.fork_of })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get(),
  )
  if (!row) return undefined
  // Forks are lineage roots: parent_id exists for listing/UX only. Without
  // this boundary, control requests and task/rate-limit/subagent events from
  // a fork (or anything spawned inside it) would route to the ORIGINAL
  // session's streams and never reach the fork's own consumers.
  if (row.fork_of) return undefined
  return row.parent_id ?? undefined
}

export class Service extends Context.Service<Service, Interface>()("@cognitio/ControlRequestRegistry") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make(
      Effect.fn("ControlRequestRegistry.state")(function* () {
        const pending = new Map<ControlRequestID, Entry>()
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const entry of Array.from(pending.values())) {
              pending.delete(entry.info.id)
              yield* bus.publish(Event.Cancelled, {
                id: entry.info.id,
                sessionID: entry.info.sessionID,
                reason: "shutdown",
              })
              yield* Deferred.fail(entry.deferred, new ShutdownError(entry.info.id)).pipe(Effect.ignore)
            }
          }),
        )
        return pending
      }),
    )

    const resolve = Effect.fn("ControlRequestRegistry.resolve")(function* (input: ResolveInput) {
      const pending = yield* InstanceState.get(state)
      const entry = pending.get(input.requestID)
      if (!entry) return false
      pending.delete(input.requestID)
      yield* Deferred.succeed(entry.deferred, input.response).pipe(Effect.ignore)
      return true
    })

    const cancel = Effect.fn("ControlRequestRegistry.cancel")(function* (requestID: ControlRequestID) {
      const pending = yield* InstanceState.get(state)
      const entry = pending.get(requestID)
      if (!entry) return false
      pending.delete(requestID)
      yield* bus.publish(Event.Cancelled, {
        id: entry.info.id,
        sessionID: entry.info.sessionID,
        reason: "cancelled",
      })
      yield* Deferred.fail(entry.deferred, new CancelledError(entry.info.id)).pipe(Effect.ignore)
      return true
    })

    const resolveForSession = Effect.fn("ControlRequestRegistry.resolveForSession")(function* (
      input: ResolveForSessionInput,
    ) {
      const pending = yield* InstanceState.get(state)
      const entry = pending.get(input.requestID)
      if (!entry) return false
      if (entry.info.sessionID !== input.sessionID) return false
      if (entry.info.subtype !== input.subtype) return false
      return yield* resolve({
        requestID: input.requestID,
        response: input.response,
      })
    })

    const cancelForSession = Effect.fn("ControlRequestRegistry.cancelForSession")(function* (
      input: CancelForSessionInput,
    ) {
      const pending = yield* InstanceState.get(state)
      const entry = pending.get(input.requestID)
      if (!entry) return false
      if (entry.info.sessionID !== input.sessionID) return false
      if (entry.info.subtype !== input.subtype) return false
      return yield* cancel(input.requestID)
    })

    const list = Effect.fn("ControlRequestRegistry.list")(function* (sessionID?: SessionID) {
      const pending = yield* InstanceState.get(state)
      return Array.from(pending.values())
        .filter((entry) => !sessionID || entry.info.sessionID === sessionID)
        .map((entry) => ({
          ...entry.info,
          payload: { ...entry.info.payload },
        }))
    })

    const create = Effect.fn("ControlRequestRegistry.create")(function* (input: CreateInput) {
      const pending = yield* InstanceState.get(state)
      const route = lineage(input.sessionID)
      const info: Request = {
        id: crypto.randomUUID() as ControlRequestID,
        sessionID: route.rootSessionID,
        subtype: input.subtype,
        payload: {
          ...input.payload,
          rootSessionID: route.rootSessionID,
          activeSessionID: route.activeSessionID,
          ...(route.parentSessionID ? { parentSessionID: route.parentSessionID } : {}),
        },
        createdAt: Date.now(),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }
      const deferred = yield* Deferred.make<ControlPayload, TimeoutError | CancelledError | ShutdownError>()
      return yield* Effect.gen(function* () {
        pending.set(info.id, { info, deferred })
        yield* bus.publish(Event.Request, info)
        return yield* Deferred.await(deferred).pipe(
          Effect.raceFirst(
            Effect.sleep(`${info.timeoutMs} millis`).pipe(
              Effect.flatMap(() =>
                Effect.gen(function* () {
                  const entry = pending.get(info.id)
                  if (!entry) {
                    return yield* Deferred.await(deferred)
                  }
                  pending.delete(info.id)
                  yield* bus.publish(Event.Cancelled, {
                    id: entry.info.id,
                    sessionID: entry.info.sessionID,
                    reason: "timeout",
                  })
                  yield* Deferred.fail(entry.deferred, new TimeoutError(entry.info.id)).pipe(Effect.ignore)
                  return yield* Effect.fail(new TimeoutError(entry.info.id))
                }),
              ),
            ),
          ),
        )
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const entry = pending.get(info.id)
            if (!entry) return
            pending.delete(info.id)
            yield* bus.publish(Event.Cancelled, {
              id: entry.info.id,
              sessionID: entry.info.sessionID,
              reason: "cancelled",
            })
            yield* Deferred.fail(entry.deferred, new CancelledError(entry.info.id)).pipe(Effect.ignore)
          }),
        ),
      )
    })

    return Service.of({ create, resolve, cancel, resolveForSession, cancelForSession, list })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as ControlRequestRegistry from "./control-registry"

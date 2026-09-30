import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { Effect, Layer, Context } from "effect"
import z from "zod"
import { Database, NotFoundError, and, asc, desc, eq } from "../storage"
import { MessageV2 } from "./message-v2"
import { CheckpointID, MessageID, SessionID } from "./schema"
import * as Session from "./session"
import { SessionCheckpointTable } from "./session.sql"
import { SessionRunState } from "./run-state"
import { Instance } from "@/project/instance"
import { InstanceRef } from "@/effect/instance-ref"

type CheckpointRow = typeof SessionCheckpointTable.$inferSelect

export const Source = z.enum(["manual", "auto"])
export type Source = z.output<typeof Source>

export const Info = z
  .object({
    id: CheckpointID.zod,
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    label: z.string().optional(),
    source: Source,
    metadata: z.record(z.string(), z.unknown()).optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })
  .meta({ ref: "SessionCheckpoint" })
export type Info = z.output<typeof Info>

export const RewindResult = z
  .object({
    checkpointID: CheckpointID.zod,
    affectedFiles: z.string().array(),
  })
  .meta({ ref: "SessionRewindResult" })
export type RewindResult = z.output<typeof RewindResult>

export const Event = {
  Created: BusEvent.define(
    "session.checkpoint.created",
    z.object({
      sessionID: SessionID.zod,
      checkpoint: Info,
    }),
  ),
  Rewound: BusEvent.define(
    "session.rewound",
    z.object({
      sessionID: SessionID.zod,
      checkpointID: CheckpointID.zod,
      affectedFiles: z.string().array(),
    }),
  ),
}

export interface CreateInput {
  readonly sessionID: SessionID
  readonly messageID?: MessageID
  readonly label?: string
  readonly source: Source
  readonly metadata?: Record<string, unknown>
  readonly allowBusy?: boolean
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly list: (sessionID: SessionID) => Effect.Effect<Info[]>
  readonly rewind: (input: { sessionID: SessionID; checkpointID: CheckpointID }) => Effect.Effect<RewindResult>
}

export class Service extends Context.Service<Service, Interface>()("@cognitio/SessionCheckpoint") {}

function fromRow(row: CheckpointRow): Info {
  return {
    id: row.checkpoint_id,
    sessionID: row.session_id,
    messageID: row.message_id ?? undefined,
    label: row.label ?? undefined,
    source: row.source,
    metadata: row.metadata ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.use(fn))

export const layer: Layer.Layer<
  Service,
  never,
  Bus.Service | Snapshot.Service | Session.Service | SessionRunState.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const snapshot = yield* Snapshot.Service
    const session = yield* Session.Service
    const state = yield* SessionRunState.Service
    const inSessionInstance = Effect.fn("SessionCheckpoint.inSessionInstance")(function* <A, E, R>(
      info: Session.Info,
      effect: Effect.Effect<A, E, R>,
    ) {
      const ctx = yield* Effect.promise(() =>
        Instance.provide({ directory: info.directory, fn: () => Instance.current }),
      )
      return yield* effect.pipe(Effect.provideService(InstanceRef, ctx))
    })

    const create = Effect.fn("SessionCheckpoint.create")(function* (input: CreateInput) {
      const info = yield* session.get(input.sessionID)
      if (!input.allowBusy) yield* state.assertNotBusy(input.sessionID)

      const tree = yield* inSessionInstance(info, snapshot.track())
      if (!tree) throw new Error("File checkpointing is disabled or unavailable")
      yield* inSessionInstance(info, snapshot.pin(tree))

      if (input.source === "auto") {
        const latest = yield* db((d) =>
          d
            .select()
            .from(SessionCheckpointTable)
            .where(eq(SessionCheckpointTable.session_id, input.sessionID))
            .orderBy(desc(SessionCheckpointTable.time_created), desc(SessionCheckpointTable.checkpoint_id))
            .limit(1)
            .get(),
        )
        if (latest?.snapshot === tree) {
          yield* inSessionInstance(info, snapshot.pin(latest.snapshot))
          return fromRow(latest)
        }
      }

      const now = Date.now()
      const messageID = input.messageID ?? (yield* MessageV2.lookupLastMessageID(input.sessionID))
      const row = yield* db((d) =>
        d
          .insert(SessionCheckpointTable)
          .values({
            session_id: input.sessionID,
            checkpoint_id: CheckpointID.ascending(),
            message_id: messageID ?? null,
            snapshot: tree,
            label: input.label ?? null,
            source: input.source,
            metadata: input.metadata,
            time_created: now,
            time_updated: now,
          })
          .returning()
          .get(),
      )
      const checkpoint = fromRow(row)
      yield* bus.publish(Event.Created, { sessionID: input.sessionID, checkpoint })
      return checkpoint
    })

    const list = Effect.fn("SessionCheckpoint.list")(function* (sessionID: SessionID) {
      yield* session.get(sessionID)
      const rows = yield* db((d) =>
        d
          .select()
          .from(SessionCheckpointTable)
          .where(eq(SessionCheckpointTable.session_id, sessionID))
          .orderBy(asc(SessionCheckpointTable.time_created), asc(SessionCheckpointTable.checkpoint_id))
          .all(),
      )
      return rows.map(fromRow)
    })

    const rewind = Effect.fn("SessionCheckpoint.rewind")(function* (input: {
      sessionID: SessionID
      checkpointID: CheckpointID
    }) {
      const info = yield* session.get(input.sessionID)
      yield* state.assertNotBusy(input.sessionID)

      const row = yield* db((d) =>
        d
          .select()
          .from(SessionCheckpointTable)
          .where(
            and(
              eq(SessionCheckpointTable.session_id, input.sessionID),
              eq(SessionCheckpointTable.checkpoint_id, input.checkpointID),
            ),
          )
          .get(),
      )
      if (!row) throw new NotFoundError({ message: `Checkpoint not found: ${input.checkpointID}` })

      yield* inSessionInstance(info, snapshot.pin(row.snapshot))
      const patch = yield* inSessionInstance(info, snapshot.patch(row.snapshot))
      yield* inSessionInstance(info, snapshot.revert([patch]))
      yield* session.touch(input.sessionID)
      yield* bus.publish(Event.Rewound, {
        sessionID: input.sessionID,
        checkpointID: input.checkpointID,
        affectedFiles: patch.files,
      })
      return { checkpointID: input.checkpointID, affectedFiles: patch.files }
    })

    return Service.of({ create, list, rewind })
  }),
)

export const defaultLayer: Layer.Layer<Service> = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionRunState.defaultLayer),
  ),
)

export * as SessionCheckpoint from "./checkpoint"

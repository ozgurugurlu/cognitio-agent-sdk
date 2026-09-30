import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { SessionCheckpoint } from "@/session"
import { CheckpointID, MessageID, SessionID } from "@/session/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const RewindInput = z
  .object({
    checkpointID: CheckpointID.zod,
  })
  .meta({ ref: "SessionRewindInput" })

export const CheckpointRoutes = lazy(() =>
  new Hono()
    .post(
      "/:sessionID/checkpoint",
      describeRoute({
        summary: "Create session checkpoint",
        description: "Create a durable file checkpoint for a session.",
        operationId: "session.checkpoint",
        responses: {
          200: {
            description: "Created checkpoint",
            content: {
              "application/json": {
                schema: resolver(SessionCheckpoint.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          messageID: MessageID.zod.optional(),
          label: z.string().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("CheckpointRoutes.create", c, function* () {
          const params = c.req.valid("param")
          const body = c.req.valid("json")
          const checkpoint = yield* SessionCheckpoint.Service
          return yield* checkpoint.create({
            sessionID: params.sessionID,
            messageID: body.messageID,
            label: body.label,
            source: "manual",
          })
        }),
    )
    .get(
      "/:sessionID/checkpoints",
      describeRoute({
        summary: "List session checkpoints",
        description: "List durable file checkpoints for a session in chronological order.",
        operationId: "session.checkpoints",
        responses: {
          200: {
            description: "List of checkpoints",
            content: {
              "application/json": {
                schema: resolver(SessionCheckpoint.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("CheckpointRoutes.list", c, function* () {
          const checkpoint = yield* SessionCheckpoint.Service
          return yield* checkpoint.list(c.req.valid("param").sessionID)
        }),
    )
    .post(
      "/:sessionID/rewind",
      describeRoute({
        summary: "Rewind session files",
        description: "Rewind the working tree files to a durable session checkpoint.",
        operationId: "session.rewind",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SessionRewindInput" },
            },
          },
        },
        responses: {
          200: {
            description: "Rewind result",
            content: {
              "application/json": {
                schema: resolver(SessionCheckpoint.RewindResult),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", RewindInput),
      async (c) =>
        jsonRequest("CheckpointRoutes.rewind", c, function* () {
          const params = c.req.valid("param")
          const body = c.req.valid("json")
          const checkpoint = yield* SessionCheckpoint.Service
          return yield* checkpoint.rewind({
            sessionID: params.sessionID,
            checkpointID: body.checkpointID,
          })
        }),
    ),
)

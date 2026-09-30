import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Session } from "@/session"
import { ControlRequestRegistry } from "@/session/control-registry"
import { SessionID } from "@/session/schema"
import { lazy } from "@/util/lazy"
import { errors } from "../../error"
import { jsonRequest } from "./trace"

export const ControlResponseBody = z
  .object({
    requestID: ControlRequestRegistry.ControlRequestID,
    subtype: ControlRequestRegistry.ControlSubtype,
    response: ControlRequestRegistry.ControlPayload,
  })
  .meta({ ref: "ControlResponseBody" })

export const ControlCancelBody = z
  .object({
    requestID: ControlRequestRegistry.ControlRequestID,
    subtype: ControlRequestRegistry.ControlSubtype,
  })
  .meta({ ref: "ControlCancelBody" })

export const ControlRoutes = lazy(() =>
  new Hono()
    .post(
      "/:sessionID/control-response",
      describeRoute({
        summary: "Respond to control request",
        description: "Resolve a pending SDK control-channel request for a session.",
        operationId: "session.controlChannel.response",
        tags: ["Session"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ControlResponseBody" },
            },
          },
        },
        responses: {
          200: {
            description: "Control request response status",
            content: {
              "application/json": {
                schema: resolver(z.object({ resolved: z.boolean() })),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator("json", ControlResponseBody),
      async (c) =>
        jsonRequest("ControlRoutes.response", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          yield* Session.Service.use((svc) => svc.get(sessionID))
          const resolved = yield* ControlRequestRegistry.Service.use((svc) =>
            svc.resolveForSession({
              sessionID,
              requestID: body.requestID,
              subtype: body.subtype,
              response: body.response,
            }),
          )
          return { resolved }
        }),
    )
    .post(
      "/:sessionID/control-cancel",
      describeRoute({
        summary: "Cancel control request",
        description: "Cancel a pending SDK control-channel request for a session.",
        operationId: "session.controlChannel.cancel",
        tags: ["Session"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ControlCancelBody" },
            },
          },
        },
        responses: {
          200: {
            description: "Control request cancellation status",
            content: {
              "application/json": {
                schema: resolver(z.object({ cancelled: z.boolean() })),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator("json", ControlCancelBody),
      async (c) =>
        jsonRequest("ControlRoutes.cancel", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          yield* Session.Service.use((svc) => svc.get(sessionID))
          const cancelled = yield* ControlRequestRegistry.Service.use((svc) =>
            svc.cancelForSession({
              sessionID,
              requestID: body.requestID,
              subtype: body.subtype,
            }),
          )
          return { cancelled }
        }),
    )
    .get(
      "/:sessionID/control-requests",
      describeRoute({
        summary: "List control requests",
        description: "List pending SDK control-channel requests for a session.",
        operationId: "session.controlChannel.list",
        tags: ["Session"],
        responses: {
          200: {
            description: "Pending control requests",
            content: {
              "application/json": {
                schema: resolver(ControlRequestRegistry.Request.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) =>
        jsonRequest("ControlRoutes.list", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          yield* Session.Service.use((svc) => svc.get(sessionID))
          return yield* ControlRequestRegistry.Service.use((svc) => svc.list(sessionID))
        }),
    ),
)

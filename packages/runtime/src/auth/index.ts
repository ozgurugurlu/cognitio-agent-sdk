import path from "path"
import { Effect, Layer, Option, Record, Result, Schema, Context } from "effect"
import { zod } from "@/util/effect-zod"
import { Flag } from "@/flag/flag"
import { Global } from "../global"
import { AppFileSystem } from "@cognitio/shared/filesystem"

export const OAUTH_DUMMY_KEY = "cognitio-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

const _Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export const Info = Object.assign(_Info, { zod: zod(_Info) })
export type Info = Schema.Schema.Type<typeof _Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@cognitio/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const decode = Schema.decodeUnknownOption(Info)

    // Under isolation the host auth.json is never touched, but credentials
    // must still be mutable in-process so transparent OAuth refresh (Codex/MCP
    // plugins call auth.set after rotating a token) persists for the server's
    // lifetime. This overlay lives and dies with the process — no host write.
    const isolatedOverlay = new Map<string, Info>()
    const isolatedRemovals = new Set<string>()

    // Isolated servers treat COGNITIO_AUTH_CONTENT as the sole authority: any
    // malformed payload or undecodable entry is a typed error instead of a
    // silent fallback to the host auth.json. Non-isolated servers keep the file
    // semantics (drop undecodable entries, fall back to the file on bad JSON).
    const fromContent = Effect.fnUntraced(function* (content: string) {
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch (cause) {
        if (Flag.COGNITIO_ISOLATED)
          return yield* Effect.fail(new AuthError({ message: "COGNITIO_AUTH_CONTENT is not valid JSON", cause }))
        return undefined
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        if (Flag.COGNITIO_ISOLATED)
          return yield* Effect.fail(new AuthError({ message: "COGNITIO_AUTH_CONTENT must be a JSON object of credentials" }))
        return undefined
      }
      const entries = parsed as Record<string, unknown>
      if (!Flag.COGNITIO_ISOLATED)
        return Record.filterMap(entries, (value) => Result.fromOption(decode(value), () => undefined))
      const out: Record<string, Info> = {}
      for (const [key, value] of Object.entries(entries)) {
        const item = decode(value)
        if (Option.isNone(item))
          return yield* Effect.fail(
            new AuthError({ message: `COGNITIO_AUTH_CONTENT entry "${key}" is not a valid credential` }),
          )
        out[key] = item.value
      }
      return out
    })

    const applyOverlay = (base: Record<string, Info>) => {
      if (!Flag.COGNITIO_ISOLATED) return base
      const next = { ...base }
      for (const key of isolatedRemovals) delete next[key]
      for (const [key, value] of isolatedOverlay) next[key] = value
      return next
    }

    const all = Effect.fn("Auth.all")(function* () {
      const content = process.env.COGNITIO_AUTH_CONTENT
      // Fail-closed: isolated servers never read the host auth.json — the
      // env content (strictly decoded) plus the in-process overlay is the only
      // store. A present-but-empty COGNITIO_AUTH_CONTENT is malformed, not
      // "absent", so it surfaces a typed error like any other bad payload.
      if (Flag.COGNITIO_ISOLATED) {
        if (content !== undefined) return applyOverlay((yield* fromContent(content)) ?? {})
        return applyOverlay({})
      }

      if (content) {
        const fromEnv = yield* fromContent(content)
        if (fromEnv) return fromEnv
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      if (Flag.COGNITIO_ISOLATED) {
        // In-process overlay only — never a host write. Shadow any slash /
        // non-normalized variants from the env content too (mirrors the
        // file-path delete semantics below), so a rotate can't leave a stale
        // trailing-slash entry visible through applyOverlay.
        isolatedOverlay.delete(norm + "/")
        isolatedRemovals.add(norm + "/")
        if (norm !== key) {
          isolatedOverlay.delete(key)
          isolatedRemovals.add(key)
        }
        isolatedRemovals.delete(norm)
        isolatedOverlay.set(norm, info)
        return
      }
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      if (Flag.COGNITIO_ISOLATED) {
        isolatedOverlay.delete(key)
        isolatedOverlay.delete(norm)
        // Shadow any env-content entry for the rest of the process lifetime.
        isolatedRemovals.add(key)
        isolatedRemovals.add(norm)
        return
      }
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Auth from "."

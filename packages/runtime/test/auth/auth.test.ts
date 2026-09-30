import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

describe("Auth", () => {
  it.live("set normalizes trailing slashes in keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeDefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set cleans up pre-existing trailing-slash entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "old",
        })
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "new",
        })
        const data = yield* auth.all()
        const keys = Object.keys(data).filter((key) => key.includes("example.com"))
        expect(keys).toEqual(["https://example.com"])
        const entry = data["https://example.com"]!
        expect(entry.type).toBe("wellknown")
        if (entry.type === "wellknown") expect(entry.token).toBe("new")
      }),
    ),
  )

  it.live("remove deletes both trailing-slash and normalized keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        yield* auth.remove("https://example.com/")
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeUndefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set and remove are no-ops on keys without trailing slashes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("anthropic", {
          type: "api",
          key: "sk-test",
        })
        const data = yield* auth.all()
        expect(data["anthropic"]).toBeDefined()
        yield* auth.remove("anthropic")
        const after = yield* auth.all()
        expect(after["anthropic"]).toBeUndefined()
      }),
    ),
  )
})

const withEnv = <A, E, R>(env: Record<string, string | undefined>, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved = new Map<string, string | undefined>()
      for (const [key, value] of Object.entries(env)) {
        saved.set(key, process.env[key])
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return saved
    }),
    () => self,
    (saved) =>
      Effect.sync(() => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )

describe("Auth under COGNITIO_ISOLATED", () => {
  it.live("never reads auth.json and only honors COGNITIO_AUTH_CONTENT", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("filecred", { type: "api", key: "sk-file" })

        const empty = yield* withEnv(
          { COGNITIO_ISOLATED: "1", COGNITIO_AUTH_CONTENT: undefined },
          auth.all(),
        )
        expect(empty).toEqual({})

        const injected = yield* withEnv(
          {
            COGNITIO_ISOLATED: "1",
            COGNITIO_AUTH_CONTENT: JSON.stringify({ anthropic: { type: "api", key: "sk-env" } }),
          },
          auth.all(),
        )
        expect(Object.keys(injected)).toEqual(["anthropic"])
        expect(injected["filecred"]).toBeUndefined()
      }).pipe(Effect.ensuring(Auth.Service.use((auth) => auth.remove("filecred")).pipe(Effect.ignore))),
    ),
  )

  it.live("fails typed on malformed or empty COGNITIO_AUTH_CONTENT", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const malformed = yield* withEnv(
          { COGNITIO_ISOLATED: "1", COGNITIO_AUTH_CONTENT: "{not json" },
          Effect.flip(auth.all()),
        )
        expect(malformed._tag).toBe("AuthError")
        expect(malformed.message).toContain("not valid JSON")

        // present-but-empty is malformed, not "absent"
        const empty = yield* withEnv({ COGNITIO_ISOLATED: "1", COGNITIO_AUTH_CONTENT: "" }, Effect.flip(auth.all()))
        expect(empty._tag).toBe("AuthError")
      }),
    ),
  )

  it.live("rotating a trailing-slash env credential shadows the stale variant", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const data = yield* withEnv(
          {
            COGNITIO_ISOLATED: "1",
            COGNITIO_AUTH_CONTENT: JSON.stringify({
              "https://example.com/": { type: "wellknown", key: "TOKEN", token: "stale" },
            }),
          },
          Effect.gen(function* () {
            // rotate the non-slash form; the stale trailing-slash entry must not linger
            yield* auth.set("https://example.com", { type: "wellknown", key: "TOKEN", token: "fresh" })
            return yield* auth.all()
          }),
        )
        expect(data["https://example.com/"]).toBeUndefined()
        const entry = data["https://example.com"]
        expect(entry?.type).toBe("wellknown")
        if (entry?.type === "wellknown") expect(entry.token).toBe("fresh")
      }),
    ),
  )

  it.live("fails typed on an undecodable credential entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const error = yield* withEnv(
          {
            COGNITIO_ISOLATED: "1",
            COGNITIO_AUTH_CONTENT: JSON.stringify({ anthropic: { type: "bogus" } }),
          },
          Effect.flip(auth.all()),
        )
        expect(error._tag).toBe("AuthError")
        expect(error.message).toContain('entry "anthropic"')
      }),
    ),
  )

  it.live("persists writes in-process without touching the host file", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        // Poison the host file: it must stay untouched by isolated writes.
        yield* auth.set("filecred", { type: "api", key: "sk-file" })

        const overlaid = yield* withEnv(
          { COGNITIO_ISOLATED: "1", COGNITIO_AUTH_CONTENT: JSON.stringify({ openai: { type: "api", key: "sk-env" } }) },
          Effect.gen(function* () {
            // Transparent OAuth refresh path: rotate the injected credential.
            yield* auth.set("openai", { type: "api", key: "sk-rotated" })
            yield* auth.set("added", { type: "api", key: "sk-added" })
            yield* auth.remove("openai")
            yield* auth.set("openai", { type: "oauth", refresh: "r2", access: "a2", expires: 999 })
            return yield* auth.all()
          }),
        )
        // env entry rotated + new entry persisted, all in-process
        expect(overlaid["added"]).toEqual({ type: "api", key: "sk-added" })
        expect(overlaid["openai"]).toEqual({ type: "oauth", refresh: "r2", access: "a2", expires: 999 })
        expect(overlaid["filecred"]).toBeUndefined()

        // host file never mutated by the isolated writes
        const hostView = yield* auth.all()
        expect(hostView["filecred"]).toEqual({ type: "api", key: "sk-file" })
        expect(hostView["added"]).toBeUndefined()
      }).pipe(Effect.ensuring(Auth.Service.use((auth) => auth.remove("filecred")).pipe(Effect.ignore))),
    ),
  )
})

describe("Auth env content without isolation", () => {
  it.live("drops undecodable entries instead of passing them through raw", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const data = yield* withEnv(
          {
            COGNITIO_ISOLATED: undefined,
            COGNITIO_AUTH_CONTENT: JSON.stringify({
              good: { type: "api", key: "sk-good" },
              bad: { type: "bogus" },
            }),
          },
          auth.all(),
        )
        expect(Object.keys(data)).toEqual(["good"])
      }),
    ),
  )

  it.live("falls back to the file on malformed content", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("filecred", { type: "api", key: "sk-file" })
        const data = yield* withEnv(
          { COGNITIO_ISOLATED: undefined, COGNITIO_AUTH_CONTENT: "{oops" },
          auth.all(),
        )
        expect(data["filecred"]).toBeDefined()
      }).pipe(Effect.ensuring(Auth.Service.use((auth) => auth.remove("filecred")).pipe(Effect.ignore))),
    ),
  )
})

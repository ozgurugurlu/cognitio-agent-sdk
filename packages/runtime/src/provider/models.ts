import { Global } from "../global"
import { Log } from "../util"
import path from "path"
import z from "zod"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { lazy } from "@/util/lazy"
import { Filesystem } from "../util"
import { Flock } from "@cognitio/shared/util/flock"
import { Hash } from "@cognitio/shared/util/hash"

// Try to import bundled snapshot (generated at build time)
// Falls back to undefined in dev mode when snapshot doesn't exist
/* @ts-ignore */

const log = Log.create({ service: "models.dev" })
const source = url()
const filepath = path.join(
  Global.Path.cache,
  source === "https://models.dev" ? "models.json" : `models-${Hash.fast(source)}.json`,
)
const ttl = 5 * 60 * 1000

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[]

const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(z.string(), JsonValue)]),
)

const Cost = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
  context_over_200k: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cache_read: z.number().nonnegative().optional(),
      cache_write: z.number().nonnegative().optional(),
    })
    .optional(),
})

export const Model = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  release_date: z.string(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
  temperature: z.boolean().default(false),
  tool_call: z.boolean(),
  interleaved: z
    .union([
      z.literal(true),
      z
        .object({
          field: z.enum(["reasoning_content", "reasoning_details"]),
        })
        .strict(),
    ])
    .optional(),
  cost: Cost.optional(),
  limit: z.object({
    context: z.number().nonnegative(),
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative(),
  }),
  modalities: z
    .object({
      input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
    })
    .optional(),
  experimental: z
    .object({
      modes: z
        .record(
          z.string(),
          z.object({
            cost: Cost.optional(),
            provider: z
              .object({
                body: z.record(z.string(), JsonValue).optional(),
                headers: z.record(z.string(), z.string()).optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
})
export type Model = z.infer<typeof Model>

export const Provider = z.object({
  api: z.string().optional(),
  name: z.string(),
  env: z.array(z.string()),
  id: z.string(),
  npm: z.string().optional(),
  models: z.record(z.string(), Model),
})

export type Provider = z.infer<typeof Provider>

export const Catalog = z.record(z.string(), Provider)
let generation = 0
export const revision = () => generation

/** Validate data before it can influence model limits or billing. */
export function parseCatalog(value: unknown) {
  const providers = z.record(z.string(), z.unknown()).parse(value)
  return Catalog.parse(
    Object.fromEntries(
      Object.entries(providers).filter(([id]) => !["opencode", "opencode-go", "cognitio", "cognitio-go"].includes(id)),
    ),
  )
}

function url() {
  return Flag.COGNITIO_MODELS_URL || "https://models.dev"
}

function fresh() {
  return Date.now() - Number(Filesystem.stat(filepath)?.mtimeMs ?? 0) < ttl
}

function skip(force: boolean) {
  return !force && fresh()
}

const fetchApi = async () => {
  const result = await fetch(`${url()}/api.json`, {
    headers: { "User-Agent": Installation.USER_AGENT },
    signal: AbortSignal.timeout(10000),
  })
  return { ok: result.ok, text: await result.text() }
}

export const Data = lazy(async () => {
  const result = await Filesystem.readJson(Flag.COGNITIO_MODELS_PATH ?? filepath).catch(() => {})
  if (result) return parseCatalog(result)
  // @ts-ignore
  const snapshot = await import("./models-snapshot.js")
    .then((m) => m.snapshot as Record<string, unknown>)
    .catch(() => undefined)
  if (snapshot) return parseCatalog(snapshot)
  if (Flag.COGNITIO_DISABLE_MODELS_FETCH) return {}
  return Flock.withLock(`models-dev:${filepath}`, async () => {
    const result = await Filesystem.readJson(Flag.COGNITIO_MODELS_PATH ?? filepath).catch(() => {})
    if (result) return parseCatalog(result)
    const result2 = await fetchApi()
    if (!result2.ok) throw new Error("Failed to fetch model catalog")
    const parsed = parseCatalog(JSON.parse(result2.text))
    if (result2.ok) {
      await Filesystem.write(filepath, JSON.stringify(parsed)).catch((e) => {
        log.error("Failed to write models cache", { error: e })
      })
    }
    return parsed
  })
})

export async function get() {
  const result = await Data()
  return result
}

export async function refresh(force = false) {
  const reset = () => {
    Data.reset()
    generation++
  }
  if (skip(force)) return reset()
  await Flock.withLock(`models-dev:${filepath}`, async () => {
    if (skip(force)) return reset()
    const result = await fetchApi()
    if (!result.ok) return
    const parsed = parseCatalog(JSON.parse(result.text))
    await Filesystem.write(filepath, JSON.stringify(parsed))
    reset()
  }).catch((e) => {
    log.error("Failed to fetch models.dev", {
      error: e,
    })
  })
}

if (!Flag.COGNITIO_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
  void refresh()
  setInterval(
    async () => {
      await refresh()
    },
    60 * 1000 * 60,
  ).unref()
}

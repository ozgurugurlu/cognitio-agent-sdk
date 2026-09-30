import { createHash } from "node:crypto"
import { InstanceState } from "@/effect"
import { Provider } from "@/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context } from "effect"
import type { SessionRuntimeConfig } from "@/session/runtime-config"
import { generateObject } from "ai"
import z from "zod"

const TTL_MS = 5 * 60 * 1000
const TIMEOUT = "10 seconds"
const ERROR_RESULT: ClassifierResult = { decision: "ask", confidence: 0, reason: "classifier-error" }
const ResultSchema = z.object({
  decision: z.enum(["allow", "deny", "ask"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
})

export interface ClassifierInput {
  toolName: string
  toolInput: unknown
  sessionID: string
  cwd: string
  recentContext: string
}

export interface ClassifierResult {
  decision: "allow" | "deny" | "ask"
  confidence: number
  reason: string
}

export interface Interface {
  readonly classify: (
    input: ClassifierInput,
    model?: SessionRuntimeConfig.RuntimeConfig["autoPermissionClassifierModel"],
  ) => Effect.Effect<ClassifierResult>
}

export class Service extends Context.Service<Service, Interface>()("@cognitio/PermissionClassifier") {}

export const layer: Layer.Layer<Service, never, Provider.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const state = yield* InstanceState.make(
      Effect.fn("PermissionClassifier.state")(() =>
        Effect.succeed(new Map<string, { expires: number; result: ClassifierResult }>()),
      ),
    )

    const classify = Effect.fn("PermissionClassifier.classify")(function* (
      input: ClassifierInput,
      model?: SessionRuntimeConfig.RuntimeConfig["autoPermissionClassifierModel"],
    ) {
      const cache = yield* InstanceState.get(state)
      const key = hash(input, model)
      const cached = cache.get(key)
      if (cached && cached.expires > Date.now()) return cached.result
      const result = yield* generate(input, yield* resolveModel(provider, model), provider).pipe(
        Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.succeed(ERROR_RESULT) }),
        Effect.catchCause(() => Effect.succeed(ERROR_RESULT)),
      )
      cache.set(key, { expires: Date.now() + TTL_MS, result })
      return result
    })

    return Service.of({ classify })
  }),
)

const resolveModel = Effect.fn("PermissionClassifier.resolveModel")(function* (
  provider: Provider.Interface,
  model?: SessionRuntimeConfig.RuntimeConfig["autoPermissionClassifierModel"],
) {
  if (model) return yield* provider.getModel(ProviderID.make(model.providerID), ModelID.make(model.modelID))
  const defaults = yield* provider.defaultModel()
  return (yield* provider.getSmallModel(defaults.providerID)) ?? (yield* provider.getModel(defaults.providerID, defaults.modelID))
})

const generate = Effect.fn("PermissionClassifier.generate")(function* (
  input: ClassifierInput,
  model: Provider.Model,
  provider: Provider.Interface,
) {
  const language = yield* provider.getLanguage(model)
  const result = yield* Effect.promise(() =>
    generateObject({
      model: language,
      schema: ResultSchema,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "Classify whether a tool request should be allowed automatically, denied automatically, or sent to the user.",
            "Allow only clearly read-only and low-risk actions.",
            "Deny clearly destructive, credential-exposing, privilege-escalating, or policy-bypassing actions.",
            "Use ask when uncertain. Return concise reasons.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            toolName: input.toolName,
            toolInput: truncate(JSON.stringify(stable(input.toolInput))),
            cwd: input.cwd,
            recentContext: truncate(input.recentContext),
          }),
        },
      ],
    }).then((output) => output.object),
  )
  return ResultSchema.parse(result)
})

function hash(input: ClassifierInput, model?: SessionRuntimeConfig.RuntimeConfig["autoPermissionClassifierModel"]) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        toolName: input.toolName,
        toolInput: stable(input.toolInput),
        cwd: input.cwd,
        recentContext: input.recentContext,
        model,
      }),
    )
    .digest("hex")
}

function truncate(input: string) {
  if (input.length <= 6_000) return input
  return input.slice(0, 6_000)
}

function stable(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(stable)
  if (!isRecord(input)) return input
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, stable(value)]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export const defaultLayer = layer.pipe(Layer.provide(Provider.defaultLayer))

export * as PermissionClassifier from "./classifier"

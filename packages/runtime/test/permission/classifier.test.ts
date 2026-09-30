import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import { Effect, Layer } from "effect"
import { PermissionClassifier, type ClassifierResult } from "../../src/permission/classifier"
import { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance } from "../fixture/fixture"

describe("PermissionClassifier", () => {
  test("uses the configured provider model and caches results", async () => {
    const calls: LanguageModelV3CallOptions[] = []
    const model = ProviderTest.model({ id: ModelID.make("classifier"), providerID: ProviderID.make("test") })
    const alternate = ProviderTest.model({ id: ModelID.make("classifier-alt"), providerID: ProviderID.make("test") })
    const fake = ProviderTest.fake({
      model,
      getModel: Effect.fn("TestProvider.getModel")((providerID, modelID) => {
        if (providerID === ProviderID.make("test") && modelID === ModelID.make("classifier")) return Effect.succeed(model)
        if (providerID === ProviderID.make("test") && modelID === ModelID.make("classifier-alt")) {
          return Effect.succeed(alternate)
        }
        return Effect.die(new Error(`Unknown test model: ${providerID}/${modelID}`))
      }),
      getLanguage: Effect.fn("TestProvider.getLanguage")((input) => Effect.succeed(language(input.id, calls, {
        decision: input.id === ModelID.make("classifier-alt") ? "ask" : "allow",
        confidence: input.id === ModelID.make("classifier-alt") ? 0.4 : 0.91,
        reason: input.id === ModelID.make("classifier-alt") ? "alternate-model" : "read-only",
      }))),
    })

    const result = await run(
      fake.layer,
      Effect.gen(function* () {
        const classifier = yield* PermissionClassifier.Service
        const input = {
          toolName: "read",
          toolInput: { filePath: "README.md" },
          sessionID: "session_test",
          cwd: "/tmp/project",
          recentContext: "read docs",
        }
        const first = yield* classifier.classify(input, { providerID: "test", modelID: "classifier" })
        const second = yield* classifier.classify(input, { providerID: "test", modelID: "classifier" })
        const third = yield* classifier.classify(input, { providerID: "test", modelID: "classifier-alt" })
        return { first, second, third }
      }),
    )

    expect(result.first).toEqual({ decision: "allow", confidence: 0.91, reason: "read-only" })
    expect(result.second).toEqual(result.first)
    expect(result.third).toEqual({ decision: "ask", confidence: 0.4, reason: "alternate-model" })
    expect(calls).toHaveLength(2)
  })

  test("falls back to ask on provider failure", async () => {
    const model = ProviderTest.model({ id: ModelID.make("classifier"), providerID: ProviderID.make("test") })
    const fake = ProviderTest.fake({
      model,
      getLanguage: Effect.fn("TestProvider.getLanguage")(() =>
        Effect.succeed({
          ...language("classifier", [], { decision: "ask", confidence: 0, reason: "unused" }),
          doGenerate: async () => {
            throw new Error("provider failed")
          },
        }),
      ),
    })

    const result = await run(
      fake.layer,
      Effect.gen(function* () {
        const classifier = yield* PermissionClassifier.Service
        return yield* classifier.classify({
          toolName: "bash",
          toolInput: { command: "npm test" },
          sessionID: "session_test",
          cwd: "/tmp/project",
          recentContext: "",
        })
      }),
    )

    expect(result).toEqual({ decision: "ask", confidence: 0, reason: "classifier-error" })
  })
})

function language(modelId: string, calls: LanguageModelV3CallOptions[], result: ClassifierResult): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      calls.push(options)
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      }
    },
    async doStream(): Promise<LanguageModelV3StreamResult> {
      throw new Error("streaming not used")
    },
  }
}

function run<A, E>(provider: Layer.Layer<Provider.Service, E>, effect: Effect.Effect<A, E, PermissionClassifier.Service>) {
  return Effect.runPromise(
    provideTmpdirInstance(() => effect).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(PermissionClassifier.layer.pipe(Layer.provide(provider)), CrossSpawnSpawner.defaultLayer)),
    ),
  )
}

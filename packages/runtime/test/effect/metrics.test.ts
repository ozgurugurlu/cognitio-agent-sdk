import { describe, expect, test } from "bun:test"
import { Effect, Metric } from "effect"
import { SessionMetrics } from "../../src/effect/metrics"

// Counters live in the process-global registry and never reset, so every
// test uses unique attribute values (model/provider names) instead of
// absolute assertions.

let seq = 0
function ids() {
  seq += 1
  return { providerID: `prov-${seq}`, modelID: `model-${seq}` }
}

const tokens = (input: Partial<SessionMetrics.UsageTokens> = {}): SessionMetrics.UsageTokens => ({
  input: input.input ?? 0,
  output: input.output ?? 0,
  reasoning: input.reasoning ?? 0,
  cache: { read: input.cache?.read ?? 0, write: input.cache?.write ?? 0 },
})

const read = (counter: (typeof SessionMetrics.counters)["tokenUsage"], attributes: Record<string, string>) =>
  Metric.value(Metric.withAttributes(counter, attributes))

describe("effect.metrics", () => {
  test("records disjoint token types with output including reasoning", async () => {
    const { providerID, modelID } = ids()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* SessionMetrics.recordModelUsage({
          providerID,
          modelID,
          tokens: tokens({ input: 100, output: 40, reasoning: 10, cache: { read: 7, write: 3 } }),
          cost: 0.5,
          sessionID: "ses_test",
        })
        const base = { provider: providerID, model: modelID }
        const input = yield* read(SessionMetrics.counters.tokenUsage, { ...base, type: "input" })
        const output = yield* read(SessionMetrics.counters.tokenUsage, { ...base, type: "output" })
        const cacheRead = yield* read(SessionMetrics.counters.tokenUsage, { ...base, type: "cacheRead" })
        const cacheWrite = yield* read(SessionMetrics.counters.tokenUsage, { ...base, type: "cacheWrite" })
        const cost = yield* read(SessionMetrics.counters.costUsage, base)
        expect(input.count).toBe(100)
        expect(output.count).toBe(50)
        expect(cacheRead.count).toBe(7)
        expect(cacheWrite.count).toBe(3)
        expect(cost.count).toBe(0.5)
      }),
    )
  })

  test("skips zero token types and zero cost", async () => {
    const { providerID, modelID } = ids()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* SessionMetrics.recordModelUsage({
          providerID,
          modelID,
          tokens: tokens({ input: 5 }),
          cost: 0,
        })
        const base = { provider: providerID, model: modelID }
        const input = yield* read(SessionMetrics.counters.tokenUsage, { ...base, type: "input" })
        const output = yield* read(SessionMetrics.counters.tokenUsage, { ...base, type: "output" })
        const cost = yield* read(SessionMetrics.counters.costUsage, base)
        expect(input.count).toBe(5)
        expect(output.count).toBe(0)
        expect(cost.count).toBe(0)
      }),
    )
  })

  test("accumulates across calls", async () => {
    const { providerID, modelID } = ids()
    await Effect.runPromise(
      Effect.gen(function* () {
        const record = SessionMetrics.recordModelUsage({
          providerID,
          modelID,
          tokens: tokens({ input: 10 }),
          cost: 0.25,
        })
        yield* record
        yield* record
        const base = { provider: providerID, model: modelID }
        const input = yield* read(SessionMetrics.counters.tokenUsage, { ...base, type: "input" })
        const cost = yield* read(SessionMetrics.counters.costUsage, base)
        expect(input.count).toBe(20)
        expect(cost.count).toBe(0.5)
      }),
    )
  })

  test("omits session.id by default and includes it with OTEL_METRICS_INCLUDE_SESSION_ID", async () => {
    const first = ids()
    const second = ids()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* SessionMetrics.recordModelUsage({
            providerID: first.providerID,
            modelID: first.modelID,
            tokens: tokens({ input: 1 }),
            cost: 0,
            sessionID: "ses_default",
          })
          const bare = yield* read(SessionMetrics.counters.tokenUsage, {
            provider: first.providerID,
            model: first.modelID,
            type: "input",
          })
          expect(bare.count).toBe(1)

          process.env.OTEL_METRICS_INCLUDE_SESSION_ID = "1"
          yield* SessionMetrics.recordModelUsage({
            providerID: second.providerID,
            modelID: second.modelID,
            tokens: tokens({ input: 1 }),
            cost: 0,
            sessionID: "ses_tagged",
          })
          const tagged = yield* read(SessionMetrics.counters.tokenUsage, {
            provider: second.providerID,
            model: second.modelID,
            "session.id": "ses_tagged",
            type: "input",
          })
          expect(tagged.count).toBe(1)
          const untagged = yield* read(SessionMetrics.counters.tokenUsage, {
            provider: second.providerID,
            model: second.modelID,
            type: "input",
          })
          expect(untagged.count).toBe(0)
        }),
      )
    } finally {
      delete process.env.OTEL_METRICS_INCLUDE_SESSION_ID
    }
  })

  test("records rate limit hits by provider", async () => {
    const { providerID } = ids()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* SessionMetrics.recordRateLimit({ provider: providerID })
        yield* SessionMetrics.recordRateLimit({ provider: providerID })
        const value = yield* read(SessionMetrics.counters.rateLimitCount, { provider: providerID })
        expect(value.count).toBe(2)
      }),
    )
  })

  test("records session creations", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* Metric.value(SessionMetrics.counters.sessionCount)
        yield* SessionMetrics.recordSession()
        const after = yield* Metric.value(SessionMetrics.counters.sessionCount)
        expect(Number(after.count) - Number(before.count)).toBe(1)
      }),
    )
  })
})

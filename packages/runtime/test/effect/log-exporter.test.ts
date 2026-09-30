import { expect, test } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpSerialization } from "effect/unstable/observability"
import * as LogExporter from "../../src/effect/log-exporter"

type Batch = {
  resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string; value: { intValue?: number } }[] }[] }[] }[]
}

const counts = (batches: Batch[]) =>
  batches
    .flatMap((batch) => batch.resourceLogs)
    .flatMap((resource) => resource.scopeLogs)
    .flatMap((scope) => scope.logRecords)
    .map((record) => record.attributes.find((attribute) => attribute.key === "count")?.value.intValue)

const dependencies = Layer.merge(FetchHttpClient.layer, OtlpSerialization.layerJson)

test("batch shutdown waits through an in-flight transient failure and retry before flushing the remainder", async () => {
  const batches: Batch[] = []
  let attempts = 0
  using collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const batch = (await request.json()) as Batch
      attempts++
      if (attempts === 1) return new Response("retry", { status: 503 })
      batches.push(batch)
      return Response.json({})
    },
  })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const exporter = yield* LogExporter.make({
          url: `http://127.0.0.1:${collector.port}/v1/logs`,
          resource: { serviceName: "logger-retry-test" },
          exportInterval: 60_000,
          maxBatchSize: 1000,
          shutdownTimeout: "3 seconds",
        })
        yield* Effect.forEach(
          Array.from({ length: 1001 }, (_, index) => index),
          (count) => Effect.logInfo("batch retry test").pipe(Effect.annotateLogs({ count })),
        ).pipe(Effect.provide(Logger.layer([exporter], { mergeWithExisting: false })))
      }),
    ).pipe(Effect.provide(dependencies)),
  )
  expect(attempts).toBe(3)
  expect(counts(batches).sort((a, b) => a! - b!)).toEqual(Array.from({ length: 1001 }, (_, index) => index))
}, 10_000)

test("a final-buffer retry uses only the shutdown budget remaining after an in-flight batch", async () => {
  const received = Promise.withResolvers<void>()
  let requests = 0
  using collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.text()
      requests++
      if (requests > 1) return new Response("retry", { status: 503 })
      received.resolve()
      await Bun.sleep(200)
      return Response.json({})
    },
  })
  let shutdownStarted = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const exporter = yield* LogExporter.make({
          url: `http://127.0.0.1:${collector.port}/v1/logs`,
          resource: { serviceName: "logger-retry-deadline-test" },
          exportInterval: 60_000,
          maxBatchSize: 2,
          shutdownTimeout: 300,
        })
        yield* Effect.forEach(Array.from({ length: 3 }), () => Effect.logInfo("bounded retry shutdown")).pipe(
          Effect.provide(Logger.layer([exporter], { mergeWithExisting: false })),
        )
        yield* Effect.promise(() => received.promise)
        shutdownStarted = Date.now()
      }),
    ).pipe(Effect.provide(dependencies)),
  )
  // A fresh finalizer budget would take about 500 ms: 200 ms to drain,
  // followed by another 300 ms waiting in the residual batch's retry schedule.
  expect(Date.now() - shutdownStarted).toBeLessThan(450)
  expect(requests).toBe(2)
  await Bun.sleep(1100)
  expect(requests).toBe(2)
}, 10_000)

test("periodic batches finish before closing their exporter scope", async () => {
  const received = Promise.withResolvers<void>()
  const batches: Batch[] = []
  using collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const batch = (await request.json()) as Batch
      received.resolve()
      await Bun.sleep(50)
      batches.push(batch)
      return Response.json({})
    },
  })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const exporter = yield* LogExporter.make({
          url: `http://127.0.0.1:${collector.port}/v1/logs`,
          resource: { serviceName: "logger-periodic-test" },
          exportInterval: 5,
          maxBatchSize: 1000,
          shutdownTimeout: "1 second",
        })
        yield* Effect.logInfo("periodic test").pipe(
          Effect.annotateLogs({ count: 42 }),
          Effect.provide(Logger.layer([exporter], { mergeWithExisting: false })),
        )
        yield* Effect.promise(() => received.promise)
      }),
    ).pipe(Effect.provide(dependencies)),
  )
  expect(counts(batches)).toEqual([42])
}, 10_000)

test("a stalled batch and residual buffer share one shutdown deadline without starting a late request", async () => {
  const release = Promise.withResolvers<void>()
  let requests = 0
  using collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.text()
      requests++
      await release.promise
      return Response.json({})
    },
  })
  let shutdownStarted = 0
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const exporter = yield* LogExporter.make({
            url: `http://127.0.0.1:${collector.port}/v1/logs`,
            resource: { serviceName: "logger-deadline-test" },
            exportInterval: 60_000,
            maxBatchSize: 1000,
            shutdownTimeout: 150,
          })
          yield* Effect.forEach(Array.from({ length: 1001 }), () => Effect.logInfo("bounded shutdown")).pipe(
            Effect.provide(Logger.layer([exporter], { mergeWithExisting: false })),
          )
          shutdownStarted = Date.now()
        }),
      ).pipe(Effect.provide(dependencies)),
    )
    expect(requests).toBe(1)
    // The request count catches a second full flush budget directly. Allow
    // scheduler headroom in this wall-clock guard when CI runs other shards.
    expect(Date.now() - shutdownStarted).toBeLessThan(750)
  } finally {
    release.resolve()
  }
}, 10_000)

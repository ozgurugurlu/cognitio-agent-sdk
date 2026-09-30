import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer, Metric } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpMetrics, OtlpSerialization } from "effect/unstable/observability"

type OtlpBody = {
  resourceMetrics?: {
    scopeMetrics?: {
      metrics?: { name: string; sum?: { dataPoints: { asDouble?: number | null; asInt?: number }[] } }[]
    }[]
  }[]
}

function findMetric(bodies: OtlpBody[], name: string) {
  return bodies
    .flatMap((body) => body.resourceMetrics ?? [])
    .flatMap((resource) => resource.scopeMetrics ?? [])
    .flatMap((scope) => scope.metrics ?? [])
    .find((metric) => metric.name === name)
}

function collector(bodies: OtlpBody[]) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/v1/metrics") {
        bodies.push((await req.json()) as OtlpBody)
      } else {
        await req.text()
      }
      return Response.json({})
    },
  })
}

describe("effect.observability metrics flush", () => {
  test("OtlpMetrics flushes pending datapoints on scope teardown", async () => {
    const bodies: OtlpBody[] = []
    using server = collector(bodies)

    const layer = OtlpMetrics.layer({
      url: `http://127.0.0.1:${server.port}/v1/metrics`,
      resource: { serviceName: "cognitio-test" },
      // Interval far beyond the test lifetime: any export we see is the
      // teardown flush, which is what short-lived CLI runs rely on.
      exportInterval: 60_000,
      temporality: "delta",
      shutdownTimeout: "3 seconds",
    }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))

    const counter = Metric.counter("cognitio.test.teardown_flush", { incremental: true })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(layer)
          yield* Metric.update(Metric.withAttributes(counter, { case: "teardown" }), 5)
        }),
      ),
    )

    const end = Date.now() + 2000
    while (!findMetric(bodies, "cognitio.test.teardown_flush") && Date.now() < end) {
      await Bun.sleep(20)
    }
    const metric = findMetric(bodies, "cognitio.test.teardown_flush")
    expect(metric).toBeDefined()
    const point = metric!.sum!.dataPoints[0]
    expect(point.asDouble ?? point.asInt).toBe(5)
  })

  test("spawned serve process flushes metrics on SIGTERM", async () => {
    const bodies: OtlpBody[] = []
    using otlp = collector(bodies)

    const pkg = path.resolve(import.meta.dir, "../..")
    const proc = Bun.spawn({
      cmd: ["bun", "--conditions=browser", "src/index.ts", "serve", "--port", "0"],
      cwd: pkg,
      env: {
        ...process.env,
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${otlp.port}`,
        OTEL_METRIC_EXPORT_INTERVAL: "600000",
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    try {
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let output = ""
      const deadline = Date.now() + 30_000
      let url: string | undefined
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        output += decoder.decode(value)
        const match = output.match(/agent server listening at (http:\/\/\S+)/)
        if (match) {
          url = match[1].replace(/\/$/, "")
          break
        }
      }
      reader.releaseLock()
      if (!url) throw new Error(`server never came up. output: ${output}`)

      // Creating a session increments cognitio.session.count — the datapoint
      // the SIGTERM flush must deliver.
      const created = await fetch(`${url}/session?directory=${encodeURIComponent(pkg)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(created.status).toBe(200)

      proc.kill("SIGTERM")
      const code = await proc.exited
      expect(code).toBe(143)

      const end = Date.now() + 5000
      while (!findMetric(bodies, "cognitio.session.count") && Date.now() < end) {
        await Bun.sleep(50)
      }
      const metric = findMetric(bodies, "cognitio.session.count")
      expect(metric).toBeDefined()
      const point = metric!.sum!.dataPoints[0]
      expect(point.asDouble ?? point.asInt).toBeGreaterThanOrEqual(1)
    } finally {
      proc.kill()
    }
  }, 60_000)
})

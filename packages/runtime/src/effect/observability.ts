import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpMetrics, OtlpSerialization } from "effect/unstable/observability"
import * as EffectLogger from "./logger"
import * as LogExporter from "./log-exporter"
import { Flag } from "@/flag/flag"
import { InstallationChannel, InstallationVersion } from "@/installation/version"
import { ensureProcessMetadata } from "@/util/cognitio-process"
import { redactLogData } from "./log-redaction"

const base = Flag.OTEL_EXPORTER_OTLP_ENDPOINT
export const enabled = !!base
const processID = crypto.randomUUID()

const headers = Flag.OTEL_EXPORTER_OTLP_HEADERS
  ? Flag.OTEL_EXPORTER_OTLP_HEADERS.split(",").reduce(
      (acc, x) => {
        const [key, ...value] = x.split("=")
        acc[key] = value.join("=")
        return acc
      },
      {} as Record<string, string>,
    )
  : undefined

export function resource(): { serviceName: string; serviceVersion: string; attributes: Record<string, string> } {
  const processMetadata = ensureProcessMetadata("main")
  const attributes: Record<string, string> = (() => {
    const value = process.env.OTEL_RESOURCE_ATTRIBUTES
    if (!value) return {}
    try {
      return Object.fromEntries(
        value.split(",").map((entry) => {
          const index = entry.indexOf("=")
          if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
          return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
        }),
      )
    } catch {
      return {}
    }
  })()

  return {
    serviceName: Flag.OTEL_SERVICE_NAME ?? "cognitio",
    serviceVersion: InstallationVersion,
    attributes: {
      ...attributes,
      "deployment.environment.name": InstallationChannel,
      "cognitio.client": Flag.COGNITIO_CLIENT,
      "cognitio.process_role": processMetadata.processRole,
      "cognitio.run_id": processMetadata.runID,
      "service.instance.id": processID,
    },
  }
}

function logs() {
  const serialization = Layer.effect(
    OtlpSerialization.OtlpSerialization,
    Effect.map(Effect.service(OtlpSerialization.OtlpSerialization), (current) => ({
      ...current,
      logs: (data) => current.logs(redactLogData(data)),
    })),
  ).pipe(Layer.provide(OtlpSerialization.layerJson))
  return Layer.merge(
    EffectLogger.layer,
    Layer.effectDiscard(
      LogExporter.make({
        url: `${base}/v1/logs`,
        resource: resource(),
        headers,
      }).pipe(Effect.flatMap(EffectLogger.installExporter)),
    ),
  ).pipe(Layer.provide(serialization), Layer.provide(FetchHttpClient.layer))
}

function metrics() {
  // Delta is the deliberate default (matches the Phase 10 plan and most
  // vendor backends); the OTel spec's "lowmemory" preference maps to delta
  // for counters, so anything other than an explicit "cumulative" stays delta.
  const pref = process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE?.toLowerCase()
  return OtlpMetrics.layer({
    url: `${base}/v1/metrics`,
    resource: resource(),
    headers,
    exportInterval: Flag.OTEL_METRIC_EXPORT_INTERVAL ?? 60_000,
    temporality: pref === "cumulative" ? "cumulative" : "delta",
    // Final flush happens on layer teardown; keep it bounded so short-lived
    // CLI runs exit promptly even when the collector is unreachable.
    shutdownTimeout: "3 seconds",
  }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
}

const traces = async () => {
  const NodeSdk = await import("@effect/opentelemetry/NodeSdk")
  const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
  const SdkBase = await import("@opentelemetry/sdk-trace-base")

  // @effect/opentelemetry creates a NodeTracerProvider but never calls
  // register(), so the global @opentelemetry/api context manager stays
  // as the no-op default. Non-Effect code (like the AI SDK) that calls
  // tracer.startActiveSpan() relies on context.active() to find the
  // parent span — without a real context manager every span starts a
  // new trace. Registering AsyncLocalStorageContextManager fixes this.
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks")
  const { context } = await import("@opentelemetry/api")
  const mgr = new AsyncLocalStorageContextManager()
  mgr.enable()
  context.setGlobalContextManager(mgr)

  return NodeSdk.layer(() => ({
    resource: resource(),
    spanProcessor: new SdkBase.BatchSpanProcessor(
      new OTLP.OTLPTraceExporter({
        url: `${base}/v1/traces`,
        headers,
      }),
    ),
  }))
}

export const layer = !base
  ? EffectLogger.layer
  : Layer.unwrap(
      Effect.gen(function* () {
        const trace = yield* Effect.promise(traces)
        return Layer.mergeAll(trace, logs(), metrics())
      }),
    )

export const Observability = { enabled, layer }

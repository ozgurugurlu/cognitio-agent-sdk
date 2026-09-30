import { Effect, Metric } from "effect"
import { Flag } from "@/flag/flag"

// OpenTelemetry metrics for cost/usage observability (Phase 10). Counters
// live in Effect's process-global metric registry; they are always updated
// (cheap, in-memory) and only exported when OTEL_EXPORTER_OTLP_ENDPOINT is
// set (see effect/observability.ts).
//
// All updates MUST go through the record* helpers below: the metric REGISTRY
// key serializes attributes in insertion order (effect Metric.js
// serializeAttributes uses Object.entries without sorting), so call sites
// building differently-ordered attribute objects would register duplicate
// counter entries whose increments split across series.
//
// The `unit` constructor attribute doubles as the OTLP unit (OtlpMetrics
// reads state.attributes.unit) and also lands on every datapoint — accepted
// quirk of the Effect exporter.

const tokenUsage = Metric.counter("cognitio.token.usage", {
  description: "LLM tokens consumed, by provider, model, and token type",
  attributes: { unit: "tokens" },
  incremental: true,
})

const costUsage = Metric.counter("cognitio.cost.usage", {
  description: "LLM spend in USD, by provider and model",
  attributes: { unit: "USD" },
  incremental: true,
})

const sessionCount = Metric.counter("cognitio.session.count", {
  description: "Sessions created (roots, forks, and subagent children)",
  incremental: true,
})

const rateLimitCount = Metric.counter("cognitio.rate_limit.count", {
  description: "Provider rate limit responses observed",
  incremental: true,
})

// session.id is high-cardinality on a server-first deployment, so it is
// opt-in (Claude Code defaults the equivalent toggle to on; we invert it).
function sessionAttributes(sessionID: string | undefined): Record<string, string> {
  return sessionID && Flag.OTEL_METRICS_INCLUDE_SESSION_ID ? { "session.id": sessionID } : {}
}

export interface UsageTokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/**
 * Records one model request's tokens and cost. Token types are disjoint;
 * `output` includes reasoning tokens (GenAI semconv: output covers billed
 * output), i.e. metric output = usage.output + usage.reasoning.
 */
export function recordModelUsage(input: {
  providerID: string
  modelID: string
  tokens: UsageTokens
  cost: number
  sessionID?: string
}) {
  const base = {
    provider: input.providerID,
    model: input.modelID,
    ...sessionAttributes(input.sessionID),
  }
  const values = {
    input: input.tokens.input,
    output: input.tokens.output + input.tokens.reasoning,
    cacheRead: input.tokens.cache.read,
    cacheWrite: input.tokens.cache.write,
  }
  return Effect.gen(function* () {
    for (const [type, value] of Object.entries(values)) {
      if (!value) continue
      yield* Metric.update(Metric.withAttributes(tokenUsage, { ...base, type }), value)
    }
    if (input.cost) yield* Metric.update(Metric.withAttributes(costUsage, base), input.cost)
  })
}

export function recordSession() {
  return Metric.update(sessionCount, 1)
}

export function recordRateLimit(input: { provider: string; sessionID?: string }) {
  return Metric.update(
    Metric.withAttributes(rateLimitCount, {
      provider: input.provider,
      ...sessionAttributes(input.sessionID),
    }),
    1,
  )
}

// Exposed for tests (reading counter values via Metric.value).
export const counters = { tokenUsage, costUsage, sessionCount, rateLimitCount }

export * as SessionMetrics from "./metrics"

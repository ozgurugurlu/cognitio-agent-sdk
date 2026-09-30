import type { NamedError } from "@cognitio/shared/util/error"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"

export type Err = ReturnType<NamedError["toObject"]>

export const USAGE_LIMIT_MESSAGE = "Provider usage limit exceeded. Check your provider account quota."

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

function cap(ms: number) {
  // Floor at 0: providers can send negative retry-after hints, which would
  // otherwise leak out as a negative delay/retryAfterSeconds.
  return Math.min(Math.max(ms, 0), RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: MessageV2.APIError) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
    }
  }

  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

export type RetryKind = "rate_limit" | "overloaded" | "usage_limit" | "server_error"

function matchesRateLimitText(message: string) {
  const lower = message.toLowerCase()
  return (
    lower.includes("rate increased too quickly") || lower.includes("rate limit") || lower.includes("too many requests")
  )
}

/**
 * Pure error classification with NO retryability gate — a non-retryable 429
 * still classifies as rate_limit here. Use `classify` when deciding whether
 * to retry; use `kindOf` when only the category matters (e.g. publishing a
 * rate-limit event from the terminal failure path).
 */
export function kindOf(error: Err): { kind: RetryKind; message: string } | undefined {
  if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
  if (MessageV2.APIError.isInstance(error)) {
    const status = error.data.statusCode
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      return { kind: "usage_limit", message: USAGE_LIMIT_MESSAGE }
    }
    // Real provider 429s surface as APIError and would otherwise never reach
    // the plain-text patterns below, so classify them here.
    if (status === 429 || matchesRateLimitText(error.data.message)) {
      return { kind: "rate_limit", message: error.data.message }
    }
    if (error.data.message.includes("Overloaded")) return { kind: "overloaded", message: "Provider is overloaded" }
    return { kind: "server_error", message: error.data.message }
  }

  // Check for rate limit patterns in plain text error messages
  const msg = error.data?.message
  if (typeof msg === "string" && matchesRateLimitText(msg)) {
    return { kind: "rate_limit", message: msg }
  }

  const json = iife(() => {
    try {
      if (typeof error.data?.message === "string") {
        const parsed = JSON.parse(error.data.message)
        return parsed
      }

      return JSON.parse(error.data.message)
    } catch {
      return undefined
    }
  })
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return { kind: "rate_limit", message: "Too Many Requests" }
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return { kind: "overloaded", message: "Provider is overloaded" }
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return { kind: "rate_limit", message: "Rate Limited" }
  }
  return undefined
}

/** Classification gated on retryability — undefined means "do not retry". */
export function classify(error: Err): { kind: RetryKind; message: string } | undefined {
  if (MessageV2.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
  }
  return kindOf(error)
}

export function retryable(error: Err) {
  return classify(error)?.message
}

export function policy(opts: {
  parse: (error: unknown) => Err
  set: (input: {
    attempt: number
    message: string
    next: number
    kind: RetryKind
    delayMs: number
  }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const classified = classify(error)
      if (!classified) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, MessageV2.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: classified.message,
          next: now + wait,
          kind: classified.kind,
          delayMs: wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"

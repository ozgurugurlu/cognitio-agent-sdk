/**
 * Error helpers shared between `client.ts` and `session.ts`.
 *
 * The vendored client under `internal/runtime-client` returns results as a
 * `{ data, error }` discriminated union. `assertOk` narrows the union and
 * throws a consistent, annotated error when the call failed.
 */

export type SdkResult<T> = { data: T; error: undefined } | { data: undefined; error: unknown }
import { sdkError } from "../errors.js"

export function formatError(error: unknown): string {
  if (!error) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function assertOk<T>(result: SdkResult<T>, context: string): asserts result is { data: T; error: undefined } {
  if (result.error !== undefined || result.data === undefined) {
    throw sdkError("transport", `${context}: ${formatError(result.error)}`, { cause: result.error })
  }
}

export function assertNoError<T>(result: SdkResult<T>, context: string): void {
  if (result.error !== undefined) {
    throw sdkError("transport", `${context}: ${formatError(result.error)}`, { cause: result.error })
  }
}

/** Stable categories for setup and lifecycle failures. Model execution failures remain ResultMessage subtypes. */
export type SdkErrorKind = "configuration" | "closed" | "session_conflict" | "transport" | "protocol" | "binary"

/** Error-compatible failure with a portable discriminant; inspect kind instead of parsing message text. */
export interface SdkError extends Error {
  name: "CognitioSdkError"
  kind: SdkErrorKind
}

/**
 * Recognize SDK setup/lifecycle failures without depending on class identity.
 * @param error - Any caught value, including a deserialized error record.
 * @returns True when the value carries the SDK error name, kind, and message.
 * @example
 * ```ts
 * if (isSdkError(error) && error.kind === "configuration") console.error(error.message)
 * ```
 */
export function isSdkError(error: unknown): error is SdkError {
  return (
    !!error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "CognitioSdkError" &&
    "message" in error &&
    typeof error.message === "string" &&
    "kind" in error &&
    ["configuration", "closed", "session_conflict", "transport", "protocol", "binary"].includes(String(error.kind))
  )
}

/** @internal Add a stable discriminant while preserving standard Error behavior and the original cause. */
export function sdkError(kind: SdkErrorKind, message: string, options?: ErrorOptions): SdkError {
  return Object.assign(new Error(message, options), { name: "CognitioSdkError" as const, kind })
}

/**
 * Helpers for filtering raw SSE events coming from the cognitio `/event`
 * stream. The server emits every bus event instance-wide, so each session
 * must filter the payload to its own `sessionID`.
 *
 * Session-scoped events carry `properties.sessionID`; system events
 * (`server.connected`, `server.heartbeat`, `workspace.*`, `lsp.*`, etc.)
 * do not. Callers should pass the latter through unchanged.
 */

export function extractSessionID(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined
  const props = (event as { properties?: unknown }).properties
  if (!props || typeof props !== "object") return undefined
  const sid = (props as { sessionID?: unknown }).sessionID
  return typeof sid === "string" ? sid : undefined
}

export function isSessionIdle(event: unknown): boolean {
  return (
    !!event
    && typeof event === "object"
    && (event as { type?: unknown }).type === "session.idle"
  )
}

export function isSessionResult(event: unknown): boolean {
  return (
    !!event
    && typeof event === "object"
    && (event as { type?: unknown }).type === "session.result"
  )
}

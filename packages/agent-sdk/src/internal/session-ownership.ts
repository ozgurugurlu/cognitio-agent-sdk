import { sdkError } from "../errors.js"
import type { AgentClient } from "../client.js"

const claims = new WeakMap<AgentClient, Map<string, symbol>>()

/**
 * Claim one server session id for a single live facade owner.
 *
 * Two Agents attached to the same session on the same client would each wire
 * their own dispatcher, permission callbacks, and SDK MCP hosts onto one
 * server-side session, so the second attach is refused instead of silently
 * racing. Keyed by client, so the same id on a different server is unrelated.
 *
 * @param client - The low-level client the session lives on.
 * @param sessionId - The server session id being claimed.
 * @param owner - Opaque per-Agent identity; re-claiming as the same owner is a no-op.
 * @returns A release function, safe to call more than once.
 * @throws When a different owner already holds a live claim on this session.
 */
export function claimFacadeSession(client: AgentClient, sessionId: string, owner: symbol): () => void {
  const sessions = claims.get(client) ?? new Map<string, symbol>()
  const current = sessions.get(sessionId)
  if (current !== undefined && current !== owner) {
    throw sdkError(
      "session_conflict",
      `Session ${sessionId} already has a live facade owner; close that Agent or Session before resuming it elsewhere`,
    )
  }
  if (current === owner) return () => {}
  sessions.set(sessionId, owner)
  claims.set(client, sessions)
  return () => {
    if (sessions.get(sessionId) !== owner) return
    sessions.delete(sessionId)
    if (sessions.size === 0) claims.delete(client)
  }
}

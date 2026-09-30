import type { PermissionDecision as PermissionDecisionShape } from "./types.js"

/**
 * Serializable allow, deny or ask decision returned to the runtime permission engine.
 */
export type PermissionDecision = PermissionDecisionShape

/**
 * Construct portable permission decisions for canUseTool and supported hooks.
 */
export const PermissionDecision = {
  /**
   * Approve the request, optionally replacing its input.
   * @param updatedInput - Validated replacement tool arguments.
   * @returns An allow decision.
   * @example
   * ```ts
   * return PermissionDecision.allow()
   * ```
   */
  allow(updatedInput?: Record<string, unknown>): PermissionDecisionShape {
    return updatedInput ? { behavior: "allow", updatedInput } : { behavior: "allow" }
  },
  /**
   * Reject a request with an optional explanation.
   * @param message - Reason shown to the runtime/model.
   * @returns A deny decision.
   * @example
   * ```ts
   * return PermissionDecision.deny("Read-only agent")
   * ```
   */
  deny(message?: string): PermissionDecisionShape {
    return message ? { behavior: "deny", message } : { behavior: "deny" }
  },
  /**
   * Delegate to the remaining permission path; this is not approval.
   * @returns An ask decision.
   * @example
   * ```ts
   * return PermissionDecision.ask()
   * ```
   */
  ask(): PermissionDecisionShape {
    return { behavior: "ask" }
  },
}

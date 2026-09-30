import { createAgentClient, type AgentClient } from "../client.js"
import type { ClientOptions } from "../types.js"
import { FACADE_DEFAULT_SPAWN } from "./default-profile.js"

const dedicatedClients = new Set<AgentClient>()
const pendingClients = new Set<Promise<AgentClient>>()
let canonicalClient: AgentClient | undefined
let canonicalCreation: Promise<AgentClient> | undefined
let shutdownPromise: Promise<void> | undefined
let lifecycleInstalled = false
let lifecycleGeneration = 0

class ClientCreationInterruptedError extends Error {}

class PendingClientTeardownError extends Error {
  constructor(cause: unknown) {
    super("A client created during shutdown could not be closed", { cause })
  }
}

/**
 * Acquire the process-global facade client. Concurrent first callers share
 * one creation promise; a failed creation is never cached.
 *
 * @returns The canonical facade-owned client.
 * @throws When local server creation fails or is overtaken by `shutdown()`.
 */
export function acquireCanonicalClient(): Promise<AgentClient> {
  // Retry after the in-flight shutdown either way: a teardown failure belongs to
  // whoever called shutdown(), and must not poison a caller asking for a new
  // client. The memo is already cleared by then, so this cannot recurse.
  if (shutdownPromise) return shutdownPromise.then(afterShutdown, afterShutdown)
  if (canonicalClient) return Promise.resolve(canonicalClient)
  if (canonicalCreation) return canonicalCreation

  installLifecycle()
  const generation = lifecycleGeneration
  const created = createAgentClient({ spawn: FACADE_DEFAULT_SPAWN }).then(async (client) => {
    if (generation === lifecycleGeneration && !shutdownPromise) {
      canonicalClient = client
      return client
    }
    await client.close().catch((error) => {
      throw new PendingClientTeardownError(error)
    })
    throw new ClientCreationInterruptedError(
      "Canonical Agent client creation was interrupted by shutdown; retry the operation",
    )
  })
  const tracked = trackCreation(created)
  canonicalCreation = tracked.finally(() => {
    if (canonicalCreation === wrapped) canonicalCreation = undefined
    maybeRemoveLifecycle()
  })
  const wrapped = canonicalCreation
  wrapped.catch(() => {})
  return wrapped
}

/**
 * Create a facade-owned dedicated client.
 *
 * @param options - Explicit low-level connection options.
 * @returns A fresh client owned by the calling Agent.
 * @throws When client creation fails or is overtaken by `shutdown()`.
 */
export function createDedicatedClient(options: ClientOptions): Promise<AgentClient> {
  if (shutdownPromise) {
    const retry = () => createDedicatedClient(options)
    return shutdownPromise.then(retry, retry)
  }
  installLifecycle()
  const generation = lifecycleGeneration
  const created = trackCreation(
    createAgentClient(options).then(async (client) => {
      if (generation === lifecycleGeneration && !shutdownPromise) {
        dedicatedClients.add(client)
        return client
      }
      await client.close().catch((error) => {
        throw new PendingClientTeardownError(error)
      })
      throw new ClientCreationInterruptedError(
        "Dedicated Agent client creation was interrupted by shutdown; retry the operation",
      )
    }),
  )
  created.catch(() => {})
  return created.finally(maybeRemoveLifecycle)
}

/**
 * Close one dedicated facade-owned client and remove it from global tracking.
 *
 * @param client - A client returned by `createDedicatedClient`.
 * @returns A promise that settles after the client is fully closed.
 * @throws When client or process teardown fails.
 */
export async function closeDedicatedClient(client: AgentClient): Promise<void> {
  await client.close()
  dedicatedClients.delete(client)
  maybeRemoveLifecycle()
}

/**
 * Close all canonical and dedicated clients owned by the facade.
 *
 * Injected clients are borrowed and are never closed. Concurrent calls share
 * one shutdown operation; a later facade operation may create a fresh
 * canonical client.
 *
 * @returns A promise that settles after every owned client has been handled.
 * @throws When teardown fails; multiple failures are combined in an `AggregateError`.
 * @example
 * ```ts
 * import { shutdown } from "cognitio-agent-sdk"
 *
 * await shutdown()
 * ```
 */
export function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise

  lifecycleGeneration += 1
  const pending = [...pendingClients]
  const existing = [canonicalClient, ...dedicatedClients].filter(
    (client): client is AgentClient => client !== undefined,
  )
  canonicalClient = undefined
  canonicalCreation = undefined
  dedicatedClients.clear()

  const operation = (async () => {
    const created = await Promise.allSettled(pending)
    const clients = new Set([
      ...existing,
      ...created.flatMap((item) => (item.status === "fulfilled" ? [item.value] : [])),
    ])
    const closed = await Promise.allSettled([...clients].map((client) => client.close()))
    const errors = [
      ...created.flatMap((item) =>
        item.status === "rejected" && item.reason instanceof PendingClientTeardownError ? [item.reason.cause] : [],
      ),
      ...closed.filter((item) => item.status === "rejected").map((item) => item.reason),
    ]
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "Failed to shut down Agent facade clients")
  })()
  const settled = operation.finally(() => {
    removeLifecycle()
    if (shutdownPromise === settled) shutdownPromise = undefined
  })
  shutdownPromise = settled
  return settled
}

/** @internal Snapshot of facade-owned client lifecycle state for tests. */
export function clientState(): {
  canonical: boolean
  dedicated: number
  pending: number
  settling: boolean
} {
  return {
    canonical: canonicalClient !== undefined,
    dedicated: dedicatedClients.size,
    pending: pendingClients.size,
    settling: shutdownPromise !== undefined,
  }
}

function afterShutdown(): Promise<AgentClient> {
  return acquireCanonicalClient()
}

function trackCreation(created: Promise<AgentClient>): Promise<AgentClient> {
  pendingClients.add(created)
  created
    .finally(() => {
      pendingClients.delete(created)
      maybeRemoveLifecycle()
    })
    .catch(() => {})
  return created
}

function installLifecycle(): void {
  if (lifecycleInstalled) return
  lifecycleInstalled = true
  process.on("beforeExit", onBeforeExit)
  // Prepended so a host listener registered either before or after ours is
  // still present when we decide ownership in handleSignal.
  process.prependListener("SIGINT", onSigint)
  process.prependListener("SIGTERM", onSigterm)
}

function maybeRemoveLifecycle(): void {
  if (canonicalClient || canonicalCreation || dedicatedClients.size || pendingClients.size || shutdownPromise) return
  removeLifecycle()
}

function removeLifecycle(): void {
  if (!lifecycleInstalled) return
  lifecycleInstalled = false
  process.removeListener("beforeExit", onBeforeExit)
  process.removeListener("SIGINT", onSigint)
  process.removeListener("SIGTERM", onSigterm)
}

function onBeforeExit(): void {
  void shutdown().catch(() => {})
}

function onSigint(): void {
  handleSignal("SIGINT", 130)
}

function onSigterm(): void {
  handleSignal("SIGTERM", 143)
}

/**
 * Sole-listener etiquette: a host that keeps its own handler registered owns
 * the exit policy, so we no-op and let it decide. Our handler is prepended, so
 * a host listener is still counted whether it was added before or after ours.
 *
 * Known limit: a host that *prepends* a `once` listener after ours has already
 * removed itself by the time we run, so this signal reads as unowned and we
 * take over. Detecting that would need `process`'s `removeListener` event,
 * which Bun does not emit; a persistent host listener is unaffected.
 *
 * A second signal while the first teardown is still settling exits at once.
 * `process.exit` runs the low-level spawner's `exit` hook, which is the
 * synchronous best-effort sweep for children registered with `autoCleanup`.
 */
function handleSignal(signal: "SIGINT" | "SIGTERM", code: number): void {
  const cleanupSignal = Symbol.for("cognitio.child-cleanup-signal")
  const own = signal === "SIGINT" ? onSigint : onSigterm
  if (process.listeners(signal).some((listener) => listener !== own && !(cleanupSignal in listener))) return
  if (shutdownPromise) process.exit(code)
  void shutdown()
    .catch(() => {})
    .finally(() => process.exit(code))
}

// Central roster of every ManagedRuntime in the process. The runtimes share
// one Layer memo map, so scoped resources like the OTel exporters (which
// flush pending telemetry in their finalizers) only tear down when the LAST
// runtime referencing them is disposed — shutdown must dispose all of them.
type DisposableRuntime = { dispose: () => Promise<unknown> }

const runtimes = new Set<DisposableRuntime>()
const lifecycle = new Set<{ before?: () => Promise<unknown>; after?: () => Promise<unknown> }>()

export function registerRuntimeDisposal(hooks: { before?: () => Promise<unknown>; after?: () => Promise<unknown> }) {
  lifecycle.add(hooks)
  return () => lifecycle.delete(hooks)
}

export function registerRuntime<T extends DisposableRuntime>(runtime: T): T {
  runtimes.add(runtime)
  return runtime
}

export async function disposeRuntimes() {
  // Complete buffered startup logging before snapshotting the runtime roster.
  await Promise.allSettled(Array.from(lifecycle, (hooks) => hooks.before?.()))
  const pending = Array.from(runtimes, (runtime) => runtime.dispose().catch(() => {}))
  runtimes.clear()
  await Promise.all(pending)
  await Promise.allSettled(Array.from(lifecycle, (hooks) => hooks.after?.()))
}

// Bounded so an unreachable collector can never hang exit. Idempotent —
// direct process.exit() call sites (github action, TUI worker shutdown) and
// the main CLI finally block can all call it.
let disposed: Promise<void> | undefined
export function disposeRuntimesBounded(timeoutMs = 3000) {
  if (disposed) return disposed
  const timeout = Promise.withResolvers<void>()
  const timer = setTimeout(() => timeout.resolve(), timeoutMs)
  disposed = Promise.race([disposeRuntimes().catch(() => {}), timeout.promise]).finally(() => clearTimeout(timer))
  return disposed
}

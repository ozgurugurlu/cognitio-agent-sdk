import { type ChildProcess, spawnSync } from "node:child_process"

const tracked = new Set<ChildProcess>()
let exitHandler: (() => void) | undefined
let signalShutdown: Promise<unknown> | undefined
const cleanupSignal = Symbol.for("cognitio.child-cleanup-signal")
type CleanupListener = (() => void) & { [cleanupSignal]?: () => Promise<unknown> }
const onSigint: CleanupListener = () => handleSignal("SIGINT", 130)
const onSigterm: CleanupListener = () => handleSignal("SIGTERM", 143)
onSigint[cleanupSignal] = onSigterm[cleanupSignal] = () =>
  Promise.allSettled([...tracked].map((child) => stopAndWait(child)))

function handleSignal(signal: "SIGINT" | "SIGTERM", code: number): void {
  const listeners = process.listeners(signal) as CleanupListener[]
  // A host signal handler owns exit policy. Facade handlers recognize our
  // marker and retain responsibility for awaiting scratch/session cleanup.
  if (listeners.some((listener) => !listener[cleanupSignal])) return
  if (signalShutdown) process.exit(code)
  signalShutdown = Promise.allSettled(listeners.map((listener) => listener[cleanupSignal]!()))
  void signalShutdown.finally(() => process.exit(code))
}

function removeSignalHandlers(): void {
  process.off("SIGINT", onSigint)
  process.off("SIGTERM", onSigterm)
}

// Vendored from `@cognitio/sdk` (`packages/sdk/js/src/process.ts`), which in
// turn duplicates `packages/runtime/src/util/process.ts` to avoid a dependency
// cycle. Vendoring it here is what lets the published tarball reference no
// sibling package at all.
//
// Consequence to keep in mind: `ChildTerminationError` below is a *different
// class object* from the one `@cognitio/sdk` exports. `instanceof` only
// holds within this package, so `server.ts` and every consumer of it must
// import the class from this module — never from the low-level SDK. The module
// state (`tracked`, `exitHandler`) is likewise package-local: loading both
// copies in one process installs two `exit` listeners.
//
// Deviation from the vendored original, and the only behavioral one: the
// "already exited?" guards below used `!== null`, so a `spawnProcess` child
// whose `exitCode` is `undefined` — which the documented contract did not
// require it to define — answered "yes, exited". `stopAndWait` then resolved
// without sending a signal, `close()` became a no-op, and the transport
// deleted the scratch directory of a live process. `!= null` treats `undefined`
// as unknown and proceeds to kill, which is the guard's actual intent.
export function stop(proc: ChildProcess) {
  if (proc.exitCode != null || proc.signalCode != null) return
  if (process.platform === "win32" && proc.pid) {
    const out = spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true })
    if (!out.error && out.status === 0) return
  }
  proc.kill()
}

/** Thrown by `stopAndWait` when a child's termination cannot be confirmed. */
export class ChildTerminationError extends Error {
  constructor(pid: number) {
    super(`child process ${pid} could not be confirmed terminated`)
    this.name = "ChildTerminationError"
  }
}

/**
 * Stop a child process and resolve ONLY after it has actually exited: SIGTERM
 * (taskkill on win32) first, SIGKILL after `graceMs`. A genuine `exit` event
 * is the sole success signal — an `error` on a still-running child does not
 * confirm exit, and if the child is still alive after SIGKILL the promise
 * rejects with `ChildTerminationError` rather than falsely reporting success.
 * Callers must treat rejection as "termination unconfirmed" and preserve any
 * resources the child still owns (leak-safe). Resolves immediately for a
 * process that already exited or never spawned (ENOENT leaves pid undefined).
 */
export function stopAndWait(proc: ChildProcess, graceMs = 5000): Promise<void> {
  if (proc.exitCode != null || proc.signalCode != null) return Promise.resolve()
  if (proc.pid === undefined) return Promise.resolve()
  const pid = proc.pid
  // Liveness probe: signal 0 never affects the target. ESRCH → gone; EPERM →
  // exists but not signalable (conservatively treated as alive).
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM"
    }
  }
  return new Promise((resolve, reject) => {
    const timers: ReturnType<typeof setTimeout>[] = []
    let settled = false
    const done = (err?: Error) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      proc.off("exit", onExit)
      proc.off("error", onError)
      if (err) reject(err)
      else resolve()
    }
    const onExit = () => done()
    const onError = () => {
      // Only a never-started child (no pid) or a confirmed-dead one is settled
      // by an error; a running child's error does not prove it exited.
      if (proc.pid === undefined || !alive()) done()
    }
    proc.on("exit", onExit)
    proc.on("error", onError)
    // A synchronous throw from the initial stop (e.g. proc.kill throwing) must
    // NOT short-circuit the promise with a raw error — the child may still be
    // alive. Swallow it and let the SIGKILL/liveness escalation below decide,
    // so an unconfirmed termination still surfaces as ChildTerminationError.
    try {
      stop(proc)
    } catch {}
    if (proc.exitCode != null || proc.signalCode != null) return done()
    timers.push(
      setTimeout(() => {
        try {
          proc.kill("SIGKILL")
        } catch {}
        timers.push(
          setTimeout(() => {
            // Confirm death via the liveness probe; only give up (leak-safe)
            // if the child is genuinely still alive.
            if (!alive()) done()
            else done(new ChildTerminationError(pid))
          }, 1000),
        )
      }, graceMs),
    )
  })
}

/**
 * Synchronously ask every tracked direct child to stop.
 *
 * This is deliberately a last-resort direct-PID sweep. A process `exit`
 * listener cannot await SIGKILL escalation, and POSIX does not provide a
 * portable descendant-tree kill without changing process-group semantics.
 * A SIGTERM-ignoring child can therefore survive this function.
 */
export function sweepTrackedSync(): void {
  const pending = Array.from(tracked)
  tracked.clear()
  if (exitHandler) process.removeListener("exit", exitHandler)
  exitHandler = undefined
  removeSignalHandlers()
  for (const proc of pending) {
    try {
      stop(proc)
    } catch {}
  }
}

/**
 * Track a direct child for the synchronous process-exit sweep.
 *
 * The returned function must be called only after termination has been
 * confirmed. Real `exit` events and ENOENT-style errors deregister
 * automatically. Sole-listener SIGINT/SIGTERM handlers await child termination;
 * a host-installed signal handler retains exit-policy ownership.
 */
export function registerAutoCleanup(proc: ChildProcess): () => void {
  tracked.add(proc)
  if (!exitHandler) {
    exitHandler = sweepTrackedSync
    process.on("exit", exitHandler)
    process.prependListener("SIGINT", onSigint)
    process.prependListener("SIGTERM", onSigterm)
  }

  let registered = true
  const deregister = () => {
    if (!registered) return
    registered = false
    proc.off("exit", deregister)
    proc.off("error", onError)
    tracked.delete(proc)
    if (tracked.size > 0 || !exitHandler) return
    process.removeListener("exit", exitHandler)
    exitHandler = undefined
    removeSignalHandlers()
  }
  const onError = () => {
    if (proc.pid === undefined) deregister()
  }
  proc.once("exit", deregister)
  proc.once("error", onError)
  return deregister
}

/** @internal */
export function autoCleanupCount(): number {
  return tracked.size
}

export function bindAbort(proc: ChildProcess, signal?: AbortSignal, onAbort?: () => void) {
  if (!signal) return () => {}
  const abort = () => {
    clear()
    try {
      stop(proc)
    } catch {}
    onAbort?.()
  }
  const clear = () => {
    signal.removeEventListener("abort", abort)
    proc.off("exit", clear)
    proc.off("error", clear)
  }
  signal.addEventListener("abort", abort, { once: true })
  proc.on("exit", clear)
  proc.on("error", clear)
  if (signal.aborted) abort()
  return clear
}

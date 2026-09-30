import launch from "cross-spawn"
import { type Config } from "./gen/types.gen.js"
import { stop, stopAndWait, bindAbort, ChildTerminationError, registerAutoCleanup } from "../process.js"

export { ChildTerminationError } from "../process.js"

export type ServerOptions = {
  hostname?: string
  port?: number
  signal?: AbortSignal
  timeout?: number
  config?: Config
  /** Extra env vars for the child; applied over the inherited env. COGNITIO_CONFIG_CONTENT always wins last (use `config`). */
  env?: Record<string, string>
  /** Inherit process.env (default true). With false the child only sees `env` + COGNITIO_CONFIG_CONTENT — include PATH yourself. */
  inheritEnv?: boolean
  /** Binary to spawn (default "cognitio"); absolute paths supported. */
  command?: string
  /** Grace period in ms between SIGTERM and SIGKILL on close/failed startup (default 5000). */
  shutdownTimeout?: number
  /**
   * Track the direct server child for a synchronous process-exit SIGTERM and
   * unref it after readiness.
   *
   * The exit sweep kills the process, not the disk. Inside `process.on("exit")`
   * no timers, I/O callbacks, or microtasks run, so it cannot await SIGKILL
   * escalation, kill a POSIX descendant tree, or remove disk state. A child
   * that ignores SIGTERM therefore survives, and after a signal-killed or
   * crashed parent, residue can remain under the scratch parent directory.
   *
   * Do not rely on the operating system to reap it: `os.tmpdir()` is not
   * cleared on process exit — Linux reaps it via `systemd-tmpfiles` timers or
   * a reboot, macOS on periodic cycles. For deterministic cleanup, pass an
   * explicit scratch directory you own and sweep its `agent-sdk-*` entries
   * yourself.
   *
   * Use `close()`, or a higher-level awaitable shutdown, for guaranteed
   * escalation and disk removal.
   *
   * @defaultValue `false`
   */
  autoCleanup?: boolean
}

export type TuiOptions = {
  project?: string
  model?: string
  session?: string
  agent?: string
  signal?: AbortSignal
  config?: Config
}

export async function createCognitioServer(options?: ServerOptions) {
  const hostname = options?.hostname ?? "127.0.0.1"
  const port = options?.port ?? 4096
  const timeout = options?.timeout ?? 5000
  const args = [`serve`, `--hostname=${hostname}`, `--port=${port}`]
  if (options?.config?.logLevel) args.push(`--log-level=${options.config.logLevel}`)

  const shutdownTimeout = options?.shutdownTimeout ?? 5000
  const proc = launch(options?.command ?? `cognitio`, args, {
    env: {
      ...(options?.inheritEnv !== false ? process.env : {}),
      ...(options?.env ?? {}),
      COGNITIO_CONFIG_CONTENT: JSON.stringify(options?.config ?? {}),
    },
  })
  const deregister = options?.autoCleanup === true ? registerAutoCleanup(proc) : () => {}
  let stopping: Promise<void> | undefined
  // Deregistration is deliberately on the fulfilled branch only. `stopAndWait`
  // rejects with `ChildTerminationError` when the child is *still alive* after
  // SIGKILL and a liveness probe — precisely the case where the process-exit
  // sweep is the last thing that might reap it. Untracking there would abandon
  // it. So a child that refuses to die keeps its registry slot, and with it the
  // one `exit` listener, for the rest of the process's life. Children that
  // actually exit deregister here or via their own `exit` event.
  const settle = () =>
    (stopping ??= stopAndWait(proc, shutdownTimeout).then(() => {
      deregister()
    }))
  let clear = () => {}

  const url = await new Promise<string>((resolve, reject) => {
    // Every failure path stops the child and rejects only after it has
    // actually exited, so callers can safely clean up owned resources
    // (e.g. scratch dirs) as soon as the rejection lands. The first failure
    // wins: stopping the child triggers its exit handler, which must not
    // overwrite the original reason (e.g. an abort or timeout).
    let failure: unknown
    let failed = false
    let resolved = false
    const fail = (reason: unknown) => {
      if (failed) return
      failed = true
      failure = reason
      // Once a failure path has started killing the child, a buffered
      // readiness line must not resolve the promise with a URL for a dying
      // process. `resolved` gates the stdout handler below.
      resolved = true
      clear()
      // Reject with the original startup reason once the child settled. If
      // termination could NOT be confirmed, surface that via an AggregateError
      // (carrying the ChildTerminationError) so the caller knows the child may
      // still be alive and can preserve any resources it owns (leak-safe).
      void settle().then(
        () => reject(failure),
        (killErr) =>
          reject(
            killErr instanceof ChildTerminationError
              ? new AggregateError(
                  [failure, killErr],
                  "server startup failed and the child could not be confirmed terminated",
                )
              : failure,
          ),
      )
    }
    const id = setTimeout(() => {
      fail(new Error(`Timeout waiting for server to start after ${timeout}ms`))
    }, timeout)
    let output = ""
    proc.stdout?.on("data", (chunk) => {
      if (resolved) return
      output += chunk.toString()
      const lines = output.split("\n")
      for (const line of lines.slice(0, -1)) {
        if (line.startsWith("agent server listening at ")) {
          const match = line.match(/at\s+(https?:\/\/[^\s]+)/)
          if (!match) {
            clearTimeout(id)
            fail(new Error(`Failed to parse server url from output: ${line}`))
            return
          }
          clearTimeout(id)
          resolved = true
          resolve(match[1]!)
          return
        }
      }
    })
    proc.stderr?.on("data", (chunk) => {
      if (resolved) return
      output += chunk.toString()
    })
    proc.on("exit", (code) => {
      clearTimeout(id)
      let msg = `Server exited with code ${code}`
      if (output.trim()) {
        msg += `\nServer output: ${output}`
      }
      fail(new Error(msg))
    })
    proc.on("error", (error) => {
      clearTimeout(id)
      fail(error)
    })
    clear = bindAbort(proc, options?.signal, () => {
      clearTimeout(id)
      fail(options?.signal?.reason)
    })
  })

  if (options?.autoCleanup === true) {
    for (const stream of [proc.stdout, proc.stderr, proc.stdin]) {
      const unref = (stream as { unref?: () => void } | null)?.unref
      if (typeof unref === "function") unref.call(stream)
    }
    if (typeof proc.unref === "function") proc.unref()
  }

  return {
    url,
    close() {
      clear()
      return settle()
    },
  }
}

export function createCognitioTui(options?: TuiOptions) {
  const args = []

  if (options?.project) {
    args.push(`--project=${options.project}`)
  }
  if (options?.model) {
    args.push(`--model=${options.model}`)
  }
  if (options?.session) {
    args.push(`--session=${options.session}`)
  }
  if (options?.agent) {
    args.push(`--agent=${options.agent}`)
  }

  const proc = launch(`cognitio`, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      COGNITIO_CONFIG_CONTENT: JSON.stringify(options?.config ?? {}),
    },
  })

  const clear = bindAbort(proc, options?.signal)

  return {
    close() {
      clear()
      stop(proc)
    },
  }
}

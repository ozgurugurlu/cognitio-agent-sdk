import { sdkError } from "../../errors.js"
import type { ChildProcess } from "node:child_process"
import launch from "cross-spawn"
import { type Config } from "./gen/types.gen.js"
import { stopAndWait, drainOutput, bindAbort, ChildTerminationError, registerAutoCleanup } from "./process.js"
import { describeMissingBinary, resolveServerBinary } from "./resolve-binary.js"
import { EXPECTED_SERVER_VERSION } from "./runtime-version.js"

export { ChildTerminationError } from "./process.js"

/**
 * The fully-resolved spawn, handed to `ServerOptions.spawnProcess`.
 *
 * By the time this exists the binary has already been chosen; a custom spawner
 * decides *how* to run it, never *which* one to run.
 */
export type SpawnServerRequest = {
  command: string
  args: string[]
  env: Record<string, string>
  signal?: AbortSignal
}

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
  /**
   * Explicit server binary. Overrides COGNITIO_BIN_PATH, the bundled platform
   * package, and PATH. Relative paths resolve against `process.cwd()`; a bare
   * command name is rejected.
   *
   * This is the only binary-selection name at this layer — `spawnProcess`
   * receives whatever this resolves to and cannot change it.
   */
  command?: string
  /**
   * Replace the default child spawn — containers, VMs, remote hosts.
   *
   * Receives the already-resolved command/args/env/signal and is called exactly
   * once. The returned object must behave like a node `ChildProcess`: piped
   * `stdout` and `stderr`, `on`/`once`/`off` for `exit` and `error`, `kill(signal?)`, `pid`,
   * `unref`, and — load-bearing for shutdown — `exitCode` and `signalCode`,
   * which are null or undefined while running and non-null once it exits.
   * A real `ChildProcess` satisfies this contract. Because the caller owns the process, the post-readiness
   * version check is skipped for this path.
   */
  spawnProcess?: (request: SpawnServerRequest) => ChildProcess
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

/**
 * Confirms an implicitly-resolved binary is this fork's server.
 *
 * Upstream `cognitio-*` builds are **unusable** here: Phases 0-9 added the
 * runtime-config, control-channel and checkpoint routes this SDK depends on.
 * Without this check a PATH-resolved upstream binary connects cleanly and then
 * fails later with confusing 404s.
 *
 * Only the two sources the SDK chose for the caller are verified. `binaryPath`,
 * `COGNITIO_BIN_PATH` and `spawnProcess` are explicit caller choices and are
 * left alone — the check exists to catch what *we* picked, not to second-guess
 * a deliberate override.
 *
 * Returns a human-readable problem, or `undefined` when the server is good.
 */
type VersionCheck = { ok: true } | { ok: false; reachable: boolean; detail: string }

async function verifyServerVersion(
  url: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<VersionCheck> {
  const headers: Record<string, string> = {}
  // `/global/health` sits behind AuthMiddleware, which only engages when the
  // server was given a password. Reuse the child's own credentials so a
  // password-protected spawn does not read as a version mismatch.
  const password = env["COGNITIO_SERVER_PASSWORD"]
  if (password) {
    const username = env["COGNITIO_SERVER_USERNAME"] ?? "cognitio"
    headers["authorization"] = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  }
  let version: unknown
  try {
    const response = await fetch(new URL("/global/health", url), {
      headers,
      // The caller's signal as well as the timeout: an abort mid-check should
      // end the request immediately rather than wait for the child's death to
      // break the connection.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      return { ok: false, reachable: true, detail: `GET /global/health returned HTTP ${response.status}` }
    }
    version = ((await response.json()) as { version?: unknown }).version
  } catch (error) {
    // Unreachable is NOT incompatible. A server that died between announcing
    // readiness and answering this request has a real cause of its own, and
    // asserting "this is probably an upstream build" over the top of it is a
    // confidently wrong diagnosis.
    return {
      ok: false,
      reachable: false,
      detail: `GET /global/health failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (version === EXPECTED_SERVER_VERSION) return { ok: true }
  return {
    ok: false,
    reachable: true,
    detail: `the server reports version ${JSON.stringify(version)} but this SDK requires ${JSON.stringify(EXPECTED_SERVER_VERSION)}`,
  }
}

export async function createCognitioServer(options?: ServerOptions) {
  const hostname = options?.hostname ?? "127.0.0.1"
  const port = options?.port ?? 4096
  const timeout = options?.timeout ?? 5000
  const args = [`serve`, `--hostname=${hostname}`, `--port=${port}`]
  if (options?.config?.logLevel) args.push(`--log-level=${options.config.logLevel}`)

  const shutdownTimeout = options?.shutdownTimeout ?? 5000
  const binary = resolveServerBinary({ ...(options?.command === undefined ? {} : { binaryPath: options.command }) })
  const env: Record<string, string> = {
    ...((options?.inheritEnv !== false ? process.env : {}) as Record<string, string>),
    ...(options?.env ?? {}),
    COGNITIO_CONFIG_CONTENT: JSON.stringify(options?.config ?? {}),
  }
  const request: SpawnServerRequest = {
    command: binary.command,
    args,
    env,
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  }
  const proc = options?.spawnProcess ? options.spawnProcess(request) : launch(request.command, request.args, { env })
  // Only what the SDK chose for the caller is verified — see verifyServerVersion.
  const verify = options?.spawnProcess ? false : binary.source === "package" || binary.source === "path"
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
  // Hoisted so the post-readiness gate can prefer it. Once the readiness promise
  // has fulfilled, `fail()`'s `reject` is a no-op, and the real reason a child
  // died — its exit code and the output captured during startup — would
  // otherwise be dropped on the floor.
  let startupFailure: unknown

  const url = await new Promise<string>((resolve, reject) => {
    // Every failure path stops the child and rejects only after it has
    // actually exited, so callers can safely clean up owned resources
    // (e.g. scratch dirs) as soon as the rejection lands. The first failure
    // wins: stopping the child triggers its exit handler, which must not
    // overwrite the original reason (e.g. an abort or timeout).
    let failure: unknown
    let failed = false
    let resolved = false
    let draining = false
    const fail = (reason: unknown, afterDrain?: () => unknown) => {
      if (failed) return
      failed = true
      failure = reason
      startupFailure = reason
      // Once a failure path has started killing the child, a buffered
      // readiness line must not resolve the promise with a URL for a dying
      // process. `resolved` gates the stdout handler below.
      resolved = true
      clear()
      draining = afterDrain !== undefined
      const drained = afterDrain
        ? drainOutput(proc, shutdownTimeout).then(() => {
            draining = false
            failure = afterDrain()
            startupFailure = failure
          })
        : Promise.resolve()
      // Reject with the original startup reason once the child settled. If
      // termination could NOT be confirmed, surface that via an AggregateError
      // (carrying the ChildTerminationError) so the caller knows the child may
      // still be alive and can preserve any resources it owns (leak-safe).
      void Promise.all([settle(), drained]).then(
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
      fail(sdkError("binary", `Timeout waiting for server to start after ${timeout}ms`))
    }, timeout)
    let output = ""
    proc.stdout?.on("data", (chunk) => {
      if (resolved && !draining) return
      output += chunk.toString()
      if (resolved) return
      const lines = output.split("\n")
      for (const line of lines.slice(0, -1)) {
        if (line.startsWith("agent server listening at ")) {
          const match = line.match(/at\s+(https?:\/\/[^\s]+)/)
          if (!match) {
            clearTimeout(id)
            fail(sdkError("binary", `Failed to parse server url from output: ${line}`))
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
      if (resolved && !draining) return
      output += chunk.toString()
    })
    proc.on("exit", (code) => {
      clearTimeout(id)
      const exitError = () => {
        let msg = `Server exited with code ${code}`
        if (output.trim()) {
          msg += `\nServer output: ${output}`
        }
        // On win32 a failed PATH lookup never reaches the `error` handler below.
        // `cross-spawn` sees no `.com`/`.exe` extension on an unresolved command,
        // decides a shell is needed, and spawns `%ComSpec%` — which exists — so
        // the child starts, the shell reports "'cognitio' is not recognized", and
        // it exits non-zero. There is no ENOENT to catch, which would leave
        // `describeMissingBinary` unreachable on exactly the two targets that
        // need it most. Appending it here is text-only and cannot change control
        // flow; the real fix belongs with a Windows runner that can verify it.
        if (process.platform === "win32" && binary.source === "path") {
          msg += `\n\n${describeMissingBinary(binary, process.platform, process.arch)}`
        }
        return sdkError("binary", msg)
      }
      // Reserve the exit failure now, but format pre-readiness diagnostics
      // only after the pipes drain. Buffered readiness must never win here.
      fail(exitError(), resolved ? undefined : exitError)
    })
    proc.on("error", (error) => {
      clearTimeout(id)
      // ENOENT here means the resolution chain came up empty. Say which step we
      // ended on and name every escape, rather than surfacing a bare spawn
      // error. No pre-flight existsSync: it would bypass the settle-then-reject
      // machinery above, and 0.2.117 of Claude's SDK removed theirs for the
      // same reason.
      const enoent = (error as NodeJS.ErrnoException).code === "ENOENT"
      fail(
        enoent
          ? sdkError("binary", describeMissingBinary(binary, process.platform, process.arch), { cause: error })
          : error,
      )
    })
    clear = bindAbort(proc, options?.signal, () => {
      clearTimeout(id)
      fail(options?.signal?.reason)
    })
  })

  // Post-readiness compatibility gate. `resolved` is already true inside the
  // promise above, so this mirrors `fail()`'s settle-then-reject discipline
  // rather than calling into it: the child must be confirmed dead before the
  // rejection lands, so `transport/spawn.ts` can safely remove its owned
  // scratch — and an unconfirmed kill must still surface as an AggregateError
  // carrying the ChildTerminationError, so the scratch is preserved instead.
  if (verify) {
    const check = await verifyServerVersion(url, env, timeout, options?.signal)
    // An abort during this window kills the child through the still-live abort
    // binding, which makes the health request fail — and reporting that as
    // "this is probably an upstream cognitio build" would be an actively wrong
    // diagnosis of the caller's own cancellation. The readiness promise has
    // already fulfilled, so `fail()`'s reject is a no-op and this is the only
    // place left that can surface the real reason.
    if (options?.signal?.aborted) {
      clear()
      const reason = options.signal.reason ?? sdkError("binary", "server startup aborted")
      // Swallowing the settle error here would drop a ChildTerminationError, so
      // `transport/spawn.ts`'s `terminationUnconfirmed()` would read this as a
      // clean abort and delete the scratch HOME/XDG world of a child that is
      // still running. Same wrapping as the version-mismatch branch below.
      let killErr: unknown
      try {
        await settle()
      } catch (error) {
        killErr = error
      }
      if (killErr instanceof ChildTerminationError) {
        throw new AggregateError(
          [reason, killErr],
          "server startup was aborted and the child could not be confirmed terminated",
        )
      }
      throw reason
    }
    if (!check.ok) {
      clear()
      const where =
        binary.source === "path"
          ? `Resolved "${binary.command}" from PATH`
          : `Resolved ${binary.command} from ${binary.candidate}`

      // Snapshot BEFORE settling. Settling kills the child, which fires its own
      // exit handler and sets `startupFailure` — so reading it afterwards would
      // report every version mismatch as "server exited", i.e. as our own kill.
      // What matters is whether the child had already failed on its own.
      const priorFailure = startupFailure
      let killErr: unknown
      try {
        await settle()
      } catch (error) {
        killErr = error
      }
      // A child that died on its own between announcing readiness and answering
      // the health check has a concrete reason — exit code plus captured
      // output — and it beats any guess about compatibility. Give it a moment
      // to be recorded: the exit event may still be in flight when an
      // unreachable server is what put us here.
      const observed =
        priorFailure ??
        (check.reachable
          ? undefined
          : await settle().then(
              () => startupFailure,
              () => startupFailure,
            ))

      const failure =
        observed !== undefined
          ? observed
          : check.reachable
            ? sdkError(
                "binary",
                `The cognitio server at ${url} is not compatible with this SDK: ${check.detail}. ${where}. ` +
                  `This is most likely an upstream cognitio build, which does not implement the runtime-config, ` +
                  `control-channel and checkpoint routes this SDK needs. ` +
                  `Install the bundled platform package, or point spawn.binaryPath / COGNITIO_BIN_PATH at a matching build.`,
              )
            : sdkError(
                "binary",
                `The cognitio server at ${url} announced readiness but could not be reached: ${check.detail}. ` +
                  `${where}. The server may have exited, or may be listening on an address this process cannot ` +
                  `reach — check spawn.hostname.`,
              )
      if (killErr instanceof ChildTerminationError) {
        throw new AggregateError(
          [failure, killErr],
          "the server could not be verified and the child could not be confirmed terminated",
        )
      }
      throw failure
    }
  }

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

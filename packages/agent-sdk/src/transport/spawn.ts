import { sdkError } from "../errors.js"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ChildTerminationError, createCognitioClient, createCognitioServer } from "../internal/runtime-client/index.js"
import {
  assertAuthContent,
  buildIsolatedEnv,
  isCognitioEnvKey,
  isReservedEnvKey,
  scratchLayout,
} from "../internal/spawn-env.js"

/** True when an error indicates the spawned child could not be confirmed dead. */
export function terminationUnconfirmed(error: unknown): boolean {
  if (error instanceof ChildTerminationError) return true
  return error instanceof AggregateError && error.errors.some((e) => e instanceof ChildTerminationError)
}
import type { ClientOptions } from "../types.js"
import type { Transport } from "./index.js"

const NON_ISOLATED_RESERVED = ["COGNITIO_AUTH_CONTENT", "COGNITIO_CONFIG_CONTENT"]

export async function createSpawnTransport(options: ClientOptions): Promise<Transport> {
  const spawn = options.spawn ?? {}
  const isolated = spawn.isolated !== false

  // All option validation happens before anything is spawned or created on
  // disk, so a rejection here can never leak a process or scratch dir.
  if (!isolated) {
    for (const key of ["passEnv", "scratchDir", "keepScratch"] as const) {
      if (spawn[key] !== undefined) throw sdkError("configuration", `spawn.${key} requires spawn.isolated: true`)
    }
    for (const key of Object.keys(spawn.env ?? {})) {
      if (NON_ISOLATED_RESERVED.includes(key))
        throw sdkError("configuration", `spawn.env must not override reserved key ${key}`)
    }
  } else {
    for (const key of spawn.passEnv ?? []) {
      if (isCognitioEnvKey(key)) {
        throw sdkError(
          "configuration",
          `spawn.passEnv must not include ${key}; use spawn.env, spawn.auth, or spawn.config instead`,
        )
      }
      if (isReservedEnvKey(key)) throw sdkError("configuration", `spawn.passEnv must not include reserved key ${key}`)
    }
    for (const key of Object.keys(spawn.env ?? {})) {
      if (isReservedEnvKey(key)) throw sdkError("configuration", `spawn.env must not override reserved key ${key}`)
    }
  }
  assertAuthContent(spawn.auth)

  // Plan K4: an already-aborted signal must not spawn anything.
  if (spawn.signal?.aborted) {
    throw spawn.signal.reason ?? sdkError("configuration", "spawn aborted before start")
  }

  // The SDK owns a child of scratchDir (or the OS tmpdir); cleanup never
  // touches the caller-provided parent directory itself.
  let ownedScratch: string | undefined
  const removeScratch = async () => {
    if (!ownedScratch || spawn.keepScratch) return
    await rm(ownedScratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }

  let env: Record<string, string> | undefined
  if (isolated) {
    ownedScratch = await mkdtemp(path.join(spawn.scratchDir ?? os.tmpdir(), "agent-sdk-"))
    try {
      const layout = scratchLayout(ownedScratch, process.platform)
      await Promise.all(layout.directories.map((dir) => mkdir(dir, { recursive: true })))
      env = buildIsolatedEnv({
        // Captured at spawn time on purpose: test shims and callers may mutate
        // process.env (e.g. PATH) right before spawning.
        parentEnv: process.env,
        scratch: layout,
        passEnv: spawn.passEnv,
        env: spawn.env,
        auth: spawn.auth,
      })
    } catch (error) {
      await removeScratch()
      throw error
    }
  } else if (spawn.env || spawn.auth) {
    env = {
      ...(spawn.env ?? {}),
      ...(spawn.auth ? { COGNITIO_AUTH_CONTENT: JSON.stringify(spawn.auth) } : {}),
    }
  }

  let server: Awaited<ReturnType<typeof createCognitioServer>>
  try {
    server = await createCognitioServer({
      ...(spawn.hostname !== undefined ? { hostname: spawn.hostname } : {}),
      ...(spawn.port !== undefined ? { port: spawn.port } : {}),
      ...(spawn.timeout !== undefined ? { timeout: spawn.timeout } : {}),
      // `binaryPath` is the public name; `command` is the vendored server's.
      // One binary-selection name per layer, so there is no precedence to
      // reason about. Conditional spread throughout: an explicit `undefined`
      // must never reach the callee and overwrite its default (P13's
      // `Object.assign` bug).
      ...(spawn.binaryPath !== undefined ? { command: spawn.binaryPath } : {}),
      ...(spawn.spawnProcess !== undefined ? { spawnProcess: spawn.spawnProcess } : {}),
      signal: spawn.signal,
      config: isolated ? { share: "disabled", ...spawn.config } : spawn.config,
      shutdownTimeout: spawn.shutdownTimeout,
      env,
      inheritEnv: isolated ? false : undefined,
      ...(spawn.autoCleanup !== undefined ? { autoCleanup: spawn.autoCleanup } : {}),
    })
  } catch (error) {
    // Preserve the scratch when the child could not be confirmed dead — the
    // same confirmed-exit guarantee as the close() path — so we never delete a
    // live child's HOME/XDG world. Otherwise the startup failed cleanly (child
    // reaped) and the scratch is removed best-effort.
    if (!terminationUnconfirmed(error)) await removeScratch().catch(() => {})
    throw error
  }

  const client = createCognitioClient({
    baseUrl: server.url,
    directory: options.directory,
    experimental_workspaceID: options.workspaceId,
  })

  // Memoized: concurrent/repeated closes (including the abort listener below)
  // share one shutdown + scratch cleanup.
  let closing: Promise<void> | undefined
  const close = () => {
    // Scratch is removed ONLY after server.close() confirms the child exited.
    // If close() rejects (termination unconfirmed), the scratch is preserved
    // rather than deleted out from under a live process (leak-safe).
    closing ??= (async () => {
      await server.close()
      await removeScratch()
    })()
    return closing
  }

  // An abort after startup must also run the full cleanup, not just kill the
  // child: without this, aborting between startup and close() leaks scratch.
  // The rejection is swallowed here (the abort IS the teardown, so there may
  // be no close() caller to observe it) — an explicit close() still surfaces
  // any cleanup error.
  const signal = spawn.signal
  const onAbort = () => {
    close().catch(() => {})
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  if (signal?.aborted) onAbort()

  return {
    kind: "spawn",
    baseUrl: server.url,
    client,
    ...(isolated ? { isolated: true } : {}),
    async close() {
      signal?.removeEventListener("abort", onAbort)
      await close()
    },
  }
}

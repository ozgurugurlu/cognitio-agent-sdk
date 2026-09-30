import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"

/**
 * A driveable stand-in for a spawned server, for use with
 * `SpawnOptions.spawnProcess`.
 *
 * This exists so the spawn contract can be asserted without binding a port.
 * The old default-port test spawned a real fake binary with no `spawn.port`,
 * which meant it bound the low-level default 4096 for real — and failed on any
 * machine already running an cognitio-derived process. The constructed argv is
 * the actual thing under test, so drive it directly.
 *
 * `pid` is left `undefined` by default, which makes `stopAndWait` resolve
 * immediately (`process.ts:37`) — the "child exited cleanly" path. Pass a real
 * live `pid` together with a no-op `kill` to exercise the unconfirmed-
 * termination path instead.
 */
export interface FakeChild {
  child: ChildProcess
  /** Emit a well-formed readiness line on stdout. */
  ready(url: string): void
  stdout(chunk: string): void
  stderr(chunk: string): void
  exit(code: number | null): void
  error(error: Error): void
  /** Signals passed to `kill()`, in order. */
  readonly signals: Array<string | number | undefined>
  readonly unrefCount: number
}

export function createFakeChild(options?: { pid?: number; kill?: (signal?: string) => boolean }): FakeChild {
  const emitter = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const signals: Array<string | number | undefined> = []
  let unrefCount = 0
  let exitCode: number | null = null

  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin: new EventEmitter(),
    pid: options?.pid,
    get exitCode() {
      return exitCode
    },
    signalCode: null,
    killed: false,
    kill(signal?: string) {
      signals.push(signal)
      return options?.kill ? options.kill(signal) : true
    },
    unref() {
      unrefCount += 1
    },
  }) as unknown as ChildProcess

  return {
    child,
    ready(url) {
      stdout.emit("data", Buffer.from(`agent server listening at ${url}\n`))
    },
    stdout(chunk) {
      stdout.emit("data", Buffer.from(chunk))
    },
    stderr(chunk) {
      stderr.emit("data", Buffer.from(chunk))
    },
    exit(code) {
      exitCode = code
      emitter.emit("exit", code)
    },
    error(error) {
      emitter.emit("error", error)
    },
    get signals() {
      return signals
    },
    get unrefCount() {
      return unrefCount
    },
  }
}

/**
 * A minimal `/global/health` responder, so a `spawnProcess`-driven server can
 * still be pointed at a real URL when a test needs the compatibility gate to
 * run. Returns the URL and a stop function.
 */
export async function startHealthServer(version: string): Promise<{ url: string; stop(): Promise<void> }> {
  const http = await import("node:http")
  const server = http.createServer((req, res) => {
    if (req.url === "/global/health") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ healthy: true, version }))
      return
    }
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ message: "not found" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

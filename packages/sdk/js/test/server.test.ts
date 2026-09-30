import { beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createCognitioServer, type ServerOptions } from "../src/v2/server.js"
import { createCognitioServer as createLegacyServer } from "../src/server.js"
import { autoCleanupCount, ChildTerminationError, registerAutoCleanup, stopAndWait } from "../src/process.js"

const FAKE = path.join(import.meta.dir, "fixtures", "fake-server.mjs")
const EXIT_CLEANUP_PARENT = path.join(import.meta.dir, "fixtures", "exit-cleanup-parent.mjs")

beforeAll(async () => {
  await fs.chmod(FAKE, 0o755)
})

function start(options?: ServerOptions) {
  return createCognitioServer({ command: FAKE, timeout: 5000, ...options })
}

async function childEnv(url: string): Promise<Record<string, string>> {
  const res = await fetch(`${url}/env`)
  return (await res.json()) as Record<string, string>
}

async function childArgs(url: string): Promise<string[]> {
  const res = await fetch(`${url}/args`)
  return (await res.json()) as string[]
}

// The readiness timer is the only observable of the resolved `timeout`, so the
// default is pinned by recording the delay it schedules rather than by waiting
// five seconds for it to fire.
async function recordDelays<T>(fn: () => Promise<T>): Promise<{ value: T; delays: number[] }> {
  const original = globalThis.setTimeout
  const call = original as unknown as (handler: TimerHandler, delay?: number, ...args: unknown[]) => unknown
  const delays: number[] = []
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    delays.push(delay ?? 0)
    return call(handler, delay, ...args)
  }) as unknown as typeof globalThis.setTimeout
  try {
    return { value: await fn(), delays }
  } finally {
    globalThis.setTimeout = original
  }
}

async function withMarker<T>(fn: () => Promise<T>) {
  process.env.SDK_TEST_MARKER = "marker-value"
  try {
    return await fn()
  } finally {
    delete process.env.SDK_TEST_MARKER
  }
}

// The fake-server fixture is a shebang .mjs executed via cross-spawn; skipped
// on win32 where shebang resolution needs a POSIX shell. Production spawn of a
// real cognitio binary is cross-platform and covered elsewhere.
describe.skipIf(process.platform === "win32")("createCognitioServer options", () => {
  test("explicit undefined hostname, port, and timeout preserve low-level defaults", async () => {
    const server = await start({ hostname: undefined, port: undefined, timeout: undefined })
    try {
      expect(await childArgs(server.url)).toContain("--hostname=127.0.0.1")
      expect(await childArgs(server.url)).toContain("--port=4096")
    } finally {
      await server.close()
    }
  })

  test("port 0 reaches the child as --port=0 instead of falling back to 4096", async () => {
    // Nullish coalescing, not `||`: 0 is a legitimate request for an OS-assigned port.
    const server = await start({ port: 0 })
    try {
      expect(await childArgs(server.url)).toContain("--port=0")
    } finally {
      await server.close()
    }
  })

  test("explicit undefined timeout schedules readiness at the 5000ms default", async () => {
    const fallback = await recordDelays(() => createCognitioServer({ command: FAKE, timeout: undefined }))
    const explicit = await recordDelays(() => createCognitioServer({ command: FAKE, timeout: 4321 }))
    try {
      expect(fallback.delays).toContain(5000)
      expect(explicit.delays).toContain(4321)
      expect(explicit.delays).not.toContain(5000)
    } finally {
      await fallback.value.close()
      await explicit.value.close()
    }
  })

  test("inherits parent env by default and always sets COGNITIO_CONFIG_CONTENT", async () => {
    await withMarker(async () => {
      const server = await start()
      try {
        const env = await childEnv(server.url)
        expect(env.SDK_TEST_MARKER).toBe("marker-value")
        expect(env.COGNITIO_CONFIG_CONTENT).toBe("{}")
      } finally {
        await server.close()
      }
    })
  })

  test("env option reaches the child and config wins the reserved key", async () => {
    const server = await start({ env: { EXTRA_VAR: "extra" }, config: { snapshot: false } })
    try {
      const env = await childEnv(server.url)
      expect(env.EXTRA_VAR).toBe("extra")
      expect(JSON.parse(env.COGNITIO_CONFIG_CONTENT!)).toEqual({ snapshot: false })
    } finally {
      await server.close()
    }
  })

  test("inheritEnv false drops the parent env", async () => {
    await withMarker(async () => {
      const server = await start({
        inheritEnv: false,
        env: { PATH: process.env.PATH! },
      })
      try {
        const env = await childEnv(server.url)
        expect(env.SDK_TEST_MARKER).toBeUndefined()
        expect(env.PATH).toBe(process.env.PATH!)
      } finally {
        await server.close()
      }
    })
  })

  test("command-not-found rejects without hanging", async () => {
    const baseline = process.listenerCount("exit")
    await expect(
      createCognitioServer({
        command: "/nonexistent/definitely-missing-binary",
        timeout: 3000,
        autoCleanup: true,
      }),
    ).rejects.toThrow()
    expect(autoCleanupCount()).toBe(0)
    expect(process.listenerCount("exit")).toBe(baseline)
  })

  test("early exit rejects with the child output", async () => {
    await expect(start({ env: { FAKE_MODE: "exit" } })).rejects.toThrow(/exited with code 7[\s\S]*boom/)
  })

  test("early exit drains a pipe still held by a short-lived descendant", async () => {
    await expect(start({ env: { FAKE_MODE: "exit-buffered" } })).rejects.toThrow(/exited with code 7[\s\S]*boom/)
  })

  test("the legacy root server also drains early-exit diagnostics", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cognitio-legacy-diagnostics-"))
    const previousPath = process.env.PATH
    const previousMode = process.env.FAKE_MODE
    try {
      await fs.copyFile(FAKE, path.join(directory, "cognitio"))
      await fs.chmod(path.join(directory, "cognitio"), 0o755)
      process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`
      process.env.FAKE_MODE = "exit-buffered"
      await expect(createLegacyServer()).rejects.toThrow(/exited with code 7[\s\S]*boom/)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousMode === undefined) delete process.env.FAKE_MODE
      else process.env.FAKE_MODE = previousMode
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test("readiness timeout rejects after the child has been reaped", async () => {
    await expect(start({ env: { FAKE_MODE: "silent" }, timeout: 300 })).rejects.toThrow(
      /Timeout waiting for server to start/,
    )
  })

  test("readiness parse failure rejects", async () => {
    await expect(start({ env: { FAKE_MODE: "bad-url" } })).rejects.toThrow(/Failed to parse server url/)
  })

  test("abort during startup rejects with the signal reason", async () => {
    const controller = new AbortController()
    const pending = start({ env: { FAKE_MODE: "silent" }, signal: controller.signal, timeout: 10000 })
    setTimeout(() => controller.abort(new Error("aborted by test")), 100)
    await expect(pending).rejects.toThrow("aborted by test")
  })

  test("close returns a promise that resolves after exit and is idempotent", async () => {
    const server = await start()
    const closing = server.close()
    expect(closing).toBeInstanceOf(Promise)
    expect(server.close()).toBe(closing)
    await closing
    await server.close()
  })

  test("autoCleanup uses shared exit and signal listeners and deregisters after confirmed close", async () => {
    const baseline = {
      exit: process.listenerCount("exit"),
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    }
    const first = await start({ autoCleanup: true, port: 0 })
    const second = await start({ autoCleanup: true, port: 0 })
    expect(autoCleanupCount()).toBe(2)
    expect(process.listenerCount("exit")).toBe(baseline.exit + 1)
    expect(process.listenerCount("SIGINT")).toBe(baseline.sigint + 1)
    expect(process.listenerCount("SIGTERM")).toBe(baseline.sigterm + 1)

    await first.close()
    expect(autoCleanupCount()).toBe(1)
    expect(process.listenerCount("exit")).toBe(baseline.exit + 1)
    await second.close()
    expect(autoCleanupCount()).toBe(0)
    expect(process.listenerCount("exit")).toBe(baseline.exit)
  })

  test("SIGTERM-ignoring child is force-killed after shutdownTimeout", async () => {
    const server = await start({ env: { FAKE_SIGTERM_IGNORE: "1" }, shutdownTimeout: 250 })
    const started = Date.now()
    await server.close()
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(200)
    expect(elapsed).toBeLessThan(5000)
  }, 10000)
})

describe("autoCleanup registry", () => {
  test("an ENOENT-style error deregisters a child that never received a pid", () => {
    const baseline = process.listenerCount("exit")
    const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess & {
      pid: undefined
      exitCode: null
      signalCode: null
      kill: () => boolean
    }
    child.pid = undefined
    child.exitCode = null
    child.signalCode = null
    child.kill = () => false
    registerAutoCleanup(child)
    expect(autoCleanupCount()).toBe(1)
    expect(process.listenerCount("exit")).toBe(baseline + 1)
    child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    expect(autoCleanupCount()).toBe(0)
    expect(process.listenerCount("exit")).toBe(baseline)
  })

  // Deliberate, and the reason the "listener count returns to baseline"
  // guarantee is scoped to children that actually exit: a child whose death was
  // never confirmed keeps its slot, because the exit sweep is the last thing
  // that might reap it. `close()` reflects this — it only deregisters on the
  // fulfilled branch of `stopAndWait`.
  test("a child whose exit is never confirmed keeps its slot and the exit listener", () => {
    const baseline = process.listenerCount("exit")
    const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess & {
      pid: number
      exitCode: null
      signalCode: null
      kill: () => boolean
    }
    child.pid = 999999
    child.exitCode = null
    child.signalCode = null
    child.kill = () => true
    const deregister = registerAutoCleanup(child)
    expect(autoCleanupCount()).toBe(1)
    expect(process.listenerCount("exit")).toBe(baseline + 1)

    // No `exit` event and no pid-less `error`: nothing proves it is gone.
    child.emit("error", new Error("still running"))
    expect(autoCleanupCount()).toBe(1)
    expect(process.listenerCount("exit")).toBe(baseline + 1)

    deregister()
    expect(autoCleanupCount()).toBe(0)
    expect(process.listenerCount("exit")).toBe(baseline)
  })
})

// Uses POSIX `sleep`/`sh`; skipped on win32 (fake-server tests above cover
// the cross-platform paths via process.execPath).
describe.skipIf(process.platform === "win32")("stopAndWait", () => {
  test("resolves only after a real child actually exits", async () => {
    const child = spawn("sleep", ["30"])
    await new Promise((resolve) => child.once("spawn", resolve))
    await stopAndWait(child, 2000)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  }, 10000)

  test("resolves immediately for an already-exited child", async () => {
    const child = spawn("sh", ["-c", "exit 0"])
    await new Promise((resolve) => child.once("exit", resolve))
    await stopAndWait(child, 2000)
  })

  test("rejects when a live child cannot be confirmed terminated", async () => {
    // A fake handle whose kill() ignores every signal, pointed at a real live
    // process — simulates a child that never exits under SIGTERM or SIGKILL.
    const real = spawn("sleep", ["30"])
    await new Promise((resolve) => real.once("spawn", resolve))
    const fake = new EventEmitter() as unknown as import("node:child_process").ChildProcess & {
      pid: number
      exitCode: null
      signalCode: null
      kill: () => boolean
    }
    fake.pid = real.pid!
    fake.exitCode = null
    fake.signalCode = null
    fake.kill = () => true
    try {
      await expect(stopAndWait(fake, 100)).rejects.toBeInstanceOf(ChildTerminationError)
      // the real process is still alive — the promise did NOT falsely resolve
      expect(real.exitCode).toBeNull()
    } finally {
      real.kill("SIGKILL")
    }
  }, 5000)

  test("a synchronous throw from stop() does not bypass the escalation", async () => {
    // The initial kill throws synchronously; escalation (SIGKILL→liveness) must
    // still run and, since the real child stays alive, reject with a typed
    // ChildTerminationError rather than the raw throw — and NOT resolve at 0ms.
    const real = spawn("sleep", ["30"])
    await new Promise((resolve) => real.once("spawn", resolve))
    const fake = new EventEmitter() as unknown as import("node:child_process").ChildProcess & {
      pid: number
      exitCode: null
      signalCode: null
      kill: () => boolean
    }
    fake.pid = real.pid!
    fake.exitCode = null
    fake.signalCode = null
    fake.kill = () => {
      throw new Error("kill boom")
    }
    const started = Date.now()
    try {
      const error = await stopAndWait(fake, 100).then(
        () => undefined,
        (e) => e,
      )
      expect(error).toBeInstanceOf(ChildTerminationError)
      expect(Date.now() - started).toBeGreaterThanOrEqual(100)
      expect(real.exitCode).toBeNull()
    } finally {
      real.kill("SIGKILL")
    }
  }, 5000)
})

function cleanupParent(mode: "natural" | "exit7" | "signal", autoCleanup: boolean | "unset", ignoreSigterm = false) {
  const child = spawn(process.execPath, [EXIT_CLEANUP_PARENT, mode, String(autoCleanup)], {
    env: {
      ...process.env,
      ...(ignoreSigterm ? { FAKE_SIGTERM_IGNORE: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  let errors = ""
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString()
  })
  child.stderr?.on("data", (chunk) => {
    errors += chunk.toString()
  })
  const pid = waitForValue(() => {
    const lines = output.split("\n")
    lines.pop()
    const line = lines.map((item) => item.trim()).find((item) => item.startsWith("{"))
    if (!line) return
    return (JSON.parse(line) as { pid: number }).pid
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  return { child, pid, exited, errors: () => errors }
}

async function waitForValue<T>(read: () => T | undefined, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error("timed out waiting for child output")
}

async function waitForExit(exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>, timeout = 5000) {
  return Promise.race([
    exited,
    Bun.sleep(timeout).then(() => {
      throw new Error("timed out waiting for parent exit")
    }),
  ])
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function waitForDead(pid: number, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return
    await Bun.sleep(20)
  }
  throw new Error(`child process ${pid} survived cleanup`)
}

describe.skipIf(process.platform === "win32")("autoCleanup process exit behavior", () => {
  test("SIGTERM awaits forceful shutdown of a child that ignores SIGTERM", async () => {
    const parent = cleanupParent("signal", true, true)
    const pid = await parent.pid
    try {
      parent.child.kill("SIGTERM")
      expect(await waitForExit(parent.exited, 8000)).toEqual({ code: 143, signal: null })
      await waitForDead(pid)
    } finally {
      if (processAlive(pid)) process.kill(pid, "SIGKILL")
      if (parent.child.exitCode === null) parent.child.kill("SIGKILL")
    }
  }, 12000)

  test("autoCleanup unrefs after readiness so natural fallthrough exits and stops the direct child", async () => {
    const parent = cleanupParent("natural", true)
    const pid = await parent.pid
    const result = await waitForExit(parent.exited)
    expect(result).toEqual({ code: 0, signal: null })
    await waitForDead(pid)
  }, 10000)

  test("process.exit preserves its status and synchronously stops a well-behaved direct child", async () => {
    const parent = cleanupParent("exit7", true)
    const pid = await parent.pid
    const result = await waitForExit(parent.exited)
    expect(result).toEqual({ code: 7, signal: null })
    await waitForDead(pid)
  }, 10000)

  test("autoCleanup defaults false and leaves the parent lifetime behavior unchanged", async () => {
    const parent = cleanupParent("natural", "unset")
    const pid = await parent.pid
    try {
      const early = await Promise.race([parent.exited.then(() => true), Bun.sleep(300).then(() => false)])
      expect(early).toBe(false)
      expect(processAlive(pid)).toBe(true)
    } finally {
      parent.child.kill("SIGKILL")
      await waitForExit(parent.exited)
      if (processAlive(pid)) process.kill(pid, "SIGKILL")
      await waitForDead(pid)
    }
  }, 10000)

  test("the synchronous exit sweep honestly cannot escalate past an ignored SIGTERM", async () => {
    const parent = cleanupParent("exit7", true, true)
    const pid = await parent.pid
    try {
      const result = await waitForExit(parent.exited)
      expect(result).toEqual({ code: 7, signal: null })
      await Bun.sleep(200)
      expect(processAlive(pid)).toBe(true)
    } finally {
      if (processAlive(pid)) process.kill(pid, "SIGKILL")
      await waitForDead(pid)
    }
  }, 10000)
})

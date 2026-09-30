import { describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  ChildTerminationError,
  createCognitioClient,
  EXPECTED_SERVER_VERSION,
  type SpawnServerRequest,
} from "../src/internal/runtime-client/index.js"
import {
  Agent,
  createAgentClient,
  createSdkMcpServer,
  defineTool,
  NEUTRAL_BASE_PROMPT,
  query,
  shutdown,
} from "../src/index.js"
import type { Query, ResultMessage } from "../src/index.js"
import { acquireCanonicalClient, clientState } from "../src/internal/shared-client.js"
import { terminationUnconfirmed } from "../src/transport/spawn.js"
import { reserveLocalPort } from "./port.js"

const fakeServerEntry = join(import.meta.dir, "fixtures", "fake-cognitio-server.mjs")
const facadeLifecycleFixture = join(import.meta.dir, "fixtures", "facade-lifecycle-parent.mjs")
const realCognitioAvailable = !!Bun.which("cognitio") && process.env.AGENT_SDK_REAL_COGNITIO_SMOKE === "1"

function withFakeCognitioBin(options?: {
  readyDelayMs?: number
  pidFile?: string
  sigtermIgnore?: boolean
  /** What the fake reports from GET /global/health. Unset = the version this SDK expects. */
  serverVersion?: string
  /** Hold /global/health open for N ms, to make the compatibility-check window observable. */
  healthDelayMs?: number
}) {
  const binDir = mkdtempSync(join(tmpdir(), "agent-sdk-cognitio-bin-"))
  const wrapper = join(binDir, "cognitio")
  const previousPath = process.env.PATH
  const setup = [
    options?.pidFile ? `printf '%s' "$$" > ${JSON.stringify(options.pidFile)}` : undefined,
    options?.readyDelayMs !== undefined
      ? `export FAKE_READY_DELAY_MS=${JSON.stringify(String(options.readyDelayMs))}`
      : undefined,
    // Exported inside the wrapper so an isolated child (which never inherits
    // the parent env) still receives the knob.
    options?.sigtermIgnore ? "export FAKE_SIGTERM_IGNORE=1" : undefined,
    options?.serverVersion !== undefined
      ? `export FAKE_SERVER_VERSION=${JSON.stringify(options.serverVersion)}`
      : undefined,
    options?.healthDelayMs !== undefined ? `export FAKE_HEALTH_DELAY_MS=${options.healthDelayMs}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

  // exec so the fake server replaces the wrapper process and inherits its
  // SIGTERM directly — a plain `spawn` wrapper would not forward signals and
  // leaked orphan fake-server processes on every run.
  writeFileSync(
    wrapper,
    `#!/bin/sh
${setup}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeServerEntry)} "$@"
`,
  )
  chmodSync(wrapper, 0o755)
  process.env.PATH = `${binDir}:${previousPath ?? ""}`

  return {
    /** Absolute path to the shim, for tests that pin `spawn.binaryPath`. */
    path: wrapper,
    cleanup() {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      rmSync(binDir, { recursive: true, force: true })
    },
  }
}

function rawDelta(msg: unknown): string | undefined {
  const message = msg as { type?: string; delta?: string }
  if (message.type !== "partial") return
  return message.delta
}

async function childPid(baseUrl: string) {
  return Number(await (await fetch(`${baseUrl}/debug/pid`)).text())
}

/** Run a query to completion and hand back its terminal result. */
async function drainQuery(stream: Query): Promise<ResultMessage> {
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  if (!next.value) throw new Error("query ended without a terminal result")
  return next.value
}

/** The isolated scratch dir the spawner owns, read back off the child's env. */
async function childScratchDir(baseUrl: string) {
  const env = (await (await fetch(`${baseUrl}/debug/env`)).json()) as Record<string, string>
  return dirname(env.HOME!)
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Last-resort reaper for a child a test deliberately left wedged. */
function killIfAlive(pid: number | undefined) {
  if (pid === undefined || !processIsAlive(pid)) return
  try {
    process.kill(pid, "SIGKILL")
  } catch {}
}

function requireDirectory(path: string) {
  mkdirSync(path, { recursive: true })
}

function childExit(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode })
      return
    }
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function startFacadeFixture(input: {
  mode:
    | "untouched-query"
    | "before-exit"
    | "owned-sigterm"
    | "owned-sigint"
    | "wedged-sigterm"
    | "settling-second-signal"
    | "host-once"
    | "host-once-continues"
    | "host-later-persistent"
    | "host-removed"
    | "listener-close"
  readyFile: string
  scratchDir?: string
}) {
  const child = spawn(process.execPath, [facadeLifecycleFixture], {
    env: {
      ...process.env,
      FACADE_FIXTURE_MODE: input.mode,
      FACADE_READY_FILE: input.readyFile,
      ...(input.scratchDir ? { FACADE_SCRATCH_DIR: input.scratchDir } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  return {
    child,
    exited: childExit(child),
    stderr: () => stderr,
  }
}

async function readFixtureReady<T>(path: string): Promise<T> {
  await waitFor(() => existsSync(path))
  return JSON.parse(readFileSync(path, "utf8")) as T
}

describe.skipIf(process.platform === "win32")(
  "cognitio-agent-sdk — spawn smoke (deterministic fake cognitio binary)",
  () => {
    test("bare createAgentClient preserves the low-level hostname, port, and timeout defaults", async () => {
      // The constructed argv is the observable, not a bound socket. The
      // previous shape of this test let the child bind the real default 4096,
      // so it failed on any machine already running an cognitio-derived
      // server — killing an unknown process to get a green suite is not an
      // acceptable instruction. `spawnProcess` runs the same fixture on a port
      // we own while the SDK still resolves every default itself.
      const requests: SpawnServerRequest[] = []
      const ownPort = await reserveLocalPort()
      let child: ChildProcess | undefined
      const client = await createAgentClient({
        spawn: {
          spawnProcess(request) {
            requests.push(request)
            child = spawn(process.execPath, [fakeServerEntry, "serve", "--hostname=127.0.0.1", `--port=${ownPort}`], {
              env: request.env,
              stdio: ["ignore", "pipe", "pipe"],
            })
            return child
          },
        },
      })
      try {
        expect(requests).toHaveLength(1)
        expect(requests[0]!.command).toBe("cognitio")
        expect(requests[0]!.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=4096"])
        expect(client.transportKind).toBe("spawn")
        expect(client.baseUrl).toBe(`http://127.0.0.1:${ownPort}`)
      } finally {
        await client.close()
      }
      expect(child?.exitCode ?? child?.signalCode).not.toBeNull()
    }, 30000)

    test("the compatibility gate accepts a PATH-resolved binary reporting the paired version", async () => {
      const fakeBin = withFakeCognitioBin()
      const port = await reserveLocalPort()
      try {
        const client = await createAgentClient({ spawn: { port } })
        expect(client.baseUrl).toBe(`http://127.0.0.1:${port}`)
        await client.close()
      } finally {
        fakeBin.cleanup()
      }
    }, 30000)

    test("a PATH-resolved binary reporting a different version is rejected, killed, and explained", async () => {
      const fakeBin = withFakeCognitioBin({ serverVersion: "1.14.19" })
      const port = await reserveLocalPort()
      try {
        const error = await createAgentClient({ spawn: { port } }).then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(error).toBeInstanceOf(Error)
        const message = (error as Error).message
        expect(message).toContain("not compatible with this SDK")
        expect(message).toContain('reports version "1.14.19"')
        expect(message).toContain(EXPECTED_SERVER_VERSION)
        expect(message).toContain('Resolved "cognitio" from PATH')
        expect(message).toContain("spawn.binaryPath")
        // Confirmed dead before the rejection landed: the port is free again.
        const rebound = await reserveLocalPort()
        expect(typeof rebound).toBe("number")
        const probe = await fetch(`http://127.0.0.1:${port}/global/health`).then(
          () => "reachable",
          () => "gone",
        )
        expect(probe).toBe("gone")
      } finally {
        fakeBin.cleanup()
      }
    }, 30000)

    test("COGNITIO_BIN_PATH also skips the gate", async () => {
      const fakeBin = withFakeCognitioBin({ serverVersion: "0.0.0-some-other-build" })
      const port = await reserveLocalPort()
      const previous = process.env.COGNITIO_BIN_PATH
      process.env.COGNITIO_BIN_PATH = fakeBin.path
      try {
        const client = await createAgentClient({ spawn: { port } })
        expect(client.baseUrl).toBe(`http://127.0.0.1:${port}`)
        await client.close()
      } finally {
        if (previous === undefined) delete process.env.COGNITIO_BIN_PATH
        else process.env.COGNITIO_BIN_PATH = previous
        fakeBin.cleanup()
      }
    }, 30000)

    test("a rejected version gate still removes the owned scratch", async () => {
      // The leak-safety half of the gate: the child is confirmed dead before
      // the rejection lands, so the transport is free to delete the scratch
      // HOME/XDG world it owns. (The unconfirmed-termination sub-branch cannot
      // be reached from here — the fixture cannot survive SIGKILL — and is
      // covered by `terminationUnconfirmed`'s own branch tests plus the
      // startup-failure AggregateError case in runtime-client.test.ts.)
      const fakeBin = withFakeCognitioBin({ serverVersion: "1.14.19" })
      const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-gate-scratch-"))
      const port = await reserveLocalPort()
      try {
        await expect(createAgentClient({ spawn: { port, isolated: true, scratchDir: scratchParent } })).rejects.toThrow(
          "not compatible with this SDK",
        )
        expect(readdirSync(scratchParent)).toEqual([])
      } finally {
        rmSync(scratchParent, { recursive: true, force: true })
        fakeBin.cleanup()
      }
    }, 30000)

    test("an abort inside the version-check window reports the abort, not a fake incompatibility", async () => {
      // The readiness promise has already fulfilled by the time the gate runs,
      // so the abort binding's reject is a no-op and the health request fails
      // only because the child is being killed. Reporting that as "this is
      // probably an upstream cognitio build" would misdiagnose the caller's own
      // cancellation. The delay makes the window deterministic.
      const fakeBin = withFakeCognitioBin({ healthDelayMs: 3000 })
      const port = await reserveLocalPort()
      const controller = new AbortController()
      try {
        const pending = createAgentClient({ spawn: { port, signal: controller.signal } })
        setTimeout(() => controller.abort(new Error("aborted mid-check")), 400)
        const error = await pending.then(
          () => undefined,
          (e: unknown) => e,
        )
        expect((error as Error).message).toBe("aborted mid-check")
        expect((error as Error).message).not.toContain("not compatible")
      } finally {
        fakeBin.cleanup()
      }
    }, 30000)

    test("a server that announces readiness then dies reports its own failure, not a version guess", async () => {
      // The gate used to report ANY unreachable server as "most likely an
      // upstream cognitio build" — a confident, wrong diagnosis that threw away
      // the exit code and the captured output explaining what actually broke.
      const binDir = mkdtempSync(join(tmpdir(), "agent-sdk-crashy-bin-"))
      const wrapper = join(binDir, "cognitio")
      const previousPath = process.env.PATH
      writeFileSync(
        wrapper,
        `#!/bin/sh\necho "boom: database migration failed" >&2\necho "agent server listening at http://127.0.0.1:45123"\nexit 3\n`,
      )
      chmodSync(wrapper, 0o755)
      process.env.PATH = `${binDir}:${previousPath ?? ""}`
      try {
        const error = await createAgentClient({ spawn: { port: 45123, timeout: 8000 } }).then(
          () => undefined,
          (e: unknown) => e,
        )
        const message = (error as Error).message
        expect(message).toContain("exited with code 3")
        expect(message).toContain("boom: database migration failed")
        expect(message).not.toContain("not compatible with this SDK")
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
        rmSync(binDir, { recursive: true, force: true })
      }
    }, 30000)

    test("an explicit binaryPath skips the gate, so a mismatched build still starts", async () => {
      const fakeBin = withFakeCognitioBin({ serverVersion: "0.0.0-some-other-build" })
      const port = await reserveLocalPort()
      try {
        const client = await createAgentClient({ spawn: { port, binaryPath: fakeBin.path } })
        expect(client.baseUrl).toBe(`http://127.0.0.1:${port}`)
        await client.close()
      } finally {
        fakeBin.cleanup()
      }
    }, 30000)

    test("a spawnProcess that throws still removes the owned scratch", async () => {
      const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-spawnproc-throw-"))
      try {
        await expect(
          createAgentClient({
            spawn: {
              isolated: true,
              scratchDir: scratchParent,
              spawnProcess() {
                throw new Error("custom spawner refused")
              },
            },
          }),
        ).rejects.toThrow("custom spawner refused")
        expect(readdirSync(scratchParent)).toEqual([])
      } finally {
        rmSync(scratchParent, { recursive: true, force: true })
      }
    }, 30000)

    test("spawns through the CLI and exercises create, send, stream, list, and close", async () => {
      const rawTmpDir = mkdtempSync(join(tmpdir(), "agent-sdk-fake-spawn-"))
      const fakeBin = withFakeCognitioBin()
      const tmpDir = realpathSync(rawTmpDir)
      const port = await reserveLocalPort()

      try {
        const client = await createAgentClient({
          directory: tmpDir,
          spawn: { port, hostname: "127.0.0.1", timeout: 15000 },
        })

        try {
          expect(client.transportKind).toBe("spawn")
          expect(client.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)

          const session = await client.sessions.create({
            cwd: tmpDir,
            runtimeConfig: {
              sdkMcpServers: [
                createSdkMcpServer({
                  name: "local-tools",
                  tools: [
                    defineTool({
                      name: "ping",
                      inputSchema: { type: "object", properties: {} },
                      execute: () => "pong",
                    }),
                  ],
                }),
                {
                  name: "remote-tools",
                  type: "remote",
                  url: "https://example.com/mcp",
                  enabled: true,
                  oauth: false,
                },
              ],
            },
          })
          expect(session.directory).toBe(tmpDir)
          const lowLevel = createCognitioClient({ baseUrl: client.baseUrl, directory: tmpDir })
          const patched = await lowLevel.session.runtimeConfig.get({ sessionID: session.id, directory: tmpDir })
          expect(patched.data!.runtimeConfig.sdkMcpServers).toEqual([
            {
              name: "remote-tools",
              type: "remote",
              url: "https://example.com/mcp",
              enabled: true,
              oauth: false,
            },
            {
              name: "local-tools",
              type: "remote",
              ownership: "sdk",
              url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
              enabled: true,
              oauth: false,
            },
          ])

          await session.send("hello")

          const deltas: string[] = []
          for await (const msg of session.stream("hello again", { includePartialMessages: true })) {
            const delta = rawDelta(msg)
            if (delta) deltas.push(delta)
          }

          expect(deltas.join("")).toContain("hello from fake cognitio")

          const listed = await client.sessions.list()
          const found = listed.find((item) => item.id === session.id)
          expect(found).toBeDefined()
          expect(found?.directory).toBe(tmpDir)

          await session.close()
          const afterClose = await lowLevel.session.runtimeConfig.get({ sessionID: session.id, directory: tmpDir })
          expect(afterClose.data!.runtimeConfig.sdkMcpServers).toEqual([
            {
              name: "remote-tools",
              type: "remote",
              url: "https://example.com/mcp",
              enabled: true,
              oauth: false,
            },
          ])
        } finally {
          await client.close()
        }
      } finally {
        fakeBin.cleanup()
        rmSync(rawTmpDir, { recursive: true, force: true })
      }
    }, 30000)
  },
)

async function waitFor(check: () => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  expect(check()).toBe(true)
}

/**
 * Wait until the fake server reports a delivered SIGTERM. With
 * `sigtermIgnore` the child survives it, so this is a deterministic gate on
 * "the awaitable teardown has started" without timing assumptions.
 */
async function waitForChildSigterm(baseUrl: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const signals = await fetch(`${baseUrl}/debug/signals`)
      .then((response) => response.json() as Promise<{ sigterm: number }>)
      .catch(() => undefined)
    if (signals && signals.sigterm > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

describe.skipIf(process.platform === "win32")("cognitio-agent-sdk — facade process ownership", () => {
  test("concurrent canonical Agents share one server; Agent.close preserves it; shutdown replaces it", async () => {
    const fakeBin = withFakeCognitioBin()
    await shutdown()
    const first = new Agent()
    const second = new Agent()
    let replacement: Agent | undefined
    try {
      const [firstClient, secondClient] = await Promise.all([first.client(), second.client()])
      expect(secondClient.baseUrl).toBe(firstClient.baseUrl)
      expect(clientState()).toMatchObject({ canonical: true, dedicated: 0, pending: 0, settling: false })
      const firstPid = await childPid(firstClient.baseUrl)

      await Promise.all([first.close(), second.close()])
      expect(await fetch(`${firstClient.baseUrl}/debug/pid`).then((response) => response.ok)).toBe(true)
      expect(processIsAlive(firstPid)).toBe(true)

      const stopping = shutdown()
      expect(shutdown()).toBe(stopping)
      await stopping
      await waitFor(() => !processIsAlive(firstPid))
      expect(clientState()).toEqual({ canonical: false, dedicated: 0, pending: 0, settling: false })

      replacement = new Agent()
      const replacementClient = await replacement.client()
      expect(await childPid(replacementClient.baseUrl)).not.toBe(firstPid)
    } finally {
      await replacement?.close().catch(() => {})
      await first.close().catch(() => {})
      await second.close().catch(() => {})
      await shutdown().catch(() => {})
      fakeBin.cleanup()
    }
  }, 30000)

  // D11 regression proof on the path the decision actually protects. The
  // mock-server twin of this test passes `baseUrl`, so it exercises a dedicated
  // client against a server the test owns — that survives any ownership model.
  // Only the canonical/spawned path can observe the refcount bug D11 replaced:
  // query()'s private Agent closing drove refs to 0, which killed the spawned
  // server and the isolated scratch holding the session DB.
  test("sequential canonical queries reuse one spawned server, so resume reaches the first query's session", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-sdk-facade-query-resume-"))
    const pidFile = join(stateDir, "spawned-pid")
    const fakeBin = withFakeCognitioBin({ pidFile })
    await shutdown()
    let serverPid: number | undefined
    try {
      // No connection options anywhere below: every query resolves the
      // process-global canonical client.
      const first = query({ prompt: "first canonical query" })
      const sessionId = await first.sessionId()
      expect(await drainQuery(first)).toMatchObject({ sessionId, subtype: "success" })

      // query() closed its private Agent as part of its own teardown, and only
      // shutdown()/beforeExit owns the canonical client (D11).
      expect(clientState()).toMatchObject({ canonical: true, dedicated: 0, pending: 0, settling: false })

      // Observed strictly after the assertion above, so a canonical client that
      // had been torn down could never be silently re-created by this probe.
      const client = await acquireCanonicalClient()
      const spawnedPid = Number(readFileSync(pidFile, "utf8"))
      serverPid = spawnedPid
      expect(processIsAlive(spawnedPid)).toBe(true)
      expect(await childPid(client.baseUrl)).toBe(spawnedPid)
      const scratch = await childScratchDir(client.baseUrl)
      expect(existsSync(scratch)).toBe(true)

      const second = query({ prompt: "second canonical query", options: { resume: sessionId } })
      expect(await drainQuery(second)).toMatchObject({ sessionId, subtype: "success" })

      // Exactly one session create across both queries: the fake server hands
      // out sess-N in creation order and lists every session it ever created,
      // so a second create would show up as a second entry.
      expect((await client.sessions.list()).map((session) => session.id)).toEqual([sessionId])

      // Exactly one spawned process across both queries: the wrapper rewrites
      // the pid file on every exec, and the live server still reports that pid.
      expect(Number(readFileSync(pidFile, "utf8"))).toBe(spawnedPid)
      expect(await childPid(client.baseUrl)).toBe(spawnedPid)
      expect((await acquireCanonicalClient()).baseUrl).toBe(client.baseUrl)
      expect(clientState()).toMatchObject({ canonical: true, dedicated: 0, pending: 0, settling: false })

      await shutdown()
      await waitFor(() => !processIsAlive(spawnedPid))
      expect(clientState()).toEqual({ canonical: false, dedicated: 0, pending: 0, settling: false })
      expect(existsSync(scratch)).toBe(false)
    } finally {
      await shutdown().catch(() => {})
      killIfAlive(serverPid)
      fakeBin.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 30000)

  test("two explicit spawn Agents own distinct processes and scratch directories", async () => {
    const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-facade-dedicated-"))
    const fakeBin = withFakeCognitioBin()
    const first = new Agent({ spawn: { scratchDir: scratchParent, shutdownTimeout: 250 } })
    const second = new Agent({ spawn: { scratchDir: scratchParent, shutdownTimeout: 250 } })
    try {
      const [firstClient, secondClient] = await Promise.all([first.client(), second.client()])
      const firstPid = await childPid(firstClient.baseUrl)
      const secondPid = await childPid(secondClient.baseUrl)
      expect(firstPid).not.toBe(secondPid)
      expect(readdirSync(scratchParent)).toHaveLength(2)
      expect(clientState()).toMatchObject({ canonical: false, dedicated: 2, pending: 0 })

      await first.close()
      await waitFor(() => !processIsAlive(firstPid))
      expect(processIsAlive(secondPid)).toBe(true)
      expect(readdirSync(scratchParent)).toHaveLength(1)
      expect(clientState()).toMatchObject({ canonical: false, dedicated: 1, pending: 0 })

      await second.close()
      await waitFor(() => !processIsAlive(secondPid))
      expect(readdirSync(scratchParent)).toEqual([])
      expect(clientState()).toEqual({ canonical: false, dedicated: 0, pending: 0, settling: false })
    } finally {
      await first.close().catch(() => {})
      await second.close().catch(() => {})
      await shutdown().catch(() => {})
      fakeBin.cleanup()
      rmSync(scratchParent, { recursive: true, force: true })
    }
  }, 30000)

  test("shutdown overtakes a pending canonical spawn without leaking it, then a later Agent retries", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-sdk-facade-race-"))
    const pidFile = join(stateDir, "pid")
    const fakeBin = withFakeCognitioBin({ readyDelayMs: 400, pidFile })
    await shutdown()
    const interrupted = new Agent()
    let replacement: Agent | undefined
    try {
      const pending = interrupted.client()
      await waitFor(() => existsSync(pidFile))
      const pid = Number(readFileSync(pidFile, "utf8"))
      const stopping = shutdown()

      await expect(stopping).resolves.toBeUndefined()
      await expect(pending).rejects.toThrow(/interrupted by shutdown/)
      await waitFor(() => !processIsAlive(pid))
      expect(clientState()).toEqual({ canonical: false, dedicated: 0, pending: 0, settling: false })

      replacement = new Agent()
      const replacementClient = await replacement.client()
      expect(await childPid(replacementClient.baseUrl)).not.toBe(pid)
    } finally {
      await replacement?.close().catch(() => {})
      await interrupted.close().catch(() => {})
      await shutdown().catch(() => {})
      fakeBin.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 30000)

  test("a rejected canonical creation is not memoized, so a later Agent retries and succeeds", async () => {
    const emptyBinDir = mkdtempSync(join(tmpdir(), "agent-sdk-empty-bin-"))
    const fakeBin = withFakeCognitioBin()
    const shimPath = process.env.PATH
    await shutdown()
    const failing = new Agent()
    let replacement: Agent | undefined
    try {
      // No resolvable `cognitio` on PATH: the spawn fails with ENOENT before a
      // server ever exists, which is the deterministic first-creation failure.
      process.env.PATH = emptyBinDir
      await expect(failing.client()).rejects.toThrow()
      expect(clientState()).toEqual({ canonical: false, dedicated: 0, pending: 0, settling: false })

      process.env.PATH = shimPath
      replacement = new Agent()
      const replacementClient = await replacement.client()
      expect(await childPid(replacementClient.baseUrl)).toBeGreaterThan(0)
      expect(clientState()).toMatchObject({ canonical: true, dedicated: 0, pending: 0, settling: false })
    } finally {
      await replacement?.close().catch(() => {})
      await failing.close().catch(() => {})
      await shutdown().catch(() => {})
      fakeBin.cleanup()
      rmSync(emptyBinDir, { recursive: true, force: true })
    }
  }, 20000)

  test("spawn.autoCleanup: false reaches the spawner and the server still dies on Agent.close", async () => {
    const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-facade-no-autocleanup-"))
    const fakeBin = withFakeCognitioBin()
    await shutdown()
    const exitListeners = process.listenerCount("exit")
    const agent = new Agent({ spawn: { scratchDir: scratchParent, shutdownTimeout: 250, autoCleanup: false } })
    let serverPid: number | undefined
    try {
      const client = await agent.client()
      const pid = await childPid(client.baseUrl)
      serverPid = pid
      expect(processIsAlive(pid)).toBe(true)
      // The option is forwarded, so the low-level spawner tracks no child and
      // installs no synchronous exit sweep listener.
      expect(process.listenerCount("exit")).toBe(exitListeners)
      expect(clientState()).toMatchObject({ canonical: false, dedicated: 1, pending: 0 })

      await agent.close()
      await waitFor(() => !processIsAlive(pid))
      expect(readdirSync(scratchParent)).toEqual([])
      expect(clientState()).toEqual({ canonical: false, dedicated: 0, pending: 0, settling: false })
    } finally {
      await agent.close().catch(() => {})
      await shutdown().catch(() => {})
      killIfAlive(serverPid)
      fakeBin.cleanup()
      rmSync(scratchParent, { recursive: true, force: true })
    }
  }, 20000)
})

describe.skipIf(process.platform === "win32")("cognitio-agent-sdk — facade subprocess lifecycle", () => {
  test("an untouched lazy query starts no process and exits naturally", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-sdk-facade-untouched-"))
    const pidFile = join(stateDir, "spawned-pid")
    const fakeBin = withFakeCognitioBin({ pidFile })
    const fixture = startFacadeFixture({
      mode: "untouched-query",
      readyFile: join(stateDir, "ready.json"),
    })
    try {
      const result = await within(fixture.exited, 5000)
      if (result.code !== 0) throw new Error(fixture.stderr())
      expect(result).toEqual({ code: 0, signal: null })
      expect(existsSync(pidFile)).toBe(false)
    } finally {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
      await fixture.exited.catch(() => {})
      fakeBin.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 10000)

  test("beforeExit awaits dedicated server teardown and scratch removal", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-sdk-facade-before-exit-"))
    const scratchParent = join(stateDir, "scratch")
    const fakeBin = withFakeCognitioBin()
    requireDirectory(scratchParent)
    const fixture = startFacadeFixture({
      mode: "before-exit",
      readyFile: join(stateDir, "ready.json"),
      scratchDir: scratchParent,
    })
    try {
      const ready = await readFixtureReady<{ pid: number }>(join(stateDir, "ready.json"))
      const result = await within(fixture.exited, 10000)
      if (result.code !== 0) throw new Error(fixture.stderr())
      expect(result).toEqual({ code: 0, signal: null })
      await waitFor(() => !processIsAlive(ready.pid))
      expect(readdirSync(scratchParent)).toEqual([])
    } finally {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
      await fixture.exited.catch(() => {})
      fakeBin.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 20000)

  test("the sole-listener SIGTERM path exits 143 after awaitable cleanup", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-sdk-facade-sigterm-"))
    const scratchParent = join(stateDir, "scratch")
    const fakeBin = withFakeCognitioBin()
    requireDirectory(scratchParent)
    const fixture = startFacadeFixture({
      mode: "owned-sigterm",
      readyFile: join(stateDir, "ready.json"),
      scratchDir: scratchParent,
    })
    try {
      const ready = await readFixtureReady<{ pid: number }>(join(stateDir, "ready.json"))
      fixture.child.kill("SIGTERM")
      const result = await within(fixture.exited, 10000)
      if (result.code !== 143) throw new Error(fixture.stderr())
      expect(result).toEqual({ code: 143, signal: null })
      await waitFor(() => !processIsAlive(ready.pid))
      expect(readdirSync(scratchParent)).toEqual([])
    } finally {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
      await fixture.exited.catch(() => {})
      fakeBin.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 20000)

  test("the sole-listener SIGINT path exits 130 after awaitable cleanup", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-sdk-facade-sigint-"))
    const scratchParent = join(stateDir, "scratch")
    const fakeBin = withFakeCognitioBin()
    requireDirectory(scratchParent)
    const fixture = startFacadeFixture({
      mode: "owned-sigint",
      readyFile: join(stateDir, "ready.json"),
      scratchDir: scratchParent,
    })
    let serverPid: number | undefined
    try {
      const ready = await readFixtureReady<{ pid: number }>(join(stateDir, "ready.json"))
      serverPid = ready.pid
      fixture.child.kill("SIGINT")
      const result = await within(fixture.exited, 10000)
      if (result.code !== 130) throw new Error(fixture.stderr())
      expect(result).toEqual({ code: 130, signal: null })
      await waitFor(() => !processIsAlive(ready.pid))
      expect(readdirSync(scratchParent)).toEqual([])
    } finally {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
      await fixture.exited.catch(() => {})
      killIfAlive(serverPid)
      fakeBin.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 20000)

  test("the facade signal path reaps a SIGTERM-ignoring child by escalating to SIGKILL", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-sdk-facade-wedged-"))
    const scratchParent = join(stateDir, "scratch")
    const fakeBin = withFakeCognitioBin({ sigtermIgnore: true })
    requireDirectory(scratchParent)
    const fixture = startFacadeFixture({
      mode: "wedged-sigterm",
      readyFile: join(stateDir, "ready.json"),
      scratchDir: scratchParent,
    })
    let serverPid: number | undefined
    try {
      const ready = await readFixtureReady<{ pid: number }>(join(stateDir, "ready.json"))
      serverPid = ready.pid
      const started = Date.now()
      fixture.child.kill("SIGTERM")
      const result = await within(fixture.exited, 10000)
      if (result.code !== 143) throw new Error(fixture.stderr())
      expect(result).toEqual({ code: 143, signal: null })
      // The synchronous exit sweep can only SIGTERM, which this child ignores;
      // the awaited shutdown() escalated to SIGKILL and then removed scratch.
      // Waiting out the fixture's 250 ms grace proves the escalation ran.
      expect(Date.now() - started).toBeGreaterThanOrEqual(250)
      await waitFor(() => !processIsAlive(ready.pid))
      expect(readdirSync(scratchParent)).toEqual([])
    } finally {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
      await fixture.exited.catch(() => {})
      killIfAlive(serverPid)
      fakeBin.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 20000)

  test("a second signal while the first teardown settles exits at once with the signal code", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-sdk-facade-second-signal-"))
    const scratchParent = join(stateDir, "scratch")
    const fakeBin = withFakeCognitioBin({ sigtermIgnore: true })
    requireDirectory(scratchParent)
    const fixture = startFacadeFixture({
      mode: "settling-second-signal",
      readyFile: join(stateDir, "ready.json"),
      scratchDir: scratchParent,
    })
    let serverPid: number | undefined
    try {
      const ready = await readFixtureReady<{ pid: number; baseUrl: string }>(join(stateDir, "ready.json"))
      serverPid = ready.pid
      fixture.child.kill("SIGTERM")
      // The wedged child absorbs the first SIGTERM, so the fixture's 20s grace
      // period keeps shutdown() unsettled while the second signal arrives.
      expect(await waitForChildSigterm(ready.baseUrl)).toBe(true)

      fixture.child.kill("SIGTERM")
      const result = await within(fixture.exited, 8000)
      if (result.code !== 143) throw new Error(fixture.stderr())
      expect(result).toEqual({ code: 143, signal: null })
      // Honest limitation of giving up early: the synchronous sweep only
      // re-sends SIGTERM, so the wedged child and its scratch dir survive.
      expect(processIsAlive(ready.pid)).toBe(true)
      expect(readdirSync(scratchParent)).toHaveLength(1)
    } finally {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
      await fixture.exited.catch(() => {})
      killIfAlive(serverPid)
      fakeBin.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 20000)

  test("a pre-existing once SIGTERM listener keeps ownership of exit policy", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-sdk-facade-host-signal-"))
    const scratchParent = join(stateDir, "scratch")
    const fakeBin = withFakeCognitioBin()
    requireDirectory(scratchParent)
    const fixture = startFacadeFixture({
      mode: "host-once",
      readyFile: join(stateDir, "ready.json"),
      scratchDir: scratchParent,
    })
    try {
      const ready = await readFixtureReady<{ pid: number }>(join(stateDir, "ready.json"))
      fixture.child.kill("SIGTERM")
      const result = await within(fixture.exited, 10000)
      if (result.code !== 23) throw new Error(fixture.stderr())
      expect(result).toEqual({ code: 23, signal: null })
      await waitFor(() => !processIsAlive(ready.pid))
      expect(readdirSync(scratchParent)).toEqual([])
    } finally {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
      await fixture.exited.catch(() => {})
      fakeBin.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 20000)

  // A host listener that survives our handler keeps ownership on every signal;
  // a `once` listener only owns the signal it consumes, after which the facade
  // takes over. Either way the host's exit code — not ours — is the outcome
  // while it still owns the signal.
  const hostOwnershipCases = [
    { mode: "host-once-continues", label: "a pre-existing once listener owns only the signal it consumes", code: 143 },
    { mode: "host-later-persistent", label: "a later prepended persistent listener keeps ownership", code: 29 },
  ] as const
  for (const { mode, label, code } of hostOwnershipCases) {
    test(
      label,
      async () => {
        const stateDir = mkdtempSync(join(tmpdir(), `agent-sdk-facade-${mode}-`))
        const scratchParent = join(stateDir, "scratch")
        const readyFile = join(stateDir, "ready.json")
        const fakeBin = withFakeCognitioBin()
        requireDirectory(scratchParent)
        const fixture = startFacadeFixture({ mode, readyFile, scratchDir: scratchParent })
        try {
          const ready = await readFixtureReady<{ pid: number }>(readyFile)
          fixture.child.kill("SIGTERM")
          await waitFor(() => existsSync(`${readyFile}.host`))
          const earlyExit = await Promise.race([fixture.exited.then(() => true), Bun.sleep(150).then(() => false)])
          expect(earlyExit).toBe(false)

          fixture.child.kill("SIGTERM")
          const result = await within(fixture.exited, 10000)
          if (result.code !== code) throw new Error(fixture.stderr())
          expect(result).toEqual({ code, signal: null })
          await waitFor(() => !processIsAlive(ready.pid))
          expect(readdirSync(scratchParent)).toEqual([])
        } finally {
          if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
          await fixture.exited.catch(() => {})
          fakeBin.cleanup()
          rmSync(stateDir, { recursive: true, force: true })
        }
      },
      20000,
    )
  }

  test("a removed host signal listener relinquishes ownership", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-sdk-facade-host-removed-"))
    const scratchParent = join(stateDir, "scratch")
    const fakeBin = withFakeCognitioBin()
    requireDirectory(scratchParent)
    const fixture = startFacadeFixture({
      mode: "host-removed",
      readyFile: join(stateDir, "ready.json"),
      scratchDir: scratchParent,
    })
    try {
      const ready = await readFixtureReady<{ pid: number }>(join(stateDir, "ready.json"))
      fixture.child.kill("SIGTERM")
      const result = await within(fixture.exited, 10000)
      if (result.code !== 143) throw new Error(fixture.stderr())
      expect(result).toEqual({ code: 143, signal: null })
      await waitFor(() => !processIsAlive(ready.pid))
      expect(readdirSync(scratchParent)).toEqual([])
    } finally {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
      await fixture.exited.catch(() => {})
      fakeBin.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 20000)

  test("dedicated Agent.close restores facade lifecycle listener baselines", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-sdk-facade-listeners-"))
    const scratchParent = join(stateDir, "scratch")
    const fakeBin = withFakeCognitioBin()
    requireDirectory(scratchParent)
    const fixture = startFacadeFixture({
      mode: "listener-close",
      readyFile: join(stateDir, "ready.json"),
      scratchDir: scratchParent,
    })
    try {
      const ready = await readFixtureReady<{
        pid: number
        baseline: Record<string, number>
        active: Record<string, number>
        after: Record<string, number>
      }>(join(stateDir, "ready.json"))
      const result = await within(fixture.exited, 10000)
      if (result.code !== 0) throw new Error(fixture.stderr())
      // Facade and child cleanup listeners coordinate using a shared marker.
      // Both layers deregister after close without listener instrumentation.
      expect(ready.active).toEqual({
        beforeExit: ready.baseline.beforeExit + 1,
        SIGINT: ready.baseline.SIGINT + 2,
        SIGTERM: ready.baseline.SIGTERM + 2,
        newListener: ready.baseline.newListener,
        removeListener: ready.baseline.removeListener,
      })
      expect(ready.after).toEqual(ready.baseline)
      expect(readdirSync(scratchParent)).toEqual([])
      await waitFor(() => !processIsAlive(ready.pid))
    } finally {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
      await fixture.exited.catch(() => {})
      fakeBin.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 20000)
})

describe("cognitio-agent-sdk — hermetic spawn (deterministic fake cognitio binary)", () => {
  test.skipIf(process.platform === "win32")(
    "isolated env composition, neutral defaults, and scratch lifecycle",
    async () => {
      const rawTmpDir = mkdtempSync(join(tmpdir(), "agent-sdk-iso-spawn-"))
      const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-scratch-parent-"))
      const fakeBin = withFakeCognitioBin()
      const tmpDir = realpathSync(rawTmpDir)
      const port = await reserveLocalPort()
      process.env.SECRET_X = "hunter2"
      process.env.COGNITIO_MARKER = "host-marker"

      try {
        const client = await createAgentClient({
          directory: tmpDir,
          spawn: {
            port,
            hostname: "127.0.0.1",
            timeout: 15000,
            isolated: true,
            scratchDir: scratchParent,
            passEnv: ["SECRET_X"],
            env: { COGNITIO_DB: ":memory:" },
            auth: { anthropic: { type: "api", key: "sk-test" } },
          },
        })
        try {
          const children = readdirSync(scratchParent)
          expect(children).toHaveLength(1)
          expect(children[0]!.startsWith("agent-sdk-")).toBe(true)
          const scratch = join(scratchParent, children[0]!)

          const env = (await (await fetch(`${client.baseUrl}/debug/env`)).json()) as Record<string, string>
          expect(env.COGNITIO_ISOLATED).toBe("1")
          expect(env.HOME).toBe(join(scratch, "home"))
          expect(env.XDG_DATA_HOME).toBe(join(scratch, "xdg", "data"))
          expect(env.TMPDIR).toBe(join(scratch, "tmp"))
          expect(JSON.parse(env.COGNITIO_AUTH_CONTENT!)).toEqual({ anthropic: { type: "api", key: "sk-test" } })
          expect(env.SECRET_X).toBe("hunter2")
          expect(env.COGNITIO_MARKER).toBeUndefined()
          expect(env.COGNITIO_DB).toBe(":memory:")
          expect(env.PATH).toBeTruthy()

          const lowLevel = createCognitioClient({ baseUrl: client.baseUrl, directory: tmpDir })

          // neutral default + isolated settingSources composed on create
          const session = await client.sessions.create({ cwd: tmpDir })
          const stored = await lowLevel.session.runtimeConfig.get({ sessionID: session.id, directory: tmpDir })
          expect(stored.data!.runtimeConfig.systemPrompt).toBe(NEUTRAL_BASE_PROMPT)
          expect(stored.data!.runtimeConfig.settingSources).toEqual([])
          const applied = await session.getAppliedSettings()
          expect(applied.systemPrompt?.mode).toBe("neutral")
          expect(applied.settingSources).toEqual([])

          // explicit values (including an explicit empty prompt) are preserved
          const explicit = await client.sessions.create({
            cwd: tmpDir,
            runtimeConfig: { instructions: "", settingSources: ["project"] },
          })
          const storedExplicit = await lowLevel.session.runtimeConfig.get({
            sessionID: explicit.id,
            directory: tmpDir,
          })
          expect(storedExplicit.data!.runtimeConfig.systemPrompt).toBe("")
          expect(storedExplicit.data!.runtimeConfig.settingSources).toEqual(["project"])

          await client.close()
          // owned scratch removed, caller-provided parent dir untouched
          expect(readdirSync(scratchParent)).toEqual([])
          await client.close()
        } finally {
          await client.close().catch(() => {})
        }
      } finally {
        delete process.env.SECRET_X
        delete process.env.COGNITIO_MARKER
        fakeBin.cleanup()
        rmSync(rawTmpDir, { recursive: true, force: true })
        rmSync(scratchParent, { recursive: true, force: true })
      }
    },
    30000,
  )

  test("terminationUnconfirmed detects the startup unkillable-child signal (scratch-preservation gate)", () => {
    const cte = new ChildTerminationError(1234)
    // startup failure where the child could not be confirmed dead: the server
    // wraps the startup reason + ChildTerminationError → transport preserves scratch
    expect(terminationUnconfirmed(new AggregateError([new Error("startup failed"), cte]))).toBe(true)
    expect(terminationUnconfirmed(cte)).toBe(true)
    // ordinary startup failures (reaped child / ENOENT / timeout) → scratch removed
    expect(terminationUnconfirmed(new Error("Timeout waiting for server to start"))).toBe(false)
    expect(terminationUnconfirmed(new AggregateError([new Error("a"), new Error("b")]))).toBe(false)
    expect(terminationUnconfirmed(undefined)).toBe(false)
  })

  test("an already-aborted signal never spawns a process", async () => {
    const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-scratch-parent-"))
    const controller = new AbortController()
    controller.abort(new Error("pre-aborted"))
    try {
      await expect(
        createAgentClient({ spawn: { isolated: true, scratchDir: scratchParent, signal: controller.signal } }),
      ).rejects.toThrow("pre-aborted")
      // nothing spawned, nothing created on disk
      expect(readdirSync(scratchParent)).toEqual([])
    } finally {
      rmSync(scratchParent, { recursive: true, force: true })
    }
  })

  test("spawn option validation fails fast without leaking processes or scratch", async () => {
    const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-scratch-parent-"))
    try {
      await expect(createAgentClient({ spawn: { isolated: false, passEnv: ["SECRET_X"] } })).rejects.toThrow(
        "spawn.passEnv requires spawn.isolated: true",
      )
      await expect(createAgentClient({ spawn: { isolated: false, keepScratch: true } })).rejects.toThrow(
        "spawn.keepScratch requires spawn.isolated: true",
      )
      await expect(
        createAgentClient({ spawn: { isolated: true, scratchDir: scratchParent, env: { HOME: "/x" } } }),
      ).rejects.toThrow("spawn.env must not override reserved key HOME")
      await expect(
        createAgentClient({ spawn: { isolated: true, scratchDir: scratchParent, passEnv: ["COGNITIO_CONFIG"] } }),
      ).rejects.toThrow("spawn.passEnv must not include COGNITIO_CONFIG")
      await expect(createAgentClient({ spawn: { env: { COGNITIO_AUTH_CONTENT: "{}" } } })).rejects.toThrow(
        "spawn.env must not override reserved key COGNITIO_AUTH_CONTENT",
      )
      // nothing was spawned, nothing was created on disk
      expect(readdirSync(scratchParent)).toEqual([])
    } finally {
      rmSync(scratchParent, { recursive: true, force: true })
    }
  })

  test("startup failure removes the owned scratch after the child settled", async () => {
    const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-scratch-parent-"))
    const emptyBinDir = mkdtempSync(join(tmpdir(), "agent-sdk-empty-bin-"))
    const previousPath = process.env.PATH
    process.env.PATH = emptyBinDir
    try {
      await expect(
        createAgentClient({ spawn: { isolated: true, scratchDir: scratchParent, timeout: 5000 } }),
      ).rejects.toThrow()
      expect(readdirSync(scratchParent)).toEqual([])
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      rmSync(scratchParent, { recursive: true, force: true })
      rmSync(emptyBinDir, { recursive: true, force: true })
    }
  }, 15000)

  test.skipIf(process.platform === "win32")(
    "keepScratch preserves the owned scratch dir across close",
    async () => {
      const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-scratch-parent-"))
      const fakeBin = withFakeCognitioBin()
      const port = await reserveLocalPort()
      try {
        const client = await createAgentClient({
          spawn: {
            port,
            hostname: "127.0.0.1",
            timeout: 15000,
            isolated: true,
            scratchDir: scratchParent,
            keepScratch: true,
          },
        })
        await client.close()
        expect(readdirSync(scratchParent)).toHaveLength(1)
      } finally {
        fakeBin.cleanup()
        rmSync(scratchParent, { recursive: true, force: true })
      }
    },
    30000,
  )

  test.skipIf(process.platform === "win32")(
    "abort after startup runs the full cleanup including scratch",
    async () => {
      const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-scratch-parent-"))
      const fakeBin = withFakeCognitioBin()
      const port = await reserveLocalPort()
      const controller = new AbortController()
      try {
        const client = await createAgentClient({
          spawn: {
            port,
            hostname: "127.0.0.1",
            timeout: 15000,
            isolated: true,
            scratchDir: scratchParent,
            signal: controller.signal,
          },
        })
        expect(readdirSync(scratchParent)).toHaveLength(1)
        controller.abort(new Error("stop"))
        await waitFor(() => readdirSync(scratchParent).length === 0)
        await client.close()
      } finally {
        fakeBin.cleanup()
        rmSync(scratchParent, { recursive: true, force: true })
      }
    },
    30000,
  )

  test.skipIf(process.platform === "win32")(
    "transport cleanup runs even when a session close fails",
    async () => {
      const rawTmpDir = mkdtempSync(join(tmpdir(), "agent-sdk-iso-spawn-"))
      const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-scratch-parent-"))
      const fakeBin = withFakeCognitioBin()
      const tmpDir = realpathSync(rawTmpDir)
      const port = await reserveLocalPort()
      try {
        const client = await createAgentClient({
          directory: tmpDir,
          spawn: { port, hostname: "127.0.0.1", timeout: 15000, isolated: true, scratchDir: scratchParent },
        })
        const session = await client.sessions.create({ cwd: tmpDir })
        ;(session as unknown as { close: () => Promise<void> }).close = () => Promise.reject(new Error("session boom"))
        await expect(client.close()).rejects.toThrow("session boom")
        expect(readdirSync(scratchParent)).toEqual([])
      } finally {
        fakeBin.cleanup()
        rmSync(rawTmpDir, { recursive: true, force: true })
        rmSync(scratchParent, { recursive: true, force: true })
      }
    },
    30000,
  )
})

describe.skipIf(!realCognitioAvailable)("cognitio-agent-sdk — spawn smoke (real cognitio server)", () => {
  test("spawns server, creates a session bound to the requested cwd, sends three turns, lists it, closes", async () => {
    const rawTmpDir = mkdtempSync(join(tmpdir(), "agent-sdk-spawn-"))
    const tmpDir = realpathSync(rawTmpDir)
    const port = await reserveLocalPort()

    try {
      const client = await createAgentClient({
        directory: tmpDir,
        spawn: { port, hostname: "127.0.0.1", timeout: 15000 },
        control: { readyTimeoutMs: 15000 },
      })

      try {
        expect(client.transportKind).toBe("spawn")
        expect(client.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)

        const session = await client.sessions.create({ cwd: tmpDir })
        expect(session.id).toBeTruthy()
        expect(session.directory).toBe(tmpDir)

        for (const prompt of [
          "Reply with one short word.",
          "Reply with another short word.",
          "Reply with a final short word.",
        ]) {
          const result = await session.send(prompt)
          expect(result.subtype).toBe("success")
          expect(result.messageId).toBeTruthy()
          expect(result.turns).toBeGreaterThan(0)
          expect(result.sessionId).toBe(session.id)
        }

        const listed = await client.sessions.list()
        const found = listed.find((item) => item.id === session.id)
        expect(found).toBeDefined()
        expect(found?.directory).toBe(tmpDir)
      } finally {
        await client.close()
      }
    } finally {
      rmSync(rawTmpDir, { recursive: true, force: true })
    }
  }, 30000)
})

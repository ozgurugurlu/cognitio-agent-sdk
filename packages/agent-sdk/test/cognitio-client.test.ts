import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import {
  ChildTerminationError,
  createCognitioServer,
  EXPECTED_SERVER_VERSION,
  type SpawnServerRequest,
} from "../src/internal/runtime-client/index.js"
import { createFakeChild, startHealthServer } from "./fake-child.js"

/**
 * The vendored server spawner.
 *
 * Two jobs here. The first is the new surface: `spawnProcess`, binary
 * resolution, and the post-readiness compatibility gate. The second is a
 * regression list for behavior that was *copied* rather than written — a
 * verbatim copy still deserves assertions, because the next person to touch
 * this file will not know which lines were load-bearing.
 */

/** Runs `createCognitioServer` against a driveable fake child. */
function withFake(
  drive: (fake: ReturnType<typeof createFakeChild>) => void,
  options?: Parameters<typeof createCognitioServer>[0] & { pid?: number; kill?: (signal?: string) => boolean },
) {
  const requests: SpawnServerRequest[] = []
  const fake = createFakeChild({
    ...(options?.pid === undefined ? {} : { pid: options.pid }),
    ...(options?.kill === undefined ? {} : { kill: options.kill }),
  })
  const promise = createCognitioServer({
    ...options,
    spawnProcess(request) {
      requests.push(request)
      queueMicrotask(() => drive(fake))
      return fake.child
    },
  })
  return { promise, requests, fake }
}

describe("vendored createCognitioServer — spawnProcess", () => {
  test("receives the resolved command, args, env, and signal exactly once", async () => {
    const controller = new AbortController()
    const { promise, requests } = withFake((fake) => fake.ready("http://127.0.0.1:5555"), {
      hostname: "127.0.0.1",
      port: 5555,
      env: { SDK_TEST_MARKER: "yes" },
      inheritEnv: false,
      signal: controller.signal,
      config: { logLevel: "DEBUG" },
    })
    const server = await promise
    try {
      expect(requests).toHaveLength(1)
      const request = requests[0]!
      expect(request.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=5555", "--log-level=DEBUG"])
      expect(request.command).toBe("cognitio")
      expect(request.signal).toBe(controller.signal)
      expect(request.env.SDK_TEST_MARKER).toBe("yes")
      expect(request.env.COGNITIO_CONFIG_CONTENT).toBe(JSON.stringify({ logLevel: "DEBUG" }))
      // inheritEnv: false — the parent's environment must not be present.
      expect(Object.keys(request.env).sort()).toEqual(["COGNITIO_CONFIG_CONTENT", "SDK_TEST_MARKER"])
      expect(server.url).toBe("http://127.0.0.1:5555")
    } finally {
      await server.close()
    }
  })

  test("the low-level hostname, port, and timeout defaults reach the child without binding a port", async () => {
    // The defaults are the thing under test, so they are read off the
    // constructed argv rather than by letting the child bind the real 4096.
    const delays: number[] = []
    const original = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
      delays.push(delay ?? 0)
      return original(handler as () => void, delay, ...(rest as []))
    }) as unknown as typeof globalThis.setTimeout
    try {
      const { promise, requests } = withFake((fake) => fake.ready("http://127.0.0.1:4096"))
      const server = await promise
      try {
        expect(requests[0]!.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=4096"])
        expect(delays).toContain(5000)
      } finally {
        await server.close()
      }
    } finally {
      globalThis.setTimeout = original
    }
  })

  test("port 0 survives nullish default resolution", async () => {
    const { promise, requests } = withFake((fake) => fake.ready("http://127.0.0.1:41000"), { port: 0 })
    const server = await promise
    try {
      expect(requests[0]!.args).toContain("--port=0")
    } finally {
      await server.close()
    }
  })

  test("a readiness line fragmented across chunks still matches", async () => {
    const { promise } = withFake((fake) => {
      fake.stdout("noise before readiness\nagent server list")
      fake.stdout("ening at http://127.0.0.1:5001\n")
    })
    const server = await promise
    try {
      expect(server.url).toBe("http://127.0.0.1:5001")
    } finally {
      await server.close()
    }
  })

  test("streams and the child are unreffed only after readiness, and only with autoCleanup", async () => {
    const plain = withFake((fake) => fake.ready("http://127.0.0.1:5002"))
    const server = await plain.promise
    await server.close()
    expect(plain.fake.unrefCount).toBe(0)

    const tracked = withFake((fake) => fake.ready("http://127.0.0.1:5003"), { autoCleanup: true })
    const trackedServer = await tracked.promise
    try {
      expect(tracked.fake.unrefCount).toBe(1)
    } finally {
      await trackedServer.close()
    }
  })

  test("close() is memoized and returns the identical promise", async () => {
    const { promise } = withFake((fake) => fake.ready("http://127.0.0.1:5004"))
    const server = await promise
    const first = server.close()
    expect(server.close()).toBe(first)
    await first
  })

  test("an abort before readiness rejects with the signal reason and settles the child", async () => {
    const controller = new AbortController()
    const { promise, fake } = withFake(() => controller.abort(new Error("aborted by test")), {
      signal: controller.signal,
    })
    await expect(promise).rejects.toThrow("aborted by test")
    expect(fake.signals.length).toBeGreaterThan(0)
  })

  test("a startup failure rejects only after the child exited", async () => {
    let exited = false
    const { promise, fake } = withFake((f) => {
      f.child.once("exit", () => {
        exited = true
      })
      f.stderr("boom\n")
      f.exit(7)
    })
    await expect(promise).rejects.toThrow(/exited with code 7[\s\S]*boom/)
    expect(exited).toBe(true)
  })

  // POSIX only: it needs a real long-lived process (`sleep`) and signal-0
  // liveness probing, matching the skip precedent in the sibling suites.
  test.skipIf(process.platform === "win32")(
    "a startup failure with unconfirmed termination becomes an AggregateError",
    async () => {
      // A real, live PID with a kill() that reports success but does nothing:
      // stopAndWait escalates, re-probes, finds it alive, and gives up.
      const real = spawn("sleep", ["30"])
      try {
        const { promise } = withFake((fake) => fake.error(new Error("spawn blew up")), {
          pid: real.pid!,
          kill: () => true,
          shutdownTimeout: 50,
        })
        const error = await promise.then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(error).toBeInstanceOf(AggregateError)
        const aggregate = error as AggregateError
        expect(aggregate.errors.some((item) => item instanceof ChildTerminationError)).toBe(true)
        expect(real.exitCode).toBeNull()
      } finally {
        real.kill("SIGKILL")
      }
    },
    15000,
  )

  test("an ENOENT names the platform pair, the candidate, and every escape hatch", async () => {
    const enoent = Object.assign(new Error("spawn cognitio ENOENT"), { code: "ENOENT" })
    const { promise } = withFake((fake) => fake.error(enoent))
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    )
    const message = (error as Error).message
    expect(message).toContain(`${process.platform}-${process.arch}`)
    expect(message).toContain("--omit=optional")
    expect(message).toContain("spawn.binaryPath")
    expect(message).toContain("COGNITIO_BIN_PATH")
    expect(message).toContain("PATH")
    // The command name, never a resolved filesystem path we do not have.
    expect(message).toContain('"cognitio" was not found on PATH')
  })
})

describe("vendored createCognitioServer — compatibility gate", () => {
  // The gate's live behaviour — mismatch rejects after a confirmed shutdown,
  // runs for a PATH-resolved binary, is skipped for an explicit `binaryPath` —
  // is covered end to end in spawn-smoke.test.ts, which owns the PATH shim.
  // What belongs here is the one case that cannot be expressed there: a
  // caller-owned process is never second-guessed.
  test("never runs for a spawnProcess-owned child, even on a wrong version", async () => {
    const health = await startHealthServer("0.0.0-definitely-not-ours")
    try {
      const { promise } = withFake((fake) => fake.ready(health.url))
      const server = await promise
      expect(server.url).toBe(health.url)
      await server.close()
    } finally {
      await health.stop()
    }
  })

  test("EXPECTED_SERVER_VERSION is build metadata, so it is semver-equal to its base", () => {
    expect(EXPECTED_SERVER_VERSION.startsWith("1.14.19+")).toBe(true)
    // A prerelease suffix would sort BELOW 1.14.19, making a plain upstream
    // 1.14.19 look like an available upgrade.
    expect(EXPECTED_SERVER_VERSION).not.toContain("1.14.19-")
  })
})
